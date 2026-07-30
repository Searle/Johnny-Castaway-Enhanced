import type { Renderer } from "./renderer";

// Canvas2DRenderer draws in 640x480 virtual space onto an offscreen sprite
// layer, then composites background + sprites onto the visible canvas. This
// mirrors the Go engine's model: a persistent background surface plus a TTM
// layer that CLEAR_SCREEN wipes.
export class Canvas2DRenderer implements Renderer {
  readonly width = 640;
  readonly height = 480;

  private readonly out: CanvasRenderingContext2D;
  // Sprite layer: transparent over the background, wiped by clearScreen().
  private readonly layer: OffscreenCanvas;
  private readonly layerCtx: OffscreenCanvasRenderingContext2D;
  private background: ImageBitmap | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.out = ctx;
    this.out.imageSmoothingEnabled = false;

    this.layer = new OffscreenCanvas(this.width, this.height);
    const lctx = this.layer.getContext("2d");
    if (!lctx) throw new Error("offscreen 2d context unavailable");
    this.layerCtx = lctx;
    this.layerCtx.imageSmoothingEnabled = false;
  }

  // Active clip rect in virtual space, or null for none. Reapplied around every
  // layer draw (Canvas2D clip() is bound to the current save/restore scope, so
  // we can't hold it open across calls the way raylib's scissor mode does).
  private clip: { x: number; y: number; w: number; h: number } | null = null;

  setBackground(img: ImageBitmap | null): void {
    this.background = img;
  }

  clearScreen(): void {
    this.layerCtx.clearRect(0, 0, this.width, this.height);
  }

  setClip(x: number, y: number, w: number, h: number): void {
    this.clip = { x, y, w, h };
  }

  clearClip(): void {
    this.clip = null;
  }

  // withClip runs a draw with the current clip rect applied (if any).
  private withClip(draw: (ctx: OffscreenCanvasRenderingContext2D) => void): void {
    const ctx = this.layerCtx;
    if (!this.clip) {
      draw(ctx);
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.clip.x, this.clip.y, this.clip.w, this.clip.h);
    ctx.clip();
    draw(ctx);
    ctx.restore();
  }

  drawSprite(img: ImageBitmap, x: number, y: number, flip: boolean): void {
    this.withClip((ctx) => {
      if (!flip) {
        ctx.drawImage(img, x, y);
        return;
      }
      // Horizontal mirror about the sprite's own box, matching grDrawSpriteFlip
      // (negative-width source rect in raylib).
      ctx.save();
      ctx.translate(x + img.width, y);
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
      ctx.moveTo(x1 + 0.5, y1 + 0.5);
      ctx.lineTo(x2 + 0.5, y2 + 0.5);
      ctx.stroke();
    });
  }

  drawRect(x: number, y: number, w: number, h: number, color: string): void {
    this.withClip((ctx) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    });
  }

  drawCircle(x: number, y: number, w: number, _h: number, fill: string, stroke: string | null): void {
    // grDrawCircle: box (x,y,w,h) with w==h (only true circles supported, so h
    // is ignored); center at (x+r, y+r), radius w/2.
    const r = w / 2;
    const cx = x + r;
    const cy = y + r;
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
      ctx.fillRect(x, y, 1, 1);
    });
  }

  present(): void {
    if (this.background) {
      this.out.drawImage(this.background, 0, 0, this.width, this.height);
    } else {
      this.out.fillStyle = "#000";
      this.out.fillRect(0, 0, this.width, this.height);
    }
    this.out.drawImage(this.layer, 0, 0);
  }
}
