# Johnny Castaway — TypeScript / Vite port

A port of the screensaver's animation player to TypeScript + Vite, rendering to
Canvas2D. **Self-contained**: everything the port needs — the app, its own asset
extractor, and its build — lives under this `ts/` directory. The only thing it
reaches outside for is the (git-ignored, copyright) game data in the repo-root
`assets/`, shared with the Go build.

**Experimental.** Two modes (toggle in the UI):
- **TTM scene** — play a single animation script at a chosen scene tag.
- **ADS script** — run a whole scene-director script (MARY, FISHING, WALKSTUF…):
  it auto-sequences scenes, runs concurrent threads (boat + Johnny), and picks
  scenes via the ADS random/conditional logic.

Not yet ported: JOHNNY.ADS's top-level idle loop, and the full story calendar
that supplies exact island positions (so a few positioned "story" scenes — e.g.
SMDATE via MARY.ADS — are offset but not pixel-perfectly placed).

## Layout

```
ts/
  src/
    ttm/opcodes.ts      TTM opcode constants (from ttm.go)
    ttm/interpreter.ts  TTM interpreter / one scene thread (port of ttmPlay)
    ads/opcodes.ts      ADS opcode constants (from ads.go)
    ads/scheduler.ts    ADS scene-director: ADD/STOP/RANDOM/conditionals, the
                        multi-thread main loop, triggered chunks (port of ads.go)
    ads/positioning.ts  per-scene grDx/grDy island offset (story layer)
    render/renderer.ts  Renderer + Layer interfaces (the Pixi-swap seam)
    render/canvas2d.ts  Canvas2D compositor: background + one layer per thread
    manifest.ts         loads manifest.json / ads.json + PNGs as ImageBitmaps
    main.ts             mode toggle + dropdowns + the ~30 ticks/sec render loop
  tools/tsextract/      Go asset extractor (its own module; see below)
  public/anim/          extracted assets (git-ignored, regenerated)
    <TTM>/              per-TTM sprites + manifest.json
    ads/<ADS>/ads.json  per-ADS slot map + decoded bytecode
    index.json          catalog of TTMs and ADS scripts
```

The interpreter works in the original 640×480 virtual space; the renderer maps
it onto the canvas. It handles sprites (+ flip), the primitives
(line/rect/circle/pixel with `SET_COLORS`), and rectangular clip zones.
Widescreen scaling, multi-thread scenes, and the bake-to-background opcodes
(`SAVE_IMAGE`/`COPY_ZONE_TO_BG`) are still out of scope.

## Game data

The app consumes pre-extracted assets in `public/anim/` (git-ignored — same
copyright reasons as the root `assets/`). Regenerate them with the bundled
extractor (run from `ts/`):

```sh
npm run extract -- -all                # ALL TTMs → public/anim/<TTM>/ + index.json
npm run extract                        # single MJJOG.TTM → public/anim (legacy)
npm run extract -- -ttm SHARK1.TTM     # a single named TTM
```

The scene browser (the `animation` / `tag` dropdowns in the app) needs the
`-all` extraction — it reads `public/anim/index.json` to list every animation
and its scene tags.

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
npm run extract -- -all   # one-time: build the asset catalog the browser needs
npm run dev               # http://localhost:5173
npm run build             # tsc typecheck + vite production build → dist/
```

Use the mode toggle + dropdowns to pick a TTM scene or an ADS script. Deep-link
with `?anim=MJJOG.TTM&tag=1` (TTM) or `?ads=FISHING.ADS&tag=1` (ADS).
