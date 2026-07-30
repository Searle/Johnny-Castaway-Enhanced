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

  // Composite background + sprite layer onto the visible canvas.
  present(): void;
}
