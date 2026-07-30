# Johnny Castaway — TypeScript / Vite port

A port of the screensaver's animation player to TypeScript + Vite, rendering to
Canvas2D. **Self-contained**: everything the port needs — the app, its own asset
extractor, and its build — lives under this `ts/` directory. The only thing it
reaches outside for is the (git-ignored, copyright) game data in the repo-root
`assets/`, shared with the Go build.

**Experimental** — plays a single TTM script (default `MJJOG.TTM`) entered at one
scene tag, not the full ADS scene scheduler.

## Layout

```
ts/
  src/
    ttm/opcodes.ts      TTM opcode constants (from ttm.go)
    ttm/interpreter.ts  single-thread TTM interpreter (port of ttmPlay + the
                        ADS main-loop timing model, ttm.go / ads.go)
    render/renderer.ts  backend-agnostic Renderer interface (the Pixi-swap seam)
    render/canvas2d.ts  Canvas2D implementation (background + sprite layer)
    manifest.ts         loads manifest.json + sprite PNGs as ImageBitmaps
    main.ts             rAF loop driving the interpreter at ~30 ticks/sec
  tools/tsextract/      Go asset extractor (its own module; see below)
  public/anim/          extracted assets (git-ignored, regenerated)
```

The interpreter works in the original 640×480 virtual space; the renderer maps
it onto the canvas. Widescreen scaling, clip zones, and multi-thread scenes from
the Go engine are intentionally out of scope.

## Game data

The app consumes pre-extracted assets in `public/anim/` (git-ignored — same
copyright reasons as the root `assets/`). Regenerate them with the bundled
extractor (run from `ts/`):

```sh
npm run extract                        # default MJJOG.TTM → public/anim
npm run extract -- -ttm SHARK1.TTM     # any other TTM (pass -- then flags)
```

`tools/tsextract` is a stdlib-only, raylib-free Go module — a port of the repo's
resource pipeline (RESOURCE.MAP/001 parse → LZW/RLE decompress → 4bpp+palette
decode). It reads `../assets/RESOURCE.{MAP,001}` and writes one PNG per sprite
cel, the LOAD_SCREEN backdrop, and a `manifest.json` holding the decoded TTM
opcode stream, so the TS side does no binary parsing. Requires a Go toolchain.

(Note: `FIRE.TTM` is a dead/orphaned script — it references BMPs not present in
the data; the working fireplace is `MJFIRE.TTM`. See the repo `INSIGHTS.md`.)

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc typecheck + vite production build → dist/
```

Pick a scene entry point with `?tag=<n>` (the tag list is shown in the on-page
HUD); default is the TTM's first tag.
