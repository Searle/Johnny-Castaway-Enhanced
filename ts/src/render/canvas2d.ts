import type { Layer, Renderer, Slot } from "./renderer";

const W = 640;
const H = 480;

// Canvas2DLayer is one thread's offscreen drawing surface. All draws honor the
// per-layer origin (grDx/grDy) and the active clip rect.
class Canvas2DLayer implements Layer {
  readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private clip: { x: number; y: number; w: number; h: number } | null = null;
  private dx = 0;
  private dy = 0;

  constructor() {
    this.canvas = new OffscreenCanvas(W, H);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("offscreen 2d context unavailable");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  setOrigin(dx: number, dy: number): void {
    this.dx = dx;
    this.dy = dy;
  }

  get origin(): { dx: number; dy: number } {
    return { dx: this.dx, dy: this.dy };
  }

  clear(): void {
    this.ctx.clearRect(0, 0, W, H);
  }

  // blitFrom copies a rect of `src` into this layer at the same coordinates
  // (used to bake a zone into the persistent saved-zones layer). No origin/clip.
  blitFrom(src: OffscreenCanvas, x: number, y: number, w: number, h: number): void {
    this.ctx.drawImage(src, x, y, w, h, x, y, w, h);
  }

  setClip(x: number, y: number, w: number, h: number): void {
    this.clip = { x: x + this.dx, y: y + this.dy, w, h };
  }
  clearClip(): void {
    this.clip = null;
  }

  // withClip applies the clip rect (if any) around a draw. Canvas2D clip() is
  // bound to the current save/restore scope, so it must be reapplied per draw
  // rather than held open like raylib's scissor mode.
  private withClip(draw: (ctx: OffscreenCanvasRenderingContext2D) => void): void {
    if (!this.clip) {
      draw(this.ctx);
      return;
    }
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(this.clip.x, this.clip.y, this.clip.w, this.clip.h);
    this.ctx.clip();
    draw(this.ctx);
    this.ctx.restore();
  }

  drawSprite(img: ImageBitmap, x: number, y: number, flip: boolean): void {
    const px = x + this.dx;
    const py = y + this.dy;
    this.withClip((ctx) => {
      if (!flip) {
        ctx.drawImage(img, px, py);
        return;
      }
      // Horizontal mirror about the sprite's own box (grDrawSpriteFlip).
      ctx.save();
      ctx.translate(px + img.width, py);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    });
  }

  drawLine(x1: number, y1: number, x2: number, y2: number, color: string): void {
    // Axis-aligned 1px lines are drawn as a fillRect, not a stroke. Canvas
    // antialiases stroke ENDPOINTS even on a perfectly vertical/horizontal path
    // — the engine (GL_LINES) does not — which left half-intensity pixels at
    // each end of the fishing line (FISHING:5 differed from the oracle by
    // exactly 2 px: one 106 = 212/2, one alpha=127). fillRect is exact.
    const ax = x1 + this.dx,
      ay = y1 + this.dy,
      bx = x2 + this.dx,
      by = y2 + this.dy;
    this.withClip((ctx) => {
      if (ax === bx || ay === by) {
        // The span EXCLUDES the far endpoint: GL_LINES (rl.DrawLineV, what the
        // engine uses) is a half-open primitive, so `LINE 611,246-611,293`
        // covers rows 246..292. Using |delta|+1 painted row 293 too and left a
        // single stray pixel past the end of the fishing line.
        ctx.fillStyle = color;
        const x = Math.min(ax, bx),
          y = Math.min(ay, by);
        const w = Math.abs(bx - ax),
          h = Math.abs(by - ay);
        ctx.fillRect(x, y, w === 0 ? 1 : w, h === 0 ? 1 : h);
        return;
      }
      // Diagonals are rasterized with Bresenham, one exact pixel at a time,
      // rather than stroked. A Canvas stroke ANTIALIASES a diagonal — partial
      // coverage on both sides of the ideal line — while the engine's GL_LINES
      // picks a single hard pixel per step. Stroking left ~340 fractional-alpha
      // pixels along the fishing line in FISHING:4/7/8 (alphas like 83/126/171
      // where the oracle has either 0 or 255). Same half-open convention as the
      // axis-aligned case above: the far endpoint is excluded.
      ctx.fillStyle = color;
      let x = ax,
        y = ay;
      const dx = Math.abs(bx - ax),
        dy = -Math.abs(by - ay);
      const sx = ax < bx ? 1 : -1,
        sy = ay < by ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        if (x === bx && y === by) break; // half-open: stop before the endpoint
        ctx.fillRect(x, y, 1, 1);
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y += sy;
        }
      }
    });
  }

  drawRect(x: number, y: number, w: number, h: number, color: string): void {
    this.withClip((ctx) => {
      ctx.fillStyle = color;
      ctx.fillRect(x + this.dx, y + this.dy, w, h);
    });
  }

  drawCircle(x: number, y: number, w: number, _h: number, fill: string, stroke: string | null): void {
    // Box (x,y,w,h) with w==h (only true circles supported); center (x+r, y+r).
    const r = w / 2;
    const cx = x + this.dx + r;
    const cy = y + this.dy + r;
    // Rasterized span-by-span rather than drawn with arc()+fill.
    //
    // Canvas antialiases an arc, the engine (rl.DrawCircle, a triangle fan) does
    // not — JOHNNY:3/4/5's rising bubbles differed by ~380 px of fractional
    // alpha. Filling integer spans per row reproduces the engine's hard edges.
    //
    // Span rule: a row is filled where the pixel centre falls inside the circle,
    // which matches raylib exactly except at the very top and bottom rows, where
    // its polygon overshoots the true circle by one pixel each side — replicated
    // by `cap` below (measured against the engine's own output, not guessed).
    this.withClip((ctx) => {
      ctx.fillStyle = fill;
      const y0 = Math.floor(cy - r),
        y1 = Math.ceil(cy + r);
      for (let py = y0; py < y1; py++) {
        const dy = py + 0.5 - cy;
        if (Math.abs(dy) > r) continue;
        const half = Math.sqrt(r * r - dy * dy);
        let left = Math.floor(cx - half);
        let right = Math.ceil(cx + half) - 1;
        // Cap rows: the fan's flat top/bottom edge covers one extra pixel each
        // side of the analytic span.
        const cap = r - Math.abs(dy) < 1;
        if (cap) {
          left -= 1;
          right += 1;
        }
        if (right >= left) ctx.fillRect(left, py, right - left + 1, 1);
      }
      if (stroke) {
        // The outline (rl.DrawCircleLines) is a 1px polygon on the same span
        // boundaries; approximate it by stroking the extremes of each row.
        ctx.fillStyle = stroke;
        for (let py = y0; py < y1; py++) {
          const dy = py + 0.5 - cy;
          if (Math.abs(dy) > r) continue;
          const half = Math.sqrt(r * r - dy * dy);
          const left = Math.floor(cx - half),
            right = Math.ceil(cx + half) - 1;
          if (right >= left) {
            ctx.fillRect(left, py, 1, 1);
            ctx.fillRect(right, py, 1, 1);
          }
        }
      }
    });
  }

  drawPixel(x: number, y: number, color: string): void {
    this.withClip((ctx) => {
      ctx.fillStyle = color;
      ctx.fillRect(x + this.dx, y + this.dy, 1, 1);
    });
  }
}

// Canvas2DRenderer composites a persistent background plus an ordered stack of
// layers onto the visible canvas.
export class Canvas2DRenderer implements Renderer {
  readonly width = W;
  readonly height = H;

  private readonly out: CanvasRenderingContext2D;
  // Offscreen back buffer: the whole frame is composed here, then blitted to the
  // visible canvas in ONE drawImage. A single blit presents atomically, so the
  // viewer never catches an intermediate state (black-fill → bg → layers) — that
  // per-operation exposure is a classic single-buffer canvas tear/blink on some
  // GPUs. (My software-rendered test capture couldn't reproduce it; this is the
  // defensive fix.)
  private readonly buf: OffscreenCanvas;
  private readonly bufCtx: OffscreenCanvasRenderingContext2D;
  private background: ImageBitmap | null = null;
  // The fixed compositor slots (see Slot in renderer.ts), each created on first
  // use and each with a permanent place in the stack. Only `layers` below is a
  // dynamic array. Slots survive resetLayers() — the island and clouds outlive
  // the scenes drawn on them, exactly as in the engine.
  private slots = new Map<Slot, Canvas2DLayer>();
  private layers: Canvas2DLayer[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.out = ctx;
    this.out.imageSmoothingEnabled = false;

    this.buf = new OffscreenCanvas(W, H);
    const bctx = this.buf.getContext("2d");
    if (!bctx) throw new Error("offscreen 2d context unavailable");
    this.bufCtx = bctx;
    this.bufCtx.imageSmoothingEnabled = false;
  }

  setBackground(img: ImageBitmap | null): void {
    this.background = img;
  }

  slot(name: Slot): Layer {
    let layer = this.slots.get(name);
    if (!layer) {
      layer = new Canvas2DLayer();
      this.slots.set(name, layer);
    }
    return layer;
  }

  clearSlot(name: Slot): void {
    this.slots.delete(name);
  }

  hasSlot(name: Slot): boolean {
    return this.slots.has(name);
  }

  newLayer(): Layer {
    const layer = new Canvas2DLayer();
    this.layers.push(layer);
    return layer;
  }

  // Drops the SCENE layers only (slot 4). The fixed slots are deliberately
  // untouched: the island and the clouds outlive every scene drawn on them, and
  // in the engine only adsReleaseIsland takes them down. (An earlier version
  // cleared the saved zones here too; that is the interpreter's job — a scene's
  // own LOAD_SCREEN / RESTORE_ZONE releases them, since baked scenery is bound
  // to the screen it was baked against.)
  resetLayers(): void {
    this.layers = [];
  }

  removeLayer(layer: Layer): void {
    const i = this.layers.indexOf(layer as Canvas2DLayer);
    if (i >= 0) this.layers.splice(i, 1);
  }

  orderLayers(order: Layer[]): void {
    // Reorder in place — the layers KEEP their pixels. Any layer not named in
    // `order` is dropped (its thread is gone).
    this.layers = order.filter((l): l is Canvas2DLayer => this.layers.includes(l as Canvas2DLayer));
  }

  bakeZone(from: Layer, x: number, y: number, w: number, h: number): void {
    // The source pixels live at (x+dx, y+dy) in the layer's canvas; copy that
    // same rect to the same place on the saved-zones layer. +2 width matches
    // grCopyZoneToBg's rounding fudge for a 2px hull gap in the original data.
    const { dx, dy } = from.origin;
    const src = (from as Canvas2DLayer).canvas;
    (this.slot("savedZones") as Canvas2DLayer).blitFrom(src, x + dx, y + dy, w + 2, h);
  }

  // presentLayersOnly composites the saved-zones + thread layers WITHOUT the
  // background, over transparency — the pixel oracle's reference format (see
  // main.ts __shots). The Go side captures the same way, so the two images
  // compare directly without the island backdrop (baked here, procedurally
  // drawn and animated there) swamping the diff.
  // Compositor introspection for tools/oracle-diff/cloudorder.py, which is the
  // ONLY check that can see slot ORDER. The frame digest reports L=[...], the
  // scene threads — clouds are slot 2 and never appear there, so no text oracle
  // covers this. The probe reads the slots and the scene layers, finds pixels
  // where a cloud and a scene overlap, and asks who won on screen; one image
  // cannot answer that, because a cloud over open sea looks identical either
  // way. Cheap accessors, no behaviour.
  __slotCanvas(name: Slot): OffscreenCanvas | null {
    return this.slots.get(name)?.canvas ?? null;
  }
  __layerCanvases(): OffscreenCanvas[] {
    return this.layers.map((l) => l.canvas);
  }

  // blitSlot draws a fixed slot into the back buffer if it exists.
  private blitSlot(name: Slot): void {
    const layer = this.slots.get(name);
    if (layer) this.bufCtx.drawImage(layer.canvas, 0, 0);
  }

  presentLayersOnly(): void {
    const b = this.bufCtx;
    b.clearRect(0, 0, this.width, this.height);
    // Slots 1 and 2 (island, clouds) are deliberately omitted — graphics.go:850
    // skips exactly those under traceShots, for the same reason.
    this.blitSlot("savedZones");
    for (const layer of this.layers) b.drawImage(layer.canvas, 0, 0);
    this.blitSlot("holiday");
    this.out.clearRect(0, 0, this.width, this.height);
    this.out.drawImage(this.buf, 0, 0);
  }

  // present composites the engine's five-slot stack, in grUpdateDisplay's order
  // (graphics.go:672). The order is fixed here rather than implied by layer
  // creation order — see the Slot comment in renderer.ts.
  present(): void {
    const b = this.bufCtx;
    // 1. Background surface. Black fill first: backdrops are often shorter than
    // 480 (ISLETEMP.SCR is 640x350) and must be drawn 1:1, top-left aligned —
    // NOT stretched to fill (grLoadScreen: ClearBackground black then
    // DrawTexture at y=0 native size; stretching decoupled sprites from the
    // baked shoreline and put Johnny "on water").
    b.fillStyle = "#000";
    b.fillRect(0, 0, this.width, this.height);
    if (this.background) b.drawImage(this.background, 0, 0);
    // The island (grBackgroundSur) paints over the ocean backdrop.
    this.blitSlot("island");
    // 2. Clouds: above the island, BELOW the saved zones and every scene.
    this.blitSlot("clouds");
    // 3. Saved zones: baked scenery that outlives the thread that drew it.
    this.blitSlot("savedZones");
    // 4. The scene threads, in ADS slot order.
    for (const layer of this.layers) b.drawImage(layer.canvas, 0, 0);
    // 5. Holiday decorations, composited after every scene thread so the
    // Christmas tree is never hidden behind Johnny.
    this.blitSlot("holiday");
    // Single atomic blit to the visible canvas.
    this.out.drawImage(this.buf, 0, 0);
  }
}
