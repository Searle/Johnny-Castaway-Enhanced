import { Op } from "./opcodes";
import type { Manifest, Op as RawOp, LoadedSheet } from "../manifest";
import type { Layer, Renderer } from "../render/renderer";

// Optional draw-call trace sink. When set, TtmThread emits canonical trace lines
// (identical format to the Go engine's -trace: "DRAW s=.. img=.. @x,y flip=..",
// "DELAY n", "CLEAR", "PURGE", "GOTO n", "FRAME n", "ENDFRAME") so the two can be
// diffed. Off by default (zero cost); the ?dump harness turns it on.
export let traceSink: ((line: string) => void) | null = null;
export function setTraceSink(fn: ((line: string) => void) | null): void {
  traceSink = fn;
  // Reset both deterministic streams to their seeds when (dis)arming trace.
  rngAds = 0x1234abcd;
  rngTimer = 0x9e3779b9;
}
function trace(line: string): void {
  if (traceSink) traceSink(line);
}

// Two independent deterministic mulberry32 streams mirroring trace.go: one for
// ADS scene selection (randAds), one for the TTM TIMER opcode (randTimer). Kept
// separate so TIMER consumption (which varies with concurrent-scene frame
// interleaving) can't shift the ADS pick and select a different scene. Active
// only while the trace sink is set; normal playback uses Math.random.
let rngAds = 0x1234abcd;
let rngTimer = 0x9e3779b9;
function mulberry32(state: number, n: number): [number, number] {
  state = (state + 0x6d2b79f5) >>> 0;
  let z = state;
  z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
  z = (z ^ (z + (Math.imul(z ^ (z >>> 7), z | 61) >>> 0))) >>> 0;
  z = (z ^ (z >>> 14)) >>> 0;
  return [state, z % n];
}
// randAds/randTimer: deterministic in [0,n) under trace, else Math.random.
export function randAds(n: number): number {
  if (n <= 0) return 0;
  if (!traceSink) return Math.floor(Math.random() * n);
  const [s, v] = mulberry32(rngAds, n);
  rngAds = s;
  return v;
}
export function randTimer(n: number): number {
  if (n <= 0) return 0;
  if (!traceSink) return Math.floor(Math.random() * n);
  const [s, v] = mulberry32(rngTimer, n);
  rngTimer = s;
  return v;
}

// A parsed tag: a jump target the GOTO_TAG / PURGE opcodes reference.
interface Tag {
  id: number;
  index: number; // index into the flattened op array
}

// TtmThread mirrors the Go TTtmThread for a single animation script. The slice
// runs exactly one thread (no ADS scene scheduler), which is enough to loop a
// self-contained TTM like MJJOG.TTM.
//
// Timing model (ttm.go + ads.go main loop):
//   - ttmPlay() executes ops until UPDATE (one displayed frame), and along the
//     way SET_DELAY/TIMER set `delay`.
//   - the ADS loop waits `delay` ticks, then applies any pending GOTO/PURGE
//     jump (nextGoto) before the next frame.
// We reproduce that with a per-frame tick countdown driven by the render loop.
export class TtmThread {
  private readonly ops: RawOp[];
  private readonly tags: Tag[] = [];
  private readonly sheets: Map<string, LoadedSheet>;
  private readonly renderer: Renderer; // shared, for LOAD_SCREEN background
  private layer: Layer; // this thread's own draw surface
  private originDx = 0;
  private originDy = 0;
  private startTagId?: number;

  private ip = 0; // index into ops
  // PURGE sets these, applied at the next UPDATE so the current frame finishes.
  private pendingDone = false;
  private pendingGoto = -1;
  private delayVal = 6; // ticks to wait after the current frame
  private timerVal = 0; // ticks remaining before the next frame runs
  private nextGoto = -1; // pending jump target (op index), or -1
  private done = false;

  // Per-thread engine state set by opcodes.
  private selectedBmpSlot = 0;
  private bmpSlots: (LoadedSheet | null)[] = new Array(6).fill(null);
  // Base (first-loaded) sheet per slot — CLEAR_IMGSLOT restores to this.
  private baseBmpSlots: (LoadedSheet | null)[] = new Array(6).fill(null);
  private readonly palette: string[];
  // SET_COLORS args — palette indices for primitives (lines, rects, circles,
  // pixels). Both start at 0x0f, matching adsAddScene (ads.go: `fgColor = 0x0f;
  // bgColor = 0x0f`) — a scene that draws a primitive BEFORE its first
  // SET_COLORS inherits that, not black. VISITOR:4/6/7 do exactly that (the
  // visitor's net/rigging lines), and defaulting to 0 drew them in colour 0
  // where the engine uses 15.
  private fgColor = 0x0f;
  private bgColor = 0x0f;

  // In the real engine the ADS scheduler enters a TTM at the byte offset of a
  // chosen scene *tag* (ads.go sets ip = ttmFindTag(sceneRootTag)), not at 0.
  // The ops before the first tag are a one-time prologue (LOAD_PALETTE /
  // LOAD_SCREEN). Without an ADS script, the slice runs that prologue once and
  // then loops a single scene: startTag (default = the first tag in the file).
  constructor(
    manifest: Manifest,
    sheets: Map<string, LoadedSheet>,
    renderer: Renderer,
    layer: Layer,
    startTag?: number,
  ) {
    this.ops = manifest.ops;
    this.sheets = sheets;
    this.renderer = renderer;
    this.layer = layer;
    this.palette = manifest.palette ?? [];
    this.startTagId = startTag;
    this.buildTags();

    // Fast-forward from the file start to the chosen scene tag, executing the
    // real op stream so LOAD_IMAGE / SET_BMP_SLOT / SET_COLORS / LOAD_SCREEN run
    // in true script order — but suppressing visible drawing and never waiting
    // on frame timers. This is what makes slot state correct for scenes that
    // reuse a BMP slot for different sheets (e.g. SMDATE.TTM cycles slots 0-5
    // through many SMDATE*.BMP): a flat "pre-scan all loads, last wins" pass got
    // the slots wrong, drawing sprites from the wrong sheet (Johnny mispositioned
    // "on the water"). Replaying in order matches how the real engine arrives at
    // a scene, where every prior load has already executed.
    const target =
      this.tags.length > 0 ? this.findTag(startTag ?? this.tags[0].id) : -1;
    if (target >= 0) this.fastForwardTo(target);

    // Enter the scene fresh: run its first frame on the very next tick.
    // delay MUST be reset to 4 here, matching adsAddScene (ads.go: `delay = 4;
    // timer = 0`). The engine enters a scene by jumping straight to the tag
    // offset, so it never inherits a delay from the prologue — whereas our
    // fastForwardTo replays the op stream and picks up whatever SET_DELAY/TIMER
    // it scanned past. Leaving that stale delay in place made a scene's FIRST
    // frame hold for the wrong number of ticks (STAND.ADS tag 2: 6 and 10 ticks
    // where the engine uses 4 and 4), which shifts every later frame boundary.
    this.delayVal = 4;
    this.timerVal = 0;
    this.nextGoto = -1;
  }

  get isDone(): boolean {
    return this.done;
  }

  // markDone ends the scene from outside the opcode loop — the scheduler calls
  // it when a duration timer drains (ads.go sets isRunning = 2 there).
  markDone(): void {
    this.done = true;
  }

  get tagIds(): number[] {
    return this.tags.map((t) => t.id);
  }

  // --- ADS scheduler interface (ads.go main-loop timing) ---
  // The multi-thread ADS loop drives frames itself: it runs a frame when a
  // thread's `timer` hits 0, then advances all threads' timers by the smallest
  // one. These accessors let AdsScheduler own that timing instead of tick().

  get timer(): number {
    return this.timerVal;
  }
  set timer(v: number) {
    this.timerVal = v;
  }
  get delay(): number {
    return this.delayVal;
  }

  // sceneTag/sceneRootTag identify which ADS scene this thread is playing, for
  // STOP_SCENE / IF_IS_RUNNING checks.
  sceneRootTag = 0;

  // sceneTag starts at sceneRootTag and then FOLLOWS the script: ttm.go sets it
  // on every TAG (0x1111) and LOCAL_TAG (0x1101) opcode, so it names the segment
  // a thread is currently in rather than the scene it was spawned as. The
  // compositing exceptions key on this one (see AdsScheduler.alwaysOnTop), so it
  // has to track the same way or a thread would match the wrong rule.
  sceneTag = 0;

  // sceneTimer is the ADS duration timer (ADD_SCENE arg3 < 0 → -arg3). It is
  // what decides PURGE's meaning in ttm.go:
  //
  //   if sceneTimer != 0 { nextGotoOffset = ttmFindPreviousTag(...) }  // loop
  //   else               { isRunning = 2 }                             // end
  //
  // i.e. a *timed* scene treats PURGE as "segment done, loop back and keep
  // playing" and only ends when the scheduler drains the timer (ads.go:795-800);
  // an untimed scene ends on the first PURGE. The scheduler owns the countdown.
  //
  // (This replaces an earlier static `purgeEnds` boolean, which collapsed the
  // rule into "ADS always ends / browser always loops". That made every timed
  // PURGE-looping scene die on its first PURGE — e.g. MARY.ADS tag 2 stopped
  // after 1 frame where the engine plays 90 lines by looping tag 104 → 17.)
  sceneTimer = 0;

  // Standalone browser mode: no ADS scheduler is driving a timer, so loop on
  // PURGE forever to keep single scenes playing for viewing.
  loopForever = false;

  // setOrigin sets this thread's grDx/grDy (story positioning).
  setOrigin(dx: number, dy: number): void {
    this.originDx = dx;
    this.originDy = dy;
    this.layer.setOrigin(dx, dy);
  }

  // The thread's own drawing surface, created once when the scene is added
  // (grNewLayer) and kept for the scene's whole life — the ADS scheduler needs
  // it to set compositing order without disturbing any layer's pixels.
  get layerRef(): Layer {
    return this.layer;
  }

  // rebindLayer moves this thread's drawing to a different layer. Reapplies
  // origin; the next frame redraws content (TTM frames are self-contained via
  // CLEAR). Not used by the ADS scheduler any more — reordering preserves
  // layers instead — but kept for callers that genuinely re-home a thread.
  rebindLayer(layer: Layer): void {
    this.layer = layer;
    this.layer.setOrigin(this.originDx, this.originDy);
  }

  // restart re-enters the scene at its start tag. `keepTimer` preserves the
  // current hold timer (ads.go's iteration replay sets ip but does NOT reset the
  // timer — the replayed scene waits out its remaining hold before the next
  // frame); the browser's loop restart passes false for an immediate replay.
  restart(keepTimer = false): void {
    this.done = false;
    if (!keepTimer) this.timerVal = 0;
    this.nextGoto = -1;
    this.pendingDone = false;
    this.pendingGoto = -1;
    if (this.startTagId != null) {
      const t = this.findTag(this.startTagId);
      this.ip = t >= 0 ? t : 0;
    } else {
      this.ip = 0;
    }
  }

  // runOneFrame executes opcodes up to the next UPDATE (one displayed frame),
  // applying any pending jump first — the body of the ADS main loop.
  runOneFrame(): void {
    if (this.done) return;
    if (this.nextGoto >= 0) {
      this.ip = this.nextGoto;
      this.nextGoto = -1;
    }
    this.runFrame();
  }

  // When true, execOne runs state-changing opcodes (loads, slot/color/clip
  // selection, control flow) but skips anything visible or timing-related. Used
  // by fastForwardTo to reach a scene with correct engine state.
  private suppressDraw = false;

  // fastForwardTo runs the op stream from ip=0 up to (not including) targetIp,
  // executing loads/state in true order while suppressing drawing and timing.
  // Control-flow opcodes (GOTO/PURGE/UPDATE) are stepped over linearly — we want
  // a straight scan of everything the file does before the target scene, not to
  // follow jumps (which would loop forever).
  private fastForwardTo(targetIp: number): void {
    this.suppressDraw = true;
    this.ip = 0;
    while (this.ip < targetIp && this.ip < this.ops.length) {
      this.execOne();
    }
    this.suppressDraw = false;
    this.ip = targetIp;
    this.nextGoto = -1;
  }

  // buildTags mirrors ttmLoadTTM's tag scan: TAG/LOCAL_TAG opcodes record a
  // jump target at the op *following* the tag.
  private buildTags(): void {
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i].op;
      if (op === Op.TAG || op === Op.LOCAL_TAG) {
        const id = this.ops[i].args?.[0] ?? 0;
        this.tags.push({ id, index: i + 1 });
      }
    }
  }

  private findTag(id: number): number {
    for (const t of this.tags) if (t.id === id) return t.index;
    console.warn(`TTM tag ${id} not found`);
    return -1;
  }

  // findPreviousTag returns the target of the last tag before op index `before`
  // (ttmFindPreviousTag), used by PURGE to loop the current scene.
  private findPreviousTag(before: number): number {
    let result = -1;
    for (const t of this.tags) {
      if (t.index < before) result = t.index;
      else break;
    }
    return result;
  }

  // tick advances the clock by one unit. When the frame timer elapses it applies
  // any pending jump and runs the next frame. Returns true if the visible frame
  // changed (so the caller can present()).
  tick(): boolean {
    if (this.done) return false;
    if (this.timerVal > 0) {
      this.timerVal--;
      if (this.timerVal > 0) return false;
    }
    // timer reached 0: apply pending jump (ads.go main-loop jump processing).
    if (this.nextGoto >= 0) {
      this.ip = this.nextGoto;
      this.nextGoto = -1;
    }
    this.runFrame();
    this.timerVal = this.delayVal;
    return true;
  }

  // runFrame executes opcodes until UPDATE (ttmPlay's loop body). A PURGE seen
  // during the frame sets pendingDone/pendingGoto, applied here once the frame
  // completes — so opcodes after the PURGE (up to UPDATE) still run.
  private runFrame(): void {
    if (!this.suppressDraw) trace(`FRAME ${TtmThread.traceFrameNo++}`);
    for (;;) {
      if (this.ip >= this.ops.length) {
        this.done = true;
        return;
      }
      if (this.execOne()) {
        // Frame complete (UPDATE). Apply any pending PURGE result.
        if (!this.suppressDraw) {
          trace("  ENDFRAME");
          // traceFrameEnd (trace.go): the budget is checked HERE, at the frame
          // that was just completed, and stops the run immediately.
          if (TtmThread.traceMaxFrame > 0 && TtmThread.traceFrameNo >= TtmThread.traceMaxFrame) {
            TtmThread.traceReachedBudget = true;
          }
        }
        if (this.pendingDone) {
          this.done = true;
          this.pendingDone = false;
        } else if (this.pendingGoto >= 0) {
          this.nextGoto = this.pendingGoto;
          this.pendingGoto = -1;
        }
        return;
      }
    }
  }

  // Global displayed-frame counter for the trace (matches the Go -trace numbering
  // across all scenes in a run). Reset by the harness between runs.
  static traceFrameNo = 0;

  // Frame budget, mirroring the Go engine's traceMaxFrame / traceReachedBudget
  // (trace.go). The Go trace stops the instant the Nth ENDFRAME is written and
  // adsPlay returns — so the oracle's trace is exactly N frames. The TS harness
  // used to count "ticks that changed the display" instead, which is NOT the
  // same thing: one scheduler tick can run TWO threads (two frames), and after
  // the mini-clock port a tick can also report a change for a reap alone. That
  // let the TS trace overshoot by a frame (FISHING/JOHNNY/SUZY: 16 frames vs
  // Go's 15) and every such scene failed on length alone while its decision
  // sequence and draw calls were correct. Count frames here, where they are
  // actually emitted, exactly as traceFrameEnd does.
  static traceMaxFrame = 0;
  static traceReachedBudget = false;

  // execOne executes a single opcode, advancing ip. Returns true if it was
  // UPDATE (end of frame). Shared by runFrame and the prologue.
  private execOne(): boolean {
    if (this.ip >= this.ops.length) {
      this.done = true;
      return true;
    }
    {
      const raw = this.ops[this.ip++];
      const a = raw.args ?? [];
      switch (raw.op) {
        case Op.UPDATE:
          return true;

        case Op.SET_DELAY: {
          const v = a[0] > 4 ? a[0] : 4;
          this.delayVal = v;
          this.timerVal = v;
          if (!this.suppressDraw) trace(`  DELAY ${v}`);
          break;
        }
        case Op.TIMER: {
          // (min,max) range → uniform random delay, matching the Go 0x2022.
          // Skip during fast-forward: Go enters a scene by jumping straight to
          // the tag offset (ttmFindTag), so it never executes — nor draws a
          // random for — TIMER opcodes before the entry tag. Consuming randTimer
          // here would desync the TIMER RNG stream vs the oracle.
          if (this.suppressDraw) break;
          const lo = a[0],
            hi = a[1];
          this.delayVal = hi > lo ? lo + randTimer(hi - lo + 1) : lo;
          this.timerVal = this.delayVal;
          trace(`  DELAY ${this.delayVal}`);
          break;
        }

        case Op.SET_BMP_SLOT:
          if (!this.suppressDraw) trace(`  BMPSLOT ${a[0]}`);
          this.selectedBmpSlot = a[0];
          break;

        case Op.LOAD_SCREEN: {
          if (!this.suppressDraw) trace(`  LOADSCREEN ${raw.str ?? ""}`);
          const sheet = this.sheets.get((raw.str ?? "").toUpperCase());
          this.renderer.setBackground(sheet?.frames[0] ?? null);
          // A new backdrop INVALIDATES baked scenery: grLoadScreen releases
          // grSavedZonesLayer before installing the new screen. Without this the
          // port kept compositing a zone baked against the OLD backdrop for the
          // rest of the run — JOHNNY:1/6 and SUZY:1/2 carried MEANWHIL.TTM's
          // baked clock (and the black rect behind it) into the following
          // scene, ~19k stale pixels the engine had already dropped.
          //
          // Not during fast-forward: that replays the prologue to reach an entry
          // tag, whereas the engine jumps straight to the tag offset and never
          // re-runs those LOAD_SCREENs, so clearing there would drop zones the
          // engine still has.
          if (!this.suppressDraw) this.renderer.clearSavedZones();
          break;
        }
        case Op.LOAD_IMAGE: {
          if (!this.suppressDraw) trace(`  LOADIMAGE slot=${this.selectedBmpSlot} ${raw.str ?? ""}`);
          const sheet = this.sheets.get((raw.str ?? "").toUpperCase()) ?? null;
          this.bmpSlots[this.selectedBmpSlot] = sheet;
          // Record the first sheet loaded into a slot as its base (for
          // CLEAR_IMGSLOT restore), matching grLoadBmp's baseBmpNames.
          if (this.baseBmpSlots[this.selectedBmpSlot] == null) {
            this.baseBmpSlots[this.selectedBmpSlot] = sheet;
          }
          break;
        }

        case Op.CLEAR_SCREEN:
          if (!this.suppressDraw) {
            trace("  CLEAR");
            this.layer.clear();
          }
          break;

        case Op.DRAW_SPRITE:
        case Op.DRAW_SPRITE_FLIP: {
          if (this.suppressDraw) break;
          // args: x, y, spriteNo, imageNo
          const [x, y, spriteNo, imageNo] = a;
          const flip = raw.op === Op.DRAW_SPRITE_FLIP;
          trace(`  DRAW s=${spriteNo} img=${imageNo} @${s16(x)},${s16(y)} flip=${flip ? 1 : 0}`);
          const sheet = this.bmpSlots[imageNo];
          const frame = sheet?.frames[spriteNo];
          if (frame) {
            this.layer.drawSprite(frame, s16(x), s16(y), flip);
          }
          break;
        }

        case Op.SET_COLORS:
          if (!this.suppressDraw) trace(`  COLORS fg=${a[0]} bg=${a[1]}`);
          this.fgColor = a[0];
          this.bgColor = a[1];
          break;

        case Op.DRAW_LINE:
          if (!this.suppressDraw) trace(`  LINE ${s16(a[0])},${s16(a[1])}-${s16(a[2])},${s16(a[3])} c=${this.fgColor}`);
          if (!this.suppressDraw)
            this.layer.drawLine(s16(a[0]), s16(a[1]), s16(a[2]), s16(a[3]), this.color(this.fgColor));
          break;
        case Op.DRAW_RECT:
          // args: x, y, w, h (w/h are unsigned sizes)
          if (!this.suppressDraw) trace(`  RECT ${s16(a[0])},${s16(a[1])} ${a[2]}x${a[3]} c=${this.fgColor}`);
          if (!this.suppressDraw)
            this.layer.drawRect(s16(a[0]), s16(a[1]), a[2], a[3], this.color(this.fgColor));
          break;
        case Op.DRAW_CIRCLE: {
          if (this.suppressDraw) break;
          trace(`  CIRCLE ${s16(a[0])},${s16(a[1])} ${a[2]}x${a[3]} fg=${this.fgColor} bg=${this.bgColor}`);
          // args: x, y, w, h — filled with bgColor, outlined with fgColor.
          const fg = this.color(this.fgColor);
          const bg = this.color(this.bgColor);
          this.layer.drawCircle(s16(a[0]), s16(a[1]), a[2], a[3], bg, fg === bg ? null : fg);
          break;
        }
        case Op.DRAW_PIXEL:
          if (!this.suppressDraw) trace(`  PIXEL @${s16(a[0])},${s16(a[1])} c=${this.fgColor}`);
          if (!this.suppressDraw) this.layer.drawPixel(s16(a[0]), s16(a[1]), this.color(this.fgColor));
          break;

        case Op.SET_CLIP_ZONE: {
          // args: x1, y1, x2, y2 (top-left, bottom-right corners). The
          // full-screen reset convention (0,0,>=639,>=479) clears the clip
          // (grSetClipZone). Otherwise scissor to that rect.
          const x1 = s16(a[0]),
            y1 = s16(a[1]),
            x2 = s16(a[2]),
            y2 = s16(a[3]);
          if (!this.suppressDraw) trace(`  CLIPZONE ${x1},${y1}-${x2},${y2}`);
          if (x1 <= 0 && y1 <= 0 && x2 >= 639 && y2 >= 479) {
            this.layer.clearClip();
          } else {
            this.layer.setClip(x1, y1, x2 - x1 + 1, y2 - y1 + 1);
          }
          break;
        }

        case Op.COPY_ZONE_TO_BG:
          // args: x, y, w, h — bake this rect of the current scene into the
          // persistent saved-zones layer so it stays after the scene ends
          // (grCopyZoneToBg). Skipped during fast-forward (no rendered pixels).
          if (!this.suppressDraw) {
            trace(`  COPYZONE ${s16(a[0])},${s16(a[1])} ${a[2]}x${a[3]}`);
            this.renderer.bakeZone(this.layer, s16(a[0]), s16(a[1]), a[2], a[3]);
          }
          break;

        case Op.CLEAR_IMGSLOT:
          if (!this.suppressDraw) trace(`  CLEARIMGSLOT slot=${this.selectedBmpSlot}`);
          // Restore the selected BMP slot to its base (first-loaded) sheet if a
          // different one is loaded now (grRestoreBmpSlot). Lets a scene that
          // temporarily swapped a slot's image get the original back.
          this.restoreBmpSlot(this.selectedBmpSlot);
          break;

        case Op.RESTORE_ZONE:
          // Clears the whole saved-zones layer (grRestoreZone →
          // grReleaseSavedLayer). Only GJGULIVR.TTM uses it.
          if (!this.suppressDraw) this.renderer.clearSavedZones();
          break;

        case Op.GOTO_TAG:
          // Skip control flow during fast-forward: it only replays loads/state
          // up to the entry tag, and must not follow jumps or (below) end the
          // scene on a PURGE belonging to an EARLIER tag it scanned past. That
          // bug made a scene entered at a later tag (e.g. MJFISH tag 18, forwarded
          // past tag 1's PURGE) complete after one frame.
          if (this.suppressDraw) break;
          trace(`  GOTO ${a[0]}`);
          this.nextGoto = this.findTag(a[0]);
          break;

        case Op.PURGE:
          if (this.suppressDraw) break; // see GOTO_TAG: no control flow while forwarding
          trace("  PURGE");
          // PURGE marks the end of a scene segment. Crucially it does NOT stop
          // execution mid-frame — in ttm.go it only sets isRunning=2 / a goto,
          // and ttmPlay keeps running to the next UPDATE, so any DRAW after the
          // PURGE (e.g. MJFIRE tag 142's trailing smoke puff) still renders. We
          // mark the intent and let runFrame finish the current frame first;
          // dropping the rest of the frame here caused a visible blink and a
          // lost final pose at scene changes. Two contexts:
          //  - sceneTimer != 0 (a timed ADS scene) or standalone browser: loop
          //    back to the scene's previous tag and keep playing. The scheduler
          //    ends it when the duration timer drains (ads.go:795-800).
          //  - sceneTimer == 0: end the scene after this frame so the script
          //    chains to the next via triggered chunks. (Without ending, a
          //    PURGE-terminated tag like MJFISH 18 would loop forever.)
          if (this.sceneTimer !== 0 || this.loopForever) {
            this.pendingGoto = this.findPreviousTag(this.ip);
            if (this.pendingGoto < 0) this.pendingDone = true;
          } else {
            this.pendingDone = true;
          }
          break;

        case Op.TAG:
        case Op.LOCAL_TAG:
          // Not a no-op: ttm.go records the tag a thread is currently inside.
          // Only the compositing exceptions read it (see sceneTag's comment);
          // control flow uses the pre-scanned tag table, not this.
          this.sceneTag = a[0] ?? 0;
          break;

        // Still no-op: SET_PALETTE_SLOT, SET_FRAME1, DRAW_SCREEN, PLAY_SAMPLE,
        // LOAD_PALETTE, and SAVE_IMAGE1/SAVE_ZONE (both genuine no-ops in the
        // original C too — see graphics.go grSaveImage1/grSaveZone).
        default:
          break;
      }
    }
    return false; // non-UPDATE opcode: frame continues
  }

  // restoreBmpSlot resets a slot to its base sheet if a different one is loaded
  // now (grRestoreBmpSlot: only acts when slot != base).
  private restoreBmpSlot(slot: number): void {
    const base = this.baseBmpSlots[slot];
    if (base != null && this.bmpSlots[slot] !== base) {
      this.bmpSlots[slot] = base;
    }
  }

  // color resolves a TTM palette index (masked to 0..15) to a CSS color.
  private color(idx: number): string {
    return this.palette[idx & 0x0f] ?? "#000000";
  }
}

// s16 reinterprets a manifest uint16 as a signed 16-bit int (sprite coords can
// be negative), matching the Go int16(args[n]) casts.
function s16(v: number): number {
  return v >= 0x8000 ? v - 0x10000 : v;
}
