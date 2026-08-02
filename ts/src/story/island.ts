// The procedurally drawn island — a port of island.go.
//
// Until now the port used a single pre-baked backdrop (ISLETEMP.SCR), which is
// a photograph of one particular island configuration: high tide, no raft, no
// holiday, at x=0. The real engine BUILDS the island each episode out of
// BACKGRND.BMP sprites over an ocean backdrop, which is what makes tide, raft
// progress, holidays, night and the randomized position visible at all.
//
// Everything here draws onto the BACKGROUND surface (as the engine does), with
// one exception: clouds and holiday decorations live on their own layers
// because they animate or must sit above the scene.
//
// These assets are loaded by engine code, not by any TTM's LOAD_IMAGE, so the
// extractor pulls them separately into _ISLAND/ (see tools/tsextract).

import type { LoadedSheet } from "../manifest";
import type { Layer } from "../render/renderer";
import { Holiday, type IslandState } from "./story";

export const ISLAND_DIR = "_ISLAND";

// Sprite indices into BACKGRND.BMP, named after island.go's comments.
const SPR_ISLAND = 0;
const SPR_LOWTIDE_SHORE = 1;
const SPR_ROCK = 2;
const SPR_WAVES_HIGH_LEFT = 3;
const SPR_WAVES_HIGH_CENTER = 6;
const SPR_WAVES_HIGH_RIGHT = 9;
const SPR_LEAVES = 12;
const SPR_TRUNK = 13;
const SPR_SHADOW = 14;
const SPR_CLOUD0 = 15;
const SPR_WAVES_LOW_LEFT = 30;
const SPR_WAVES_LOW_CENTER = 33;
const SPR_WAVES_LOW_RIGHT = 36;
const SPR_WAVES_ROCK = 39;

/** Per-cloud drift state (TCloudState). */
interface Cloud {
  no: number;
  speed: number;
  x: number;
  y: number;
}

export interface IslandAssets {
  backgrnd: LoadedSheet;
  raft: LoadedSheet;
  holiday: LoadedSheet;
  screens: Map<string, ImageBitmap>;
}

const VIRTUAL_WIDTH = 640;

export class Island {
  private clouds: Cloud[] = [];
  private windDirection = 0;
  // island.go's `counter1`/`counter2`: which of the three (or four) shore
  // segments animates this tick, and which of its two frames it shows.
  private counter1 = 0;
  private counter2 = 0;
  private dx = 0;
  private dy = 0;

  constructor(
    private assets: IslandAssets,
    private rnd: () => number,
  ) {}

  private randInt(n: number): number {
    return Math.floor(this.rnd() * n);
  }

  /** The backdrop this island configuration wants (islandInit's first step). */
  backdropFor(state: IslandState): ImageBitmap | null {
    const name = state.night ? "NIGHT.SCR" : `OCEAN0${this.randInt(3)}.SCR`;
    return this.assets.screens.get(name) ?? null;
  }

  // build draws the static island onto `bg`: raft, island, palm, shadow, and
  // the low-tide shore/rock. Mirrors islandInit() minus the cloud RNG, which
  // initClouds does. Call after setting the backdrop.
  build(state: IslandState, bg: Layer): void {
    this.dx = state.xPos;
    this.dy = state.yPos;
    bg.setOrigin(this.dx, this.dy);

    // Raft: five build stages, shifted seaward at low tide.
    const xRaft = state.lowTide ? 529 : 512;
    const yRaft = state.lowTide ? 281 : 266;
    if (state.raft >= 1 && state.raft <= 5) {
      const img = this.assets.raft.frames[state.raft - 1];
      if (img) bg.drawSprite(img, xRaft, yRaft, false);
    }

    const b = this.assets.backgrnd.frames;
    const draw = (idx: number, x: number, y: number) => {
      const img = b[idx];
      if (img) bg.drawSprite(img, x, y, false);
    };

    draw(SPR_ISLAND, 288, 279);
    draw(SPR_TRUNK, 442, 148);
    draw(SPR_LEAVES, 365, 122);
    draw(SPR_SHADOW, 396, 279);

    if (state.lowTide) {
      draw(SPR_LOWTIDE_SHORE, 249, 303);
      draw(SPR_ROCK, 150, 328);
    }

    // Four priming ticks so the shore isn't bare on the first frame.
    for (let i = 0; i < 4; i++) this.animateWaves(state, bg);
  }

  // initClouds mirrors islandInit's cloud section. Cloud positions are chosen
  // in UNSHIFTED screen space (the engine zeroes grDx/grDy around this), so
  // clouds drift across the whole sky regardless of where the island sits.
  initClouds(): void {
    this.clouds = [];
    const numClouds = this.randInt(6);
    this.windDirection = this.randInt(2);
    for (let i = 0; i < numClouds; i++) {
      const no = this.randInt(3);
      let x = 0;
      let y = 0;
      // Each cloud size gets its own spawn box (wider clouds start further left
      // so they don't pop in at the edge).
      if (no === 0) {
        x = this.randInt(VIRTUAL_WIDTH - 129);
        y = this.randInt(100 - 36) + 25;
      } else if (no === 1) {
        x = this.randInt(VIRTUAL_WIDTH - 192);
        y = this.randInt(100 - 57) + 25;
      } else {
        x = this.randInt(VIRTUAL_WIDTH - 264);
        y = this.randInt(100 - 76) + 25;
      }
      this.clouds.push({ no, speed: this.randInt(2) + 1, x, y });
    }
  }

  get cloudCount(): number {
    return this.clouds.length;
  }

  // Cloud state for tools/oracle-diff/cloudorder.py. Clouds spawn at y 25..101
  // and Johnny stands at y>=279, so they almost never overlap on their own —
  // "wait and watch" was inconclusive over 80 samples. The probe parks the
  // clouds on the scene's own bounding box to FORCE the overlap it needs to
  // judge slot order. Returns the live array deliberately.
  __clouds(): Cloud[] {
    return this.clouds;
  }

  // animateWaves is islandAnimate(): ONE shore segment advances per call,
  // cycling through them, with each segment alternating between two frames.
  // That staggering is why the shoreline shimmers rather than pulsing.
  animateWaves(state: IslandState, bg: Layer): void {
    bg.setOrigin(this.dx, this.dy);
    const b = this.assets.backgrnd.frames;
    const draw = (idx: number, x: number, y: number) => {
      const img = b[idx];
      if (img) bg.drawSprite(img, x, y, false);
    };

    if (state.lowTide) {
      this.counter2 = (this.counter2 + 1) % 4;
      switch (this.counter2) {
        case 0:
          draw(SPR_WAVES_ROCK + this.counter1, 129, 340);
          break;
        case 1:
          draw(SPR_WAVES_LOW_LEFT + this.counter1, 233, 323);
          break;
        case 2:
          draw(SPR_WAVES_LOW_CENTER + this.counter1, 367, 356);
          break;
        case 3:
          draw(SPR_WAVES_LOW_RIGHT + this.counter1, 558, 323);
          break;
      }
    } else {
      this.counter2 = (this.counter2 + 1) % 3;
      switch (this.counter2) {
        case 0:
          draw(SPR_WAVES_HIGH_LEFT + this.counter1, 270, 306);
          break;
        case 1:
          draw(SPR_WAVES_HIGH_CENTER + this.counter1, 364, 319);
          break;
        case 2:
          draw(SPR_WAVES_HIGH_RIGHT + this.counter1, 518, 303);
          break;
      }
    }

    if (this.counter2 === 0) this.counter1 = (this.counter1 + 1) % 2;
  }

  // animateClouds is islandAnimateClouds(): clear the cloud layer, drift each
  // cloud by its own speed, wrap it around, and redraw. Clouds are flipped when
  // the wind blows the other way.
  animateClouds(layer: Layer): void {
    layer.clear();
    if (this.clouds.length === 0) return;
    layer.setOrigin(0, 0); // clouds are not island-relative
    const b = this.assets.backgrnd.frames;
    for (const c of this.clouds) {
      if (c.x > VIRTUAL_WIDTH + 264) c.x = -264;
      else if (c.x < -264) c.x = VIRTUAL_WIDTH + 264;
      else c.x += this.windDirection > 0 ? -c.speed : c.speed;

      const img = b[SPR_CLOUD0 + c.no];
      if (img) layer.drawSprite(img, c.x, c.y, this.windDirection <= 0);
    }
  }

  // drawHoliday is islandInitHoliday(): a single decoration, on its own layer
  // so it composites above the scene (the engine gives it its own thread).
  drawHoliday(state: IslandState, layer: Layer): void {
    layer.clear();
    if (state.holiday === Holiday.None) return;
    layer.setOrigin(this.dx, this.dy);
    const f = this.assets.holiday.frames;
    const place: Record<number, [number, number, number]> = {
      [Holiday.Halloween]: [410, 298, 0],
      [Holiday.StPatrick]: [333, 286, 1],
      [Holiday.Christmas]: [404, 267, 2],
      [Holiday.NewYear]: [361, 155, 3],
    };
    const p = place[state.holiday];
    if (!p) return;
    const img = f[p[2]];
    if (img) layer.drawSprite(img, p[0], p[1], false);
  }

  // Redraw the palm over a sprite that walked behind it (walk.go's
  // isBehindTree). The caller owns the layer's origin — walkAnimate draws the
  // trunk with whatever grDx the walk is already using — so this must NOT set
  // it, or the palm would land at the island's offset instead of the walk's.
  drawPalmOver(layer: Layer): void {
    const b = this.assets.backgrnd.frames;
    if (b[SPR_TRUNK]) layer.drawSprite(b[SPR_TRUNK], 442, 148, false);
    if (b[SPR_LEAVES]) layer.drawSprite(b[SPR_LEAVES], 365, 122, false);
  }
}
