import { AdsOp, ADS_OPCODES } from "./opcodes";
import { TtmThread, traceSink, randInt } from "../ttm/interpreter";
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
  done: boolean;
}

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

  private scenes: SceneThread[] = [];
  private chunks: Chunk[] = [];
  private lastPlayed: { slot: number; tag: number } | null = null;
  private stopped = false;

  constructor(
    ads: AdsFile,
    slots: Map<number, TtmSlot>,
    renderer: Renderer,
    opts: { rng?: () => number; position?: PositionFn } = {},
  ) {
    this.ops = ads.ops;
    this.slots = slots;
    this.renderer = renderer;
    this.rng = opts.rng ?? Math.random;
    this.position = opts.position ?? (() => ({ dx: 0, dy: 0 }));
  }

  get isStopped(): boolean {
    return this.stopped && this.scenes.length === 0;
  }

  get runningCount(): number {
    return this.scenes.length;
  }

  // debugScenes reports each running scene's (slot, tag, delay) for the frame
  // dumper — lets us see the per-frame delay alongside the rendered image.
  debugScenes(): { slot: number; tag: number; delay: number }[] {
    return this.scenes.map((s) => ({ slot: s.slot, tag: s.rootTag, delay: s.thread.delay }));
  }

  // start runs the ADS chunk at the given entry tag (adsPlay → adsPlayChunk).
  start(entryTag: number): void {
    this.renderer.resetLayers();
    this.scenes = [];
    this.stopped = false;
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
          if (this.isRunning(a[0], a[1])) inSkip = true;
          break;
        case AdsOp.IF_IS_RUNNING:
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
          if (!inSkip) {
            if (inRand) randOps.push({ type: "add", slot: a[0], tag: a[1], numPlays: a[2], weight: a[3] });
            else this.addScene(a[0], a[1], a[2]);
          }
          break;
        case AdsOp.STOP_SCENE:
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
        case AdsOp.END_IF:
        case AdsOp.IF_UNKNOWN_1:
        case AdsOp.UNKNOWN_2014:
        case AdsOp.UNKNOWN_6:
        case AdsOp.FADE_OUT:
        case AdsOp.IF_LASTPLAYED_LOCAL:
        case AdsOp.ADD_SCENE_LOCAL:
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
    let a = traceSink ? randInt(total) : Math.floor(this.rng() * total);
    let chosen = randOps[randOps.length - 1];
    let partial = 0;
    for (const r of randOps) {
      partial += r.weight;
      if (a < partial) {
        chosen = r;
        break;
      }
    }
    if (chosen.type === "add") this.addScene(chosen.slot, chosen.tag, chosen.numPlays);
    else if (chosen.type === "stop") this.stopScene(chosen.slot, chosen.tag);
    // nop: do nothing
  }

  private isRunning(slot: number, tag: number): boolean {
    return this.scenes.some((s) => s.slot === slot && s.rootTag === tag && !s.done);
  }

  // addScene spawns a TtmThread for (slot, tag) on a fresh layer (adsAddScene).
  private addScene(slotNo: number, tag: number, arg3: number): void {
    if (this.isRunning(slotNo, tag)) return;
    const slot = this.slots.get(slotNo);
    if (!slot) {
      console.warn(`ADS references TTM slot ${slotNo} with no loaded TTM`);
      return;
    }
    if (traceSink) traceSink(`SCENE slot=${slotNo} tag=${tag}`);
    const layer = this.renderer.newLayer();
    const { dx, dy } = this.position(slotNo, tag);
    // slot 0 scenes enter at ip 0; others at the tag (adsAddScene).
    const thread = new TtmThread(slot.manifest, slot.sheets, this.renderer, layer, slotNo === 0 ? undefined : tag);
    thread.sceneRootTag = tag;
    thread.purgeEnds = true; // ADS scenes end on PURGE so the script can chain
    thread.setOrigin(dx, dy);

    // arg3: negative = duration timer (unsupported here → run once);
    // positive = iteration count (replay arg3-1 more times).
    const iterations = arg3 > 0 && arg3 < 0x8000 ? arg3 - 1 : 0;
    this.scenes.push({ slot: slotNo, rootTag: tag, thread, iterations, done: false });
  }

  private stopScene(slotNo: number, tag: number): void {
    this.scenes = this.scenes.filter((s) => !(s.slot === slotNo && s.rootTag === tag));
    this.renderer.resetLayers();
    // Rebuild remaining layers in order (compositing order preserved).
    for (const s of this.scenes) {
      const layer = this.renderer.newLayer();
      s.thread.rebindLayer(layer);
    }
  }

  // tick advances the clock by ONE engine time-unit (~20ms; see TICK_MS in
  // main.ts) and runs a frame for any scene whose timer reaches 0. A displayed
  // TTM frame is held for `delay` units before the next runs (ttmPlay sets
  // delay via SET_DELAY/TIMER; grUpdateDisplay holds it delay*0.02s).
  //
  // NOTE: the Go loop subtracts `mini` (the smallest timer) each iteration and
  // then SLEEPS mini*20ms. Because we're driven by a fixed-rate rAF instead of
  // sleeping, we must instead count each timer down by 1 per tick — subtracting
  // the whole `mini` here (as an earlier version did) collapsed every scene's
  // delay into a single tick, so everything ran at a flat frame-per-tick and
  // the whole script played far too fast.
  tick(): boolean {
    if (this.scenes.length === 0) return false;
    let changed = false;

    for (const s of this.scenes) {
      if (s.done) continue;
      if (s.thread.timer <= 0) {
        s.thread.runOneFrame();
        s.thread.timer = Math.max(1, s.thread.delay); // hold for `delay` ticks
        changed = true;
        if (s.thread.isDone) this.onSceneComplete(s);
      } else {
        s.thread.timer -= 1;
      }
    }

    // Reap completed scenes; fire their triggered chunks.
    const completed = this.scenes.filter((s) => s.done);
    this.scenes = this.scenes.filter((s) => !s.done);
    if (completed.length > 0) {
      this.renderer.resetLayers();
      for (const s of this.scenes) s.thread.rebindLayer(this.renderer.newLayer());
      for (const c of completed) this.fireTriggeredChunks(c.slot, c.rootTag);
      changed = true;
    }

    return changed;
  }

  private onSceneComplete(s: SceneThread): void {
    if (s.iterations > 0) {
      s.iterations--;
      s.thread.restart();
      return;
    }
    s.done = true;
    this.lastPlayed = { slot: s.slot, tag: s.rootTag };
  }

  // fireTriggeredChunks replays the ADS chunks guarded on this (slot, tag)
  // scene's completion (adsPlayTriggeredChunks). This is how MARY.ADS advances
  // from one date beat to the next (IF_LASTPLAYED (4,24) → ADD_SCENE (4,12)…).
  private fireTriggeredChunks(slot: number, tag: number): void {
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
