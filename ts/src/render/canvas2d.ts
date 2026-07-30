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

  setBackground(img: ImageBitmap | null): void {
    this.background = img;
  }

  clearScreen(): void {
    this.layerCtx.clearRect(0, 0, this.width, this.height);
  }

  drawSprite(img: ImageBitmap, x: number, y: number, flip: boolean): void {
    if (!flip) {
      this.layerCtx.drawImage(img, x, y);
      return;
    }
    // Horizontal mirror about the sprite's own box, matching grDrawSpriteFlip
    // (negative-width source rect in raylib).
    this.layerCtx.save();
    this.layerCtx.translate(x + img.width, y);
    this.layerCtx.scale(-1, 1);
    this.layerCtx.drawImage(img, 0, 0);
    this.layerCtx.restore();
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
