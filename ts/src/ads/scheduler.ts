import { AdsOp, ADS_OPCODES } from "./opcodes";
import { TtmThread, traceSink, randAds } from "../ttm/interpreter";
import { loadAdsFile, loadAnimation, type AdsFile, type Op, type Manifest, type LoadedSheet } from "../manifest";
import type { Renderer } from "../render/renderer";

// A loaded TTM the ADS can spawn scenes from, keyed by its ADS slot id.
export interface TtmSlot {
  manifest: Manifest;
  sheets: Map<string, LoadedSheet>;
}

// A running scene: one TtmThread on its own layer, tagged with the ADS
// (slot, rootTag) that spawned it so STOP_SCENE / IF_IS_RUNNING can find it.
interface SceneThread {
  slot: number;
  rootTag: number;
  thread: TtmThread;
  iterations: number; // remaining replays (ADD_SCENE arg3 > 0), 0 = once
  finished: boolean; // ran its last frame; awaiting hold-timer to be reaped
}

// Go runs up to MaxTTMThreads concurrent scene threads in a FIXED array, always
// iterated slot 0→N, with adsAddScene reusing the lowest free slot. Matching
// that slot allocation + iteration order is required for the frame-emission and
// compositing order to agree with the engine (e.g. WALKSTUF's boat vs Johnny).
const MAX_THREADS = 10;

// A weighted choice inside a RANDOM_START…END block.
interface RandOp {
  type: "add" | "stop" | "nop";
  slot: number;
  tag: number;
  numPlays: number;
  weight: number;
}

// A triggered chunk: an IF_LASTPLAYED / IF_NOT_RUNNING guarded block registered
// during adsLoad, to be replayed when its (slot, tag) scene completes.
interface Chunk {
  slot: number;
  tag: number;
  ip: number; // op index just past the guard
}

// positionFor lets the caller supply per-scene grDx/grDy (story positioning).
export type PositionFn = (slot: number, tag: number) => { dx: number; dy: number };

// Scheduler-decision log for the oracle diff — mirrors the Go engine's schedLog
// (trace.go / JC_SCHED_LOG) line-for-line, so the two DECISION SEQUENCES can be
// diffed directly. Comparing decisions ("which branch, and why") is far more
// diagnostic than diffing draw calls. Off unless a sink is installed.
export let schedSink: ((line: string) => void) | null = null;
export function setSchedSink(fn: ((line: string) => void) | null): void {
  schedSink = fn;
}
function schedLog(line: string): void {
  if (schedSink) schedSink(`SCHED ${line}`);
}

// AdsScheduler runs one .ADS script: it interprets the scene-director bytecode
// (ADD_SCENE / STOP_SCENE / RANDOM / conditionals), drives all running scene
// threads with the ads.go main-loop timing, and composites their layers.
//
// It is a faithful port of ads.go's core, minus the fork's compositing
// special-cases (plane-chase z-order, freeze-on-stop decorations).
export class AdsScheduler {
  private readonly ops: Op[];
  private readonly slots: Map<number, TtmSlot>;
  private readonly renderer: Renderer;
  private readonly rng: () => number;
  private readonly position: PositionFn;

  // Fixed slot array (Go's ttmThreads[MaxTTMThreads]); null = free slot.
  private threads: (SceneThread | null)[] = new Array(MAX_THREADS).fill(null);
  private chunks: Chunk[] = [];
  // Chunks registered at RUNTIME by IF_LASTPLAYED_LOCAL (0x1070), as opposed to
  // the load-time `chunks` above. Only ACTIVITY.ADS tag 7 uses this. A local
  // chunk that matches a completed scene REPLACES the general dispatch for that
  // (slot, tag) — see fireTriggeredChunks.
  private localChunks: Chunk[] = [];
  private lastPlayed: { slot: number; tag: number } | null = null;
  private stopped = false;

  // The island background (waves) and clouds threads. We don't draw them — the
  // Canvas2D port uses a baked backdrop, and in the Go engine they render via
  // grDrawSprite straight to the background surface, emitting NO trace lines.
  // But they ARE running threads in ads.go's main loop, so their timers take
  // part in the `mini` computation, and that QUANTIZES the whole scheduler's
  // clock (clouds delay 8 → mini is usually 8, never a long thread's full hold).
  // Without them, `mini` collapses a 150-tick hold in one step and every scene's
  // reap lands on the wrong iteration. So they are modelled as pure metronomes:
  // timers only, no rendering.
  //
  // Set up by adsInitIsland (ads.go) + islandInit (island.go, which overrides
  // the background thread's delay 40 → 8 and timer → 8 at the end).
  private bgTimer = 0;
  private bgDelay = 8;
  private cloudsTimer = 0;
  private cloudsDelay = 8;
  // Non-ISLAND scenes run adsNoIsland() instead, which stops both threads.
  private islandThreadsRunning = true;

  constructor(
    ads: AdsFile,
    slots: Map<number, TtmSlot>,
    renderer: Renderer,
    opts: { rng?: () => number; position?: PositionFn; island?: boolean } = {},
  ) {
    this.ops = ads.ops;
    this.slots = slots;
    this.renderer = renderer;
    this.rng = opts.rng ?? Math.random;
    this.position = opts.position ?? (() => ({ dx: 0, dy: 0 }));
    // ISLAND scenes (the default — see sceneHasIsland) run the background/clouds
    // threads; non-ISLAND ones don't.
    this.islandThreadsRunning = opts.island ?? true;
  }

  // live returns the running scenes in slot order (skipping free slots).
  private live(): SceneThread[] {
    return this.threads.filter((s): s is SceneThread => s !== null);
  }

  get isStopped(): boolean {
    return this.stopped && this.live().length === 0;
  }

  // isDrained is the ADS main loop's OWN exit condition: ads.go runs
  // `for numThreads != 0`, so adsPlay returns as soon as the last thread is
  // reaped — whether or not an END opcode was ever executed. `isStopped` is a
  // stricter, browser-facing notion (script explicitly ended AND nothing left
  // running) and must stay that way: the render loop uses it to decide when
  // playback is really over. The trace harness needs THIS one to know when a
  // pass of adsPlay has returned and the script should be re-entered — e.g.
  // STAND.ADS tag 14, whose entry chunk GOSUBs to a single scene and then runs
  // dry after one frame with no END in sight (4 trace lines vs the oracle's 60).
  get isDrained(): boolean {
    return this.live().length === 0;
  }

  get runningCount(): number {
    return this.live().length;
  }

  // debugScenes reports each running scene's (slot, tag, delay) for the frame
  // dumper — lets us see the per-frame delay alongside the rendered image.
  debugScenes(): { slot: number; tag: number; delay: number }[] {
    return this.live().map((s) => ({ slot: s.slot, tag: s.rootTag, delay: s.thread.delay }));
  }

  private entryTag = 0;

  // restart re-runs from the same entry tag (used by the trace harness to get a
  // clean, seeded run after arming the trace sink — the initial start() at page
  // load happened before the sink/deterministic RNG were set).
  //
  // It is ALSO how a finished script is re-entered. adsPlay returns as soon as
  // no thread is left running, but some entry tags legitimately run dry after a
  // frame or two (STAND.ADS tag 14 GOSUBs to a one-scene tag; tag 1's chain can
  // end early on a particular RANDOM outcome) and the engine simply plays them
  // again — runTestMode and the -traceserver both loop `adsPlay` until the frame
  // budget fills. Re-entry deliberately does NOT re-seed the RNG: the streams
  // carry on across passes, which is what keeps the second pass's RANDOM picks
  // matching the oracle's.
  restart(): void {
    this.start(this.entryTag);
  }

  // start runs the ADS chunk at the given entry tag (adsPlay → adsPlayChunk).
  start(entryTag: number): void {
    this.entryTag = entryTag;
    this.renderer.resetLayers();
    this.threads = new Array(MAX_THREADS).fill(null);
    this.stopped = false;
    // adsInitIsland state (see the field comments): background delay/timer are
    // 40/0 initially but islandInit overrides both to 8; clouds are 8/0.
    this.bgDelay = 8;
    this.bgTimer = 8;
    this.cloudsDelay = 8;
    this.cloudsTimer = 0;
    this.localChunks = []; // adsLoad resets numAdsChunksLocal
    this.registerChunks(entryTag);
    const ip = this.findTag(entryTag);
    if (ip < 0) {
      console.warn(`ADS tag ${entryTag} not found`);
      this.stopped = true;
      return;
    }
    this.playChunk(ip);
  }

  // findTag returns the op index just after the :TAG marker for `tag`.
  private findTag(tag: number): number {
    for (let i = 0; i < this.ops.length; i++) {
      if (!ADS_OPCODES.has(this.ops[i].op) && this.ops[i].op === tag) return i + 1;
    }
    return -1;
  }

  // registerChunks mirrors adsLoad: bookmark the IF_LASTPLAYED / leading
  // IF_NOT_RUNNING guarded chunks so they fire when their (slot,tag) scene
  // completes. Crucially, bookmarking is enabled ONLY within the ENTRY tag's
  // region (from `entryTag`'s marker to the next tag marker) — every other tag
  // toggles it back off. Registering chunks from ALL tags (the earlier bug) let
  // a completed scene match chunks belonging to unrelated entry sequences,
  // spawning a runaway pile of scenes.
  private registerChunks(entryTag: number): void {
    this.chunks = [];
    let bookmarking = false;
    let bookmarkingIfNotRunning = false;
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i].op;
      const a = this.ops[i].args ?? [];
      switch (op) {
        case AdsOp.IF_LASTPLAYED:
          if (bookmarking) {
            bookmarkingIfNotRunning = false;
            this.chunks.push({ slot: a[0], tag: a[1], ip: i + 1 });
          }
          break;
        case AdsOp.IF_NOT_RUNNING:
          if (bookmarking && bookmarkingIfNotRunning) {
            this.chunks.push({ slot: a[0], tag: a[1], ip: i + 1 });
          }
          break;
        case AdsOp.IF_IS_RUNNING:
          bookmarkingIfNotRunning = false;
          break;
        default:
          if (!ADS_OPCODES.has(op)) {
            // :TAG marker — enable bookmarking only for the entry tag's region.
            bookmarking = op === entryTag;
            bookmarkingIfNotRunning = op === entryTag;
          }
      }
    }
  }

  // playChunk interprets the ADS bytecode from `ip` until it hits a statement
  // boundary (PLAY_SCENE / END / END_IF stop the current chunk). Port of
  // adsPlayChunk with the inRand / inSkip / inOr flags.
  private playChunk(ip: number): void {
    let inRand = false;
    let inSkip = false;
    let inOr = false;
    let inIfLastplayedLocal = false;
    let randOps: RandOp[] = [];
    let cont = true;

    let i = ip;
    while (cont && i < this.ops.length) {
      const raw = this.ops[i++];
      const op = raw.op;
      const a = raw.args ?? [];
      switch (op) {
        case AdsOp.IF_LASTPLAYED:
          if (!inOr) cont = false;
          inOr = false;
          break;
        case AdsOp.IF_NOT_RUNNING:
          schedLog(
            `IF_NOT_RUNNING ${a[0]} ${a[1]} running=${this.isRunning(a[0], a[1]) ? 1 : 0} skip=${inSkip ? 1 : 0}`,
          );
          if (this.isRunning(a[0], a[1])) inSkip = true;
          break;
        case AdsOp.IF_IS_RUNNING:
          schedLog(
            `IF_IS_RUNNING ${a[0]} ${a[1]} running=${this.isRunning(a[0], a[1]) ? 1 : 0} skip=${inSkip ? 1 : 0}`,
          );
          inSkip = !this.isRunning(a[0], a[1]);
          break;
        case AdsOp.OR:
          inOr = true;
          break;
        case AdsOp.AND:
          break;
        case AdsOp.PLAY_SCENE:
          if (inSkip) inSkip = false;
          else cont = false;
          break;
        case AdsOp.ADD_SCENE:
          schedLog(
            `op ADD_SCENE ${a[0]} ${a[1]} ${a[2]} ${a[3]} skip=${inSkip ? 1 : 0} rand=${inRand ? 1 : 0}`,
          );
          if (!inSkip) {
            if (inRand) randOps.push({ type: "add", slot: a[0], tag: a[1], numPlays: a[2], weight: a[3] });
            else this.addScene(a[0], a[1], a[2]);
          }
          break;
        case AdsOp.STOP_SCENE:
          schedLog(`op STOP_SCENE ${a[0]} ${a[1]} ${a[2]} skip=${inSkip ? 1 : 0} rand=${inRand ? 1 : 0}`);
          if (!inSkip) {
            if (inRand) randOps.push({ type: "stop", slot: a[0], tag: a[1], numPlays: 0, weight: a[2] });
            else this.stopScene(a[0], a[1]);
          }
          break;
        case AdsOp.RANDOM_START:
          inRand = true;
          randOps = [];
          break;
        case AdsOp.NOP:
          if (inRand) randOps.push({ type: "nop", slot: 0, tag: 0, numPlays: 0, weight: a[0] });
          break;
        case AdsOp.RANDOM_END:
          inRand = false;
          this.pickRandom(randOps);
          break;
        case AdsOp.GOSUB_TAG: {
          const t = this.findTag(a[0]);
          if (t >= 0) this.playChunk(t);
          break;
        }
        case AdsOp.END:
          if (inSkip) inSkip = false;
          else this.stopped = true;
          cont = false;
          break;
        case AdsOp.IF_LASTPLAYED_LOCAL:
          // Registers a chunk at RUNTIME whose body (the ADD_SCENE_LOCAL that
          // follows) fires when scene (a[0], a[1]) completes, overriding the
          // load-time IF_LASTPLAYED chunks for that scene. Only ACTIVITY.ADS
          // tag 7 uses it. Without this the general chunk fired instead and the
          // script branched to the wrong scene (4:7 where the engine plays 4:22).
          schedLog(`IF_LASTPLAYED_LOCAL ${a[0]} ${a[1]}`);
          inIfLastplayedLocal = true;
          this.localChunks.push({ slot: a[0], tag: a[1], ip: i });
          break;
        case AdsOp.ADD_SCENE_LOCAL:
          // Two passes, as in adsPlayChunk: reached via IF_LASTPLAYED_LOCAL just
          // above it is only the queued body (nothing to do yet); reached
          // directly — i.e. replayed later by fireTriggeredChunks — it runs.
          // args are (?, slot, tag, arg3, ?).
          if (inIfLastplayedLocal) inIfLastplayedLocal = false;
          else this.addScene(a[1], a[2], a[3]);
          break;

        case AdsOp.END_IF:
        case AdsOp.IF_UNKNOWN_1:
        case AdsOp.UNKNOWN_2014:
        case AdsOp.UNKNOWN_6:
        case AdsOp.FADE_OUT:
          break;
        default:
          // :TAG marker mid-stream — treat as a boundary (end of chunk).
          if (!ADS_OPCODES.has(op)) cont = false;
      }
    }
  }

  private pickRandom(randOps: RandOp[]): void {
    if (randOps.length === 0) return;
    const total = randOps.reduce((s, r) => s + r.weight, 0);
    if (total <= 0) return;
    // In trace mode use the deterministic RNG (matches the Go engine's
    // traceRandN(totalWeight)); otherwise the injected/Math.random rng.
    let a = traceSink ? randAds(total) : Math.floor(this.rng() * total);
    let chosen = randOps[randOps.length - 1];
    let partial = 0;
    let idx = randOps.length - 1;
    for (let k = 0; k < randOps.length; k++) {
      const r = randOps[k];
      partial += r.weight;
      if (a < partial) {
        chosen = r;
        idx = k;
        break;
      }
    }
    if (schedSink) {
      const tnum = (t: RandOp["type"]) => (t === "add" ? 0 : t === "stop" ? 1 : 2);
      const ops = randOps.map((r) => `[t${tnum(r.type)} ${r.slot}:${r.tag} w${r.weight}]`).join("");
      schedLog(`PICK total=${total} draw=${a} idx=${idx} ops=${ops}`);
    }
    if (chosen.type === "add") this.addScene(chosen.slot, chosen.tag, chosen.numPlays);
    else if (chosen.type === "stop") this.stopScene(chosen.slot, chosen.tag);
    // nop: do nothing
  }

  // Mirrors isSceneRunning (ads.go): a thread counts as running while its slot
  // is occupied — INCLUDING one that has ended but not yet been reaped
  // (isRunning == 2). Excluding those (an earlier `&& !s.finished`) made
  // IF_NOT_RUNNING / IF_IS_RUNNING disagree with the engine, which skipped or
  // ran the wrong ADS branches.
  private isRunning(slot: number, tag: number): boolean {
    return this.threads.some((s) => s !== null && s.slot === slot && s.rootTag === tag);
  }

  // rebuildLayers re-orders the compositor by thread-slot index, matching Go's
  // fixed-array iteration in grUpdateDisplay.
  //
  // It must NOT re-create the layers. Each thread's layer is created once (in
  // addScene, like grNewLayer) and keeps its pixels until that thread's own
  // CLEAR_SCREEN wipes it or the thread stops (grFreeLayer). The earlier version
  // called resetLayers() and handed every live thread a brand-new empty layer on
  // every add/stop, which silently erased every OTHER running scene: in
  // ACTIVITY.ADS tag 12 the seagull scene starting wiped Johnny, who vanished
  // until his own thread next drew a frame. The oracle diff cannot catch this —
  // it compares draw CALLS, and the calls were right; only the pixels were lost.
  private rebuildLayers(): void {
    this.renderer.orderLayers(this.live().map((s) => s.thread.layerRef));
  }

  // addScene spawns a TtmThread for (slot, tag) on a fresh layer (adsAddScene).
  private addScene(slotNo: number, tag: number, arg3: number): void {
    if (this.isRunning(slotNo, tag)) return;
    const slot = this.slots.get(slotNo);
    if (!slot) {
      console.warn(`ADS references TTM slot ${slotNo} with no loaded TTM`);
      return;
    }
    // Lowest free slot (adsAddScene: `for ttmThreads[i].isRunning != 0 { i++ }`).
    const idx = this.threads.findIndex((s) => s === null);
    if (idx < 0) {
      console.warn("ADS: no free thread slot");
      return;
    }
    if (traceSink) traceSink(`SCENE slot=${slotNo} tag=${tag}`);
    const { dx, dy } = this.position(slotNo, tag);
    // slot 0 scenes enter at ip 0; others at the tag (adsAddScene). The layer is
    // (re)assigned by rebuildLayers so it sits in slot order.
    const layer = this.renderer.newLayer();
    const thread = new TtmThread(slot.manifest, slot.sheets, this.renderer, layer, slotNo === 0 ? undefined : tag);
    thread.sceneRootTag = tag;
    thread.setOrigin(dx, dy);

    // arg3 (ads.go:310-314), read as a SIGNED 16-bit value:
    //   < 0 → sceneTimer = -arg3 : play for that many time units, PURGE looping
    //         back to the previous tag until the timer drains (see tick()).
    //   > 0 → sceneIterations = arg3-1 : replay the scene that many more times.
    //   = 0 → neither: the scene ends on its first PURGE.
    const signed = arg3 >= 0x8000 ? arg3 - 0x10000 : arg3;
    const iterations = signed > 0 ? signed - 1 : 0;
    thread.sceneTimer = signed < 0 ? -signed : 0;
    this.threads[idx] = { slot: slotNo, rootTag: tag, thread, iterations, finished: false };
    schedLog(
      `ADD idx=${idx} ${slotNo}:${tag} arg3=${signed} timer=${thread.sceneTimer} iter=${iterations}`,
    );
    this.rebuildLayers(); // keep compositing order = slot order
  }

  // stopScene ends every thread matching (slot, tag) — adsStopSceneByTtmTag.
  //
  // Special case from the engine: STOP_SCENE (5, 10) also stops tags 7 and 8.
  // VISITOR.ADS tag 5 relies on it — the chunk that fires when 5:9 completes
  // does STOP_SCENE 5 10 to kill the *running* 5:7 before adding 5:3. Without
  // the alias nothing was stopped, 5:7 kept running, and 5:3 landed in thread
  // slot 1 instead of 0 — diverging every later frame's emission order.
  private stopMatches(s: SceneThread, slotNo: number, tag: number): boolean {
    if (s.slot !== slotNo) return false;
    if (slotNo === 5 && tag === 10) {
      return s.rootTag === 7 || s.rootTag === 8 || s.rootTag === 10;
    }
    return s.rootTag === tag;
  }

  private stopScene(slotNo: number, tag: number): void {
    let removed = false;
    for (let i = 0; i < this.threads.length; i++) {
      const s = this.threads[i];
      if (s && this.stopMatches(s, slotNo, tag)) {
        schedLog(`STOP idx=${i} ${s.slot}:${s.rootTag}`);
        this.renderer.removeLayer(s.thread.layerRef); // grFreeLayer
        this.threads[i] = null;
        removed = true;
      }
    }
    if (removed) this.rebuildLayers();
  }

  // state renders the thread array like Go's schedThreadState (idx=slot:tag,
  // isRunning, timer, delay, sceneTimer) so the decision logs diff line-for-line.
  private state(): string {
    let s = "";
    for (let i = 0; i < this.threads.length; i++) {
      const t = this.threads[i];
      if (!t) continue;
      const r = t.finished ? 2 : 1;
      s += `{${i}=${t.slot}:${t.rootTag} r${r} t${t.thread.timer} d${t.thread.delay} st${t.thread.sceneTimer}}`;
    }
    return s === "" ? "{}" : s;
  }

  // tick runs exactly ONE iteration of the ads.go main loop, in the engine's
  // order:
  //   1. run every thread whose timer == 0 (timer = delay, then ttmPlay)
  //   2. emit the frame (our caller presents)
  //   3. mini = smallest (timer, delay) across running threads
  //   4. subtract mini from every running thread's timer
  //   5. for threads now at timer == 0: apply pending goto, drain sceneTimer,
  //      then replay-or-reap (reaping fires the triggered chunks)
  //
  // Step 3/4 is the ENGINE'S CLOCK and must be ported literally. An earlier
  // version counted every timer down by 1 per tick instead, on the theory that a
  // fixed-rate rAF replaces Go's `sleep(mini * 20ms)`. That conflates two
  // different things: the sleep is wall-clock pacing (correctly dropped — the
  // trace steps by frame, not time), but the SUBTRACTION is what orders thread
  // wake-ups relative to each other. With 1-per-tick, a finished thread had to
  // be force-reaped (timer = 0) to avoid stalling, which reaped it in the same
  // iteration it ended — whereas the engine keeps it alive for the remainder of
  // its hold, during which OTHER threads run frames. That reordered every
  // multi-thread scene's frame stream (STAND.ADS tag 2 reaped 1:61 ~20
  // iterations early). Pacing belongs in the render loop (TICK_MS), not here.
  // Engine time-units consumed by the last tick() — the `mini` it subtracted.
  // ads.go sleeps exactly this long (mini * 20ms) after each iteration, so a
  // real-time caller must pay the same cost or playback runs `mini` times too
  // fast. The trace harness ignores it (it steps by frame, not wall clock).
  private lastTickUnits = 1;
  get lastTickCost(): number {
    return Math.max(1, this.lastTickUnits);
  }

  // Called at ads.go's grUpdateDisplay point inside tick() — see step 2 there.
  // The caller composites here rather than after tick() returns, so a scene's
  // last frame is shown before its layer is freed by the reap.
  onPresent: (() => void) | null = null;

  tick(): boolean {
    if (this.live().length === 0) return false;
    let changed = false;
    this.lastTickUnits = 1;
    schedLog(`LOOP ${this.state()}`);

    // 0. The background/clouds metronomes re-arm when their timer reaches 0,
    // exactly as ads.go does before the scene threads. They draw nothing here
    // (see the field comments) — only their timers matter, via `mini` below.
    if (this.islandThreadsRunning) {
      if (this.bgTimer <= 0) this.bgTimer = this.bgDelay;
      if (this.cloudsTimer <= 0) this.cloudsTimer = this.cloudsDelay;
    }

    // 1. Run ready threads in slot order (Go iterates ttmThreads[0..N]).
    for (let i = 0; i < this.threads.length; i++) {
      const s = this.threads[i];
      if (s === null || s.finished) continue;
      if (s.thread.timer <= 0) {
        schedLog(`RUN idx=${i} ${s.slot}:${s.rootTag} delay=${s.thread.delay}`);
        // ads.go order: timer = (previous frame's) delay, THEN run this frame.
        // SET_DELAY/TIMER inside the frame overwrite both, as in ttm.go.
        s.thread.timer = s.thread.delay;
        s.thread.runOneFrame();
        changed = true;
        if (s.thread.isDone) s.finished = true; // isRunning = 2; reaped in step 5
      }
    }

    // 2. DISPLAY. This is ads.go's grUpdateDisplay call site, and its position
    // matters: it runs AFTER the frame(s) were drawn but BEFORE the reap step
    // below frees any finished thread's layer. A scene's final frame is drawn,
    // shown, and only then does its layer go away.
    //
    // Presenting after tick() returns instead (i.e. after the reap) loses that
    // final frame: BUILDING.ADS tag 1 draws Johnny's last walking sprite on
    // tag 16's layer, PURGEs, and is reaped in the same iteration — so the
    // viewer saw an empty island where the engine shows him mid-stride. The
    // draw-call trace is identical either way, which is why the oracle can't
    // catch this.
    if (changed) this.onPresent?.();

    // The trace's frame budget stops the run right after the frame is emitted —
    // ads.go returns from adsPlay on traceReachedBudget, BEFORE the mini/reap
    // step below. Bail at the same point so the oracle sees the same final
    // frame and the same trailing state.
    if (TtmThread.traceReachedBudget) return changed;

    // 3. mini = min over RUNNING threads (incl. finished-but-unreaped, which are
    // isRunning == 2 in Go and still counted) of both `delay` and `timer` —
    // plus the background/clouds threads' timers, which is what keeps `mini`
    // small (usually 8) instead of swallowing a long hold whole.
    let mini = 300;
    if (this.islandThreadsRunning) {
      mini = this.bgTimer;
      if (this.cloudsTimer < mini) mini = this.cloudsTimer;
    }
    for (const s of this.live()) {
      if (s.thread.delay < mini) mini = s.thread.delay;
      if (s.thread.timer < mini) mini = s.thread.timer;
    }

    // 4. Decrease all timers by the shortest one.
    this.bgTimer -= mini;
    this.cloudsTimer -= mini;
    for (const s of this.live()) s.thread.timer -= mini;
    this.lastTickUnits = mini;
    schedLog(`MINI ${mini} after=${this.state()}`);

    // 5. Post-step processing for threads whose timer has now elapsed.
    let membershipChanged = false;
    for (let i = 0; i < this.threads.length; i++) {
      const s = this.threads[i];
      if (!s || s.thread.timer > 0) continue;

      // Pending goto is applied by runOneFrame at the start of the next frame,
      // which is where ads.go's `ip = nextGotoOffset` lands too.

      // Drain the ADS duration timer (ADD_SCENE arg3 < 0). This is what finally
      // stops a timed PURGE-looping scene — PURGE only loops it while sceneTimer
      // != 0; the countdown here is what ends it.
      if (s.thread.sceneTimer > 0) {
        s.thread.sceneTimer -= s.thread.delay;
        if (s.thread.sceneTimer <= 0) {
          s.thread.sceneTimer = 0;
          s.thread.markDone(); // isRunning = 2
          s.finished = true;
        }
      }

      if (!s.finished) continue;

      // Iteration replay (ADD_SCENE arg3 > 0) takes precedence over reaping.
      if (s.iterations > 0) {
        s.iterations--;
        s.thread.restart(true); // keeps the timer, as ads.go does
        s.finished = false;
        continue;
      }

      schedLog(`REAP idx=${i} ${s.slot}:${s.rootTag} state=${this.state()}`);
      this.lastPlayed = { slot: s.slot, tag: s.rootTag };
      this.renderer.removeLayer(s.thread.layerRef); // adsStopScene → grFreeLayer
      this.threads[i] = null;
      membershipChanged = true;
      if (!this.stopped) {
        schedLog(`FIRE ${s.slot}:${s.rootTag}`);
        this.fireTriggeredChunks(s.slot, s.rootTag);
      }
    }
    if (membershipChanged) this.rebuildLayers();

    // NOTE: a membership change alone is deliberately NOT reported as `changed`.
    // ads.go calls grUpdateDisplay once per iteration, BEFORE the reap step —
    // so the instant between "old scene reaped, new scenes added" and "a new
    // scene draws its first frame" is never presented. Returning true there made
    // the dump stepper capture that in-between state, which is momentarily blank
    // (both fresh layers empty, the old one freed): ACTIVITY.ADS tag 12 looked
    // like Johnny vanishing for a frame. The draw-call trace was correct
    // throughout — only the presented moment was wrong.
    return changed;
  }


  // fireTriggeredChunks replays the ADS chunks guarded on this (slot, tag)
  // scene's completion (adsPlayTriggeredChunks). This is how MARY.ADS advances
  // from one date beat to the next (IF_LASTPLAYED (4,24) → ADD_SCENE (4,12)…).
  private fireTriggeredChunks(slot: number, tag: number): void {
    // A runtime IF_LASTPLAYED_LOCAL chunk takes precedence and SUPPRESSES the
    // general dispatch — but only for the (slot, tag) it actually matched, not
    // globally (adsPlayTriggeredChunks: `localMatched`, the r.c. fix noted
    // there). Each local chunk fires once, then is consumed.
    let localMatched = false;
    for (let i = this.localChunks.length - 1; i >= 0; i--) {
      const c = this.localChunks[i];
      if (c.slot === slot && c.tag === tag) {
        this.localChunks.splice(i, 1);
        this.playChunk(c.ip);
        localMatched = true;
      }
    }
    if (localMatched) return;
    for (const c of this.chunks) {
      if (c.slot === slot && c.tag === tag) this.playChunk(c.ip);
    }
  }

  get lastPlayedScene(): { slot: number; tag: number } | null {
    return this.lastPlayed;
  }
}

// loadAds fetches an ADS script and every TTM it references (by the RES slot
// map), returning the AdsFile plus the slot→TtmSlot map the scheduler needs.
export async function loadAds(
  animRoot: string,
  dir: string,
): Promise<{ ads: AdsFile; slots: Map<number, TtmSlot> }> {
  const ads = await loadAdsFile(animRoot, dir);
  const slots = new Map<number, TtmSlot>();
  await Promise.all(
    ads.res.map(async (r) => {
      try {
        const { manifest, sheets } = await loadAnimation(`${animRoot}/${r.name}`);
        slots.set(r.id, { manifest, sheets });
      } catch (err) {
        // A missing TTM (e.g. the orphaned FIRE.TTM) just leaves that slot
        // empty; scenes referencing it warn and no-op rather than crash.
        console.warn(`ADS ${dir}: could not load slot ${r.id} (${r.name}):`, err);
      }
    }),
  );
  return { ads, slots };
}
