# Insights

Hard facts and non-obvious learnings for future work on this repo. Not a
changelog — only things that will save time or prevent repeating mistakes.

## Build / platform

- **`go run *.go` breaks build tags.** It passes every file explicitly, so
  build constraints (`//go:build windows`) are ignored and Windows-only files
  compile everywhere. Use `go run .` / `go build .` (package mode). The
  Makefile `run`/`ttm` targets already do.
- **A stray `import "C"` with no cgo body still forces cgo.** `graphics.go` had
  one; under `CGO_ENABLED=0` (js/wasm) it silently excluded the whole file and
  cascaded "undefined type" errors everywhere. If a whole-file "undefined"
  cascade appears on a wasm build, look for an `import "C"`.
- **Windows-only APIs in shared files:** `GetAsyncKeyState`/`user32.dll` (global
  hotkeys) and `syscall.NewLazyDLL` are split into `graphics_windows.go` /
  `graphics_other.go`. `gpu.go` is `//go:build windows` (cgo `windows.h`);
  `gpu_stub.go` is the rest.

## Linux / Wayland (desktop)

- **Wayland is refused for programmatic window resize/position.** GLFW logs
  "The platform does not support setting the window position/size". This made
  the borderless screensaver window stay 640x480 while monitors reported huge
  sizes → scene drawn off-screen (black). `setupMonitors()` now falls back to a
  single full-window rect when the real render surface != requested span.
- **`preferX11Backend()` (`platform_linux.go`) re-execs with
  `XDG_SESSION_TYPE=x11`** to force GLFW's X11/XWayland backend over native
  Wayland (native Wayland presentation was unreliable). Guarded against exec
  loops; honors `JOHNNY_FORCE_WAYLAND`. Env changes from Go don't reach the C
  GLFW unless done before InitWindow / via re-exec.
- Runs on WSLg via LLVMpipe software GL (no hardware/Vulkan GL in that session).

## WebAssembly (browser) — the fork and its quirks

- **Fork:** `Searle/Raylib-Go-Wasm` (our fork of BrownNPC/…), pinned commit
  `9ae8b5bb90ca59cc319e9ce6b123c0c29b0588da`. Pure-Go raylib bindings calling a
  **prebuilt emscripten `index/rl/raylib.wasm` blob** (WebGL1) — we don't build
  that blob. **No emscripten on our side.**
- Build: `GOOS=js GOARCH=wasm go build -modfile=go.wasm.mod -o main.wasm .`
  The overlay `go.wasm.mod` swaps in the fork via `replace`; desktop `go.mod`
  untouched. `go.wasm.mod` needs **go 1.26.1**. Source `import` paths are
  unchanged (fork keeps the `github.com/gen2brain/raylib-go/raylib` path).
- **Context is WebGL1 / GLSL ES 1.00** (`getContext("webgl")`, hardcoded
  `majorVersion:1` in raylib.js — no webgl2 path). Not WebGL2.
- **The fork's FFI cannot marshal Go slices.** `LoadWaveFromMemory([]byte)`,
  `SetShaderValue([]float32)`, `UnloadImage`/`ImageDrawPixel` all panic
  `ValueOf: invalid value`. Only funcs that internally use `CopySliceToC`
  (e.g. `LoadImageFromMemory`, `LoadSound`) accept slice-backed data safely.
  Prefer those; avoid raw-slice FFI calls.
- **`NewImageFromImage` uploads ONE PIXEL AT A TIME** (per-pixel
  `ImageDrawPixel` FFI). ~300k calls for a full-screen image → leaks wasm
  memory faster than GC → "runtime: cannot allocate memory" once the story loop
  reloads sprites. Fix (in `image_compat_js.go`): encode RGBA→PNG in Go, call
  `LoadImageFromMemory(".png", …)` once.
- **No MSAA on web.** `FlagMsaa4xHint` makes raylib request an antialiased
  WebGL context that fails to create on real GPUs → "GLFW: Failed to initialize
  Window" / "bindTexture on undefined" crash at InitWindow. Web InitWindow path
  uses no MSAA and no desktop-only window flags.
- **Custom shaders don't render on this fork.** They compile+link (after
  ES-1.00 translation in `shader_js.go`), but `BeginShaderMode`+`DrawTexturePro`
  draws nothing (verified with a solid-color repro). `graphicsInit` forces
  `FilterMode=0`/no scanlines on web. Fork limitation, not our GLSL.
- **Main-loop inversion:** the story engine runs in a goroutine; it yields one
  frame per rAF tick via a size-1 channel (`frameloop_js.go`). `WindowShouldClose`
  PANICS on web — skipped via the `isWeb` constant
  (`buildinfo_{js,other}.go`). `SetMainLoop` owns the rAF loop and blocks the
  main goroutine forever (yields to scheduler).
- **Audio:** browsers block autoplay until a user gesture; `web/index.js`
  tracks AudioContexts and resumes on first pointer/key. Sounds before the
  first interaction are dropped (unavoidable).
- **Canvas sizing:** pure CSS via a `#stage` wrapper + `object-fit: contain`
  (`web/index.html`). Do NOT drive canvas size from JS (`style.width/height`
  polling) — it fought emscripten and collapsed the backing to 1x1. Backing
  stays 640x480; CSS only scales display.

## Testing the wasm build (important — avoids chasing ghosts)

- Playwright via `uv run --with playwright python …` is the reliable harness
  (Chromium cached). Headless Edge `--screenshot` FAILS on a rAF page (never
  signals load-complete) and its CDP port isn't reachable from WSL.
- Playwright in WSL only ever gets **SwiftShader** (software WebGL), even with
  GPU flags. It **cannot reproduce hardware-GPU browser failures.** The user's
  real Chrome is the only oracle for those.
- **Don't judge "stuck/black" from a single screenshot** — you'll catch iris
  transitions or rAF-throttle frames. Capture several timepoints and compare
  MD5s (N distinct = animating). A single all-black frame is usually a
  transition or a harness artifact, not a real bug.
- A browser with WebGL disabled (e.g. Chrome after GPU-process crashes: see
  `chrome://gpu`) shows the friendly "WebGL not available" message from
  `web/index.js`, not a crash.

## RESOURCE.001 extraction (copyright-clean)

- Game data is NEVER committed. `assets/` is gitignored. `tools/extract`
  (Go, needs system `7z`) downloads the archive.org Screen Antics disk,
  extracts the FAT12 floppy, and decompresses `RESOURCE.00$`.
- `RESOURCE.00$` is **InstallShield-Z / PKWARE implode**; `tools/extract/blast.go`
  is a Go port of Mark Adler's blast.c. The DCL stream starts just past the
  embedded "RESOURCE.001" name — the extractor scans a small window for the
  valid implode header and validates against MD5.
- MD5s: `RESOURCE.MAP` = `374e6d05c5e0acd88fb5af748948c899`,
  `RESOURCE.001` = `8bb6c99e9129806b5089a39d24228a36`. `RESOURCE.001` on the
  disk itself is a 35-byte stub; the real data is only in `RESOURCE.00$`.

## Backdrops (SCR) are top-aligned at native size, never stretched

- Scene backdrops are **not all 640×480**. `ISLETEMP.SCR` (the island backdrop
  ~31 of 40 TTMs `LOAD_SCREEN`) is **640×350**; `SUZBEACH.SCR` is 640×480. The
  engine (`grLoadScreen`) clears the target to **black**, then draws the SCR at
  its **native size, top-left (y=0)** — the area below a short backdrop stays
  black (the screensaver shows the desktop there). It is NEVER scaled to fill.
- Scene sprite coordinates are authored against that top-aligned backdrop. If a
  renderer stretches a 350-tall backdrop to 480 (e.g. Canvas `drawImage(bg,0,0,
  W,H)`), the baked shoreline moves down ~1.37× while sprites stay at unscaled
  coords → characters float "on the water." This bit the TS port; fix was to
  draw the background 1:1 top-aligned over a black fill.
- The island itself sits at trunk x≈450 both in ISLETEMP and in the Go
  `islandInit` sprite build (trunk sprite raw x=442) — the two island systems
  agree horizontally, so horizontal drift is usually a positioning bug, vertical
  drift is usually the stretch bug above.

## Island positioning (grDx/grDy) — sprites and backdrop always share it

- A scene's sprite offset and the island backdrop offset are ALWAYS the same
  `grDx`, so Johnny stays on the island wherever it's placed. `main.go`:
  `ttmDx = islandState.xPos + (LEFT_ISLAND ? 272 : 0)`. VARPOS scenes get a
  negative random `xPos` (~ -114..-222) applied to BOTH; LEFT_ISLAND scenes net
  to `-272 + 272 = 0`; plain scenes are 0. So the net sprite offset is 0 for
  LEFT_ISLAND/plain, and a shared negative shift for VARPOS.
- Consequence for a static-backdrop port (can't reposition the baked island):
  the only offset that keeps sprites aligned is **grDx = 0**. Do NOT add +272
  for "date" scenes — SMDATE's MARY.ADS entry (tag 1/24) is VARPOS, not
  LEFT_ISLAND, and LEFT_ISLAND nets to 0 anyway. Correct VARPOS positioning
  needs the story calendar (`story.go`) AND redrawing the island at the chosen
  xPos, not the baked ISLETEMP.

## ADS scheduling — two gotchas that cause runaway/endless scenes

- **PURGE ends an ADS scene; it loops a standalone one.** A TTM tag that ends in
  PURGE (with no sceneTimer) means "scene done" → `isRunning=2`, and the ADS
  fires the next scene's triggered chunk. If a port instead makes PURGE loop
  back to the previous tag (fine for viewing ONE scene), an ADS-driven scene
  loops forever and the script never advances — "one animation repeats endlessly".
- **Triggered chunks (IF_LASTPLAYED bookmarks) MUST be scoped to the played
  entry tag.** `adsLoad` enables bookmarking only inside the requested tag's
  region — every OTHER `:TAG` marker turns it back off. Bookmarking across the
  whole file lets a completed scene match chunks belonging to unrelated entry
  sequences (different tags, even different TTM slots), spawning an exponential
  pile of concurrent scenes. Correctly scoped, the count stays ~1-2.
- OR-chained `IF_LASTPLAYED` guards share ONE body (a following RANDOM block):
  bookmark each guarded (slot,tag) pointing at the same body, so any of them
  completing fires that body. This is the intended self-sustaining idle loop —
  bounded to one live scene because each completion replaces the previous.
- A standalone script (e.g. FISHING.ADS) legitimately terminates at its own
  `FADE_OUT`/`END`; in the real screensaver JOHNNY.ADS (the top-level loop)
  would then start a new random activity. Not ported here, so a script ending
  is expected, not a bug.

## Data quirks / dead references

- **`FIRE.TTM` is an orphaned/prototype script — do not try to render it.** It
  `LOAD_IMAGE`s `FLAME.BMP` and `FLURRY.BMP`, neither of which exists in
  `RESOURCE.001` (the `FLAME.BMP` string appears *only* inside FIRE.TTM's own
  bytecode; no BMP resource, no MAP entry). Nothing — no ADS script, no Go
  code — ever invokes `FIRE.TTM`. The fireplace you actually see is
  **`MJFIRE.TTM`** (played via `adsPlaySingleTtm("MJFIRE.TTM")`, main.go),
  which draws the six present `FIRE*.BMP` (`FIRE`, `FIRE1`–`FIRE5`). Conclusion:
  the art was renamed `FLAME→FIRE` before release and the old TTM was left in
  the data. Skip FIRE.TTM in any batch extraction; it's original-data cruft,
  confirmed present byte-identically in the Win32 build too.

- **The Win32 `Screen Antics.scr` ships our exact game data — no better art.**
  The redistributed installer (`johnnycastaway.exe`, NSIS) contains
  `Screen Antics.scr`, a UPX-packed Delphi/Borland Win32 PE. After `upx -d`, it
  embeds `RESOURCE.MAP` and `RESOURCE.001` **verbatim, byte-for-byte identical
  to ours** (16-color 4bpp, 640×480, magenta `0xa8,0x00,0xa8` key). No
  `RESOURCE.002+`, no hi-color assets — the only extra bitmap is a 48×48 24bpp
  app icon. So the Win32 port differs from ours only in engine, not assets;
  there is nothing prettier to recover. (Static extraction only — the untrusted
  exe was never executed; it's Win32, so DOSBox wouldn't run it regardless.)

## CI / Pages

- `.github/workflows/pages.yml` builds wasm + deploys to Pages on push to
  `linux-and-wasm` (branch was renamed from `dev`). Fork cloned at the pinned
  commit; assets extracted (cached); site = fork `index/` + `web/` overlay +
  Go's `wasm_exec.js`.
- **GitHub Pages `github-pages` environment restricts deploy branches by
  default** (default branch only). Non-default branches need adding under
  Settings → Environments → github-pages, or "No restriction", else deploy is
  rejected (build still succeeds).
- This is a fork-of-a-fork: original author (inactive) → `fbreve` (active
  Windows enhancements, our base) → `Searle` (this work). Push target is
  `Searle/Johnny-Castaway-Enhanced`; upstream `origin` is `fbreve`.
