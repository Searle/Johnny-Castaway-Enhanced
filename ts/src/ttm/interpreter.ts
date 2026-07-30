import { Op } from "./opcodes";
import type { Manifest, Op as RawOp, LoadedSheet } from "../manifest";
import type { Renderer } from "../render/renderer";

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
  private readonly renderer: Renderer;

  private ip = 0; // index into ops
  private delay = 6; // ticks to wait after the current frame
  private timer = 0; // ticks remaining before the next frame runs
  private nextGoto = -1; // pending jump target (op index), or -1
  private done = false;

  // Per-thread engine state set by opcodes.
  private selectedBmpSlot = 0;
  private bmpSlots: (LoadedSheet | null)[] = new Array(6).fill(null);
  private readonly palette: string[];
  private fgColor = 0; // SET_COLORS args — palette indices for primitives
  private bgColor = 0;

  // In the real engine the ADS scheduler enters a TTM at the byte offset of a
  // chosen scene *tag* (ads.go sets ip = ttmFindTag(sceneRootTag)), not at 0.
  // The ops before the first tag are a one-time prologue (LOAD_PALETTE /
  // LOAD_SCREEN). Without an ADS script, the slice runs that prologue once and
  // then loops a single scene: startTag (default = the first tag in the file).
  constructor(
    manifest: Manifest,
    sheets: Map<string, LoadedSheet>,
    renderer: Renderer,
    startTag?: number,
  ) {
    this.ops = manifest.ops;
    this.sheets = sheets;
    this.renderer = renderer;
    this.palette = manifest.palette ?? [];
    this.buildTags();
    this.runPrologue();
    if (this.tags.length > 0) {
      const tag = startTag ?? this.tags[0].id;
      const target = this.findTag(tag);
      this.ip = target >= 0 ? target : this.ip;
    }
    // Enter the scene fresh: run its first frame on the very next tick.
    this.timer = 0;
    this.nextGoto = -1;
  }

  get isDone(): boolean {
    return this.done;
  }

  get tagIds(): number[] {
    return this.tags.map((t) => t.id);
  }

  // runPrologue binds resources before the scene runs. In the real engine the
  // ADS script sequences scene tags so that whichever tag loads a BMP runs
  // before any tag that draws from it — the LOAD_IMAGE / LOAD_SCREEN ops are
  // frequently INSIDE the first "setup" scene body, not before the first tag
  // (e.g. MJBATH loads MJBATH.BMP into slot 0 just after TAG 42). Without an
  // ADS script we can't know that ordering, so we conservatively pre-execute
  // every resource-binding op once, in file order. These binds are idempotent
  // (they just point a slot at a sheet), so replaying them up front is safe and
  // gives every scene its sprites. Drawing/timer/flow ops are skipped here.
  private runPrologue(): void {
    for (const raw of this.ops) {
      switch (raw.op) {
        case Op.SET_BMP_SLOT:
          this.selectedBmpSlot = raw.args?.[0] ?? 0;
          break;
        case Op.LOAD_IMAGE:
          this.bmpSlots[this.selectedBmpSlot] =
            this.sheets.get((raw.str ?? "").toUpperCase()) ?? null;
          break;
        case Op.LOAD_SCREEN: {
          const sheet = this.sheets.get((raw.str ?? "").toUpperCase());
          this.renderer.setBackground(sheet?.frames[0] ?? null);
          break;
        }
      }
    }
    this.selectedBmpSlot = 0;
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
    if (this.timer > 0) {
      this.timer--;
      if (this.timer > 0) return false;
    }
    // timer reached 0: apply pending jump (ads.go main-loop jump processing).
    if (this.nextGoto >= 0) {
      this.ip = this.nextGoto;
      this.nextGoto = -1;
    }
    this.runFrame();
    this.timer = this.delay;
    return true;
  }

  // runFrame executes opcodes until UPDATE (ttmPlay's loop body).
  private runFrame(): void {
    for (;;) {
      if (this.ip >= this.ops.length) {
        this.done = true;
        return;
      }
      if (this.execOne()) return; // hit UPDATE — frame complete
    }
  }

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
          this.delay = v;
          this.timer = v;
          break;
        }
        case Op.TIMER: {
          // (min,max) range → uniform random delay, matching the Go 0x2022.
          const lo = a[0],
            hi = a[1];
          this.delay = hi > lo ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo;
          this.timer = this.delay;
          break;
        }

        case Op.SET_BMP_SLOT:
          this.selectedBmpSlot = a[0];
          break;

        case Op.LOAD_SCREEN: {
          const sheet = this.sheets.get((raw.str ?? "").toUpperCase());
          this.renderer.setBackground(sheet?.frames[0] ?? null);
          break;
        }
        case Op.LOAD_IMAGE: {
          const sheet = this.sheets.get((raw.str ?? "").toUpperCase()) ?? null;
          this.bmpSlots[this.selectedBmpSlot] = sheet;
          break;
        }

        case Op.CLEAR_SCREEN:
          this.renderer.clearScreen();
          break;

        case Op.DRAW_SPRITE:
        case Op.DRAW_SPRITE_FLIP: {
          // args: x, y, spriteNo, imageNo
          const [x, y, spriteNo, imageNo] = a;
          const sheet = this.bmpSlots[imageNo];
          const frame = sheet?.frames[spriteNo];
          if (frame) {
            this.renderer.drawSprite(frame, s16(x), s16(y), raw.op === Op.DRAW_SPRITE_FLIP);
          }
          break;
        }

        case Op.SET_COLORS:
          this.fgColor = a[0];
          this.bgColor = a[1];
          break;

        case Op.DRAW_LINE:
          this.renderer.drawLine(s16(a[0]), s16(a[1]), s16(a[2]), s16(a[3]), this.color(this.fgColor));
          break;
        case Op.DRAW_RECT:
          // args: x, y, w, h (w/h are unsigned sizes)
          this.renderer.drawRect(s16(a[0]), s16(a[1]), a[2], a[3], this.color(this.fgColor));
          break;
        case Op.DRAW_CIRCLE: {
          // args: x, y, w, h — filled with bgColor, outlined with fgColor.
          const fg = this.color(this.fgColor);
          const bg = this.color(this.bgColor);
          this.renderer.drawCircle(s16(a[0]), s16(a[1]), a[2], a[3], bg, fg === bg ? null : fg);
          break;
        }
        case Op.DRAW_PIXEL:
          this.renderer.drawPixel(s16(a[0]), s16(a[1]), this.color(this.fgColor));
          break;

        case Op.SET_CLIP_ZONE: {
          // args: x1, y1, x2, y2 (top-left, bottom-right corners). The
          // full-screen reset convention (0,0,>=639,>=479) clears the clip
          // (grSetClipZone). Otherwise scissor to that rect.
          const x1 = s16(a[0]),
            y1 = s16(a[1]),
            x2 = s16(a[2]),
            y2 = s16(a[3]);
          if (x1 <= 0 && y1 <= 0 && x2 >= 639 && y2 >= 479) {
            this.renderer.clearClip();
          } else {
            this.renderer.setClip(x1, y1, x2 - x1 + 1, y2 - y1 + 1);
          }
          break;
        }

        case Op.GOTO_TAG:
          this.nextGoto = this.findTag(a[0]);
          break;

        case Op.PURGE:
          // With no scene timer in the slice, PURGE loops back to the previous
          // tag (ttm.go: sceneTimer != 0 branch), giving us a clean repeat.
          this.nextGoto = this.findPreviousTag(this.ip);
          if (this.nextGoto < 0) this.done = true;
          break;

        // Still no-op (decoded for alignment, low impact in the slice):
        // SET_PALETTE_SLOT, SET_FRAME1, CLEAR_IMGSLOT, SAVE_IMAGE1/ZONE,
        // COPY_ZONE_TO_BG, DRAW_SCREEN, PLAY_SAMPLE, LOAD_PALETTE, tag markers.
        default:
          break;
      }
    }
    return false; // non-UPDATE opcode: frame continues
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
