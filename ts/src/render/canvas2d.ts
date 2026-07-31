import type { Layer, Renderer } from "./renderer";

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
    this.withClip((ctx) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      // +0.5 to hit pixel centers so 1px lines don't blur across two rows.
      ctx.moveTo(x1 + this.dx + 0.5, y1 + this.dy + 0.5);
      ctx.lineTo(x2 + this.dx + 0.5, y2 + this.dy + 0.5);
      ctx.stroke();
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
    this.withClip((ctx) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
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
  private background: ImageBitmap | null = null;
  private layers: Canvas2DLayer[] = [];
  // Persistent "saved zones" layer (grSavedZonesLayer): scenery baked by
  // COPY_ZONE_TO_BG, composited above the background but below active layers.
  // Created lazily on first bake.
  private savedZones: Canvas2DLayer | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.out = ctx;
    this.out.imageSmoothingEnabled = false;
  }

  setBackground(img: ImageBitmap | null): void {
    this.background = img;
  }

  newLayer(): Layer {
    const layer = new Canvas2DLayer();
    this.layers.push(layer);
    return layer;
  }

  resetLayers(): void {
    this.layers = [];
    this.savedZones = null;
  }

  bakeZone(from: Layer, x: number, y: number, w: number, h: number): void {
    if (!this.savedZones) this.savedZones = new Canvas2DLayer();
    // The source pixels live at (x+dx, y+dy) in the layer's canvas; copy that
    // same rect to the same place on the saved-zones layer. +2 width matches
    // grCopyZoneToBg's rounding fudge for a 2px hull gap in the original data.
    const { dx, dy } = from.origin;
    const src = (from as Canvas2DLayer).canvas;
    this.savedZones.blitFrom(src, x + dx, y + dy, w + 2, h);
  }

  clearSavedZones(): void {
    this.savedZones = null;
  }

  present(): void {
    // Black fill first: backgrounds are often shorter than 480 (ISLETEMP.SCR is
    // 640x350) and must be drawn 1:1, top-left aligned — NOT stretched to fill.
    // grLoadScreen does exactly this (ClearBackground black, then DrawTexture at
    // y=0 at native size). Stretching decouples scene sprites, drawn at their
    // unscaled coords, from the baked shoreline — which put Johnny "on water".
    this.out.fillStyle = "#000";
    this.out.fillRect(0, 0, this.width, this.height);
    if (this.background) {
      this.out.drawImage(this.background, 0, 0);
    }
    // Saved zones sit above the background, below the active thread layers.
    if (this.savedZones) {
      this.out.drawImage(this.savedZones.canvas, 0, 0);
    }
    for (const layer of this.layers) {
      this.out.drawImage(layer.canvas, 0, 0);
    }
  }
}
