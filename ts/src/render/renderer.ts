// The render backend is split into a compositor (Renderer) and per-thread draw
// surfaces (Layer). This mirrors the Go engine: a persistent background plus one
// render-texture per running TTM thread, composited in order. It keeps the TTM
// interpreter backend-agnostic — a WebGL/Pixi implementation can replace both
// without touching the interpreter.
//
// Coordinates are the original 640x480 virtual space. The interpreter never
// scales; the backend maps virtual space onto the real canvas.

// A Layer is one TTM thread's transparent drawing surface. CLEAR_SCREEN wipes
// it; the compositor stacks layers over the background in creation order.
export interface Layer {
  // Wipe this layer to transparent (TTM CLEAR_SCREEN).
  clear(): void;

  // Blit a sprite at (x, y), optionally horizontally flipped
  // (DRAW_SPRITE / DRAW_SPRITE_FLIP).
  drawSprite(img: ImageBitmap, x: number, y: number, flip: boolean): void;

  // Primitives (DRAW_LINE / DRAW_RECT / DRAW_CIRCLE / DRAW_PIXEL). Colors are
  // CSS strings resolved from the palette by the interpreter.
  drawLine(x1: number, y1: number, x2: number, y2: number, color: string): void;
  drawRect(x: number, y: number, w: number, h: number, color: string): void;
  // Filled circle with `fill`, optional 1px `stroke` outline. Box is (x,y,w,h),
  // shape centered in it (grDrawCircle).
  drawCircle(x: number, y: number, w: number, h: number, fill: string, stroke: string | null): void;
  drawPixel(x: number, y: number, color: string): void;

  // Restrict subsequent drawing to a rectangle (SET_CLIP_ZONE); null clears it.
  setClip(x: number, y: number, w: number, h: number): void;
  clearClip(): void;

  // grDx/grDy: a per-thread translation applied to every draw on this layer.
  // The ADS/story layer sets it to position a scene on the island (the offset
  // SMDATE and other positioned scenes need); 0 for plain scenes.
  setOrigin(dx: number, dy: number): void;

  // The layer's current origin (grDx, grDy), so the compositor can translate a
  // COPY_ZONE_TO_BG rect into the layer's pixel space.
  readonly origin: { dx: number; dy: number };
}

export interface Renderer {
  readonly width: number;
  readonly height: number;

  // Replace the background (LOAD_SCREEN backdrop); null clears to black. The
  // background persists across CLEAR_SCREEN and layer changes.
  setBackground(img: ImageBitmap | null): void;

  // Create a fresh transparent layer stacked above all existing layers.
  newLayer(): Layer;

  // Remove every layer (e.g. when switching scenes/scripts).
  resetLayers(): void;

  // Drop a single layer (its thread stopped — grFreeLayer).
  removeLayer(layer: Layer): void;

  // Set the compositing order WITHOUT disturbing any layer's contents. The ADS
  // scheduler composites by thread-slot index (Go iterates its fixed array
  // 0→N), but a layer's pixels must survive a reorder: in the engine each
  // thread's render texture is created once by grNewLayer and only that
  // thread's own CLEAR_SCREEN wipes it. Rebuilding all layers on every
  // add/stop (the earlier approach) blanked every OTHER running scene until it
  // happened to redraw — e.g. ACTIVITY.ADS tag 12, where the seagull scene
  // starting made Johnny disappear for one frame.
  orderLayers(order: Layer[]): void;

  // COPY_ZONE_TO_BG: bake a rectangle of `from`'s rendered pixels into the
  // persistent "saved zones" layer (grCopyZoneToBg → grSavedZonesLayer), which
  // composites above the background but below active thread layers — so scenery
  // a scene builds (sandcastle, passing tanker) stays after the thread ends.
  // (x, y, w, h) are in the scene's virtual space; the layer's origin is added.
  bakeZone(from: Layer, x: number, y: number, w: number, h: number): void;

  // Clear the persistent saved-zones layer (RESTORE_ZONE / new script).
  clearSavedZones(): void;

  // Composite background + saved zones + all layers (in order) onto the canvas.
  present(): void;
}
