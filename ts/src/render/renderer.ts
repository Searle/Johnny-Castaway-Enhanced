// Renderer is the seam that keeps the interpreter independent of the drawing
// backend. Canvas2DRenderer implements it today; a PixiRenderer (WebGL, with
// the palette-filter effects the WASM fork couldn't do) can slot in later
// without touching the TTM interpreter.
//
// Coordinates are the original 640x480 virtual space. The interpreter never
// scales; the backend maps virtual space onto the real canvas.

export interface Renderer {
  readonly width: number;
  readonly height: number;

  // Replace the background (the LOAD_SCREEN backdrop). Passing null clears it
  // to black. The background persists across CLEAR_SCREEN.
  setBackground(img: ImageBitmap | null): void;

  // Wipe the sprite layer back to the background (TTM CLEAR_SCREEN).
  clearScreen(): void;

  // Blit a sprite at (x, y) in virtual space, optionally horizontally flipped
  // (DRAW_SPRITE / DRAW_SPRITE_FLIP).
  drawSprite(img: ImageBitmap, x: number, y: number, flip: boolean): void;

  // Primitive shapes (DRAW_LINE / DRAW_RECT / DRAW_CIRCLE / DRAW_PIXEL). Colors
  // are CSS strings resolved from the palette by the interpreter.
  drawLine(x1: number, y1: number, x2: number, y2: number, color: string): void;
  drawRect(x: number, y: number, w: number, h: number, color: string): void;
  // Filled ellipse with `fill`, optional 1px `stroke` outline (grDrawCircle).
  // The TTM box is (x, y, w, h); the shape is centered in it.
  drawCircle(x: number, y: number, w: number, h: number, fill: string, stroke: string | null): void;
  drawPixel(x: number, y: number, color: string): void;

  // Restrict subsequent sprite-layer drawing to a rectangle (SET_CLIP_ZONE).
  // Passing null clears the clip (full-screen reset).
  setClip(x: number, y: number, w: number, h: number): void;
  clearClip(): void;

  // Composite background + sprite layer onto the visible canvas.
  present(): void;
}
