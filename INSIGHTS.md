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
