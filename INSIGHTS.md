# Insights

Hard facts and non-obvious learnings for future work on this repo. Not a
changelog — only things that will save time or prevent repeating mistakes.

## How to work on this repo (read this first)

Five rules, each learned the expensive way. They are about METHOD, not about the
engine, and they generalise past the parts of the codebase that produced them.

1. **Distrust a good score before you trust the code.** A lenient comparison
   (`min(len)` truncation) once faked a confident "63/66" when the truth was
   10/66 — and it invented a plausible wrong story to go with it ("cosmetic
   1-frame shift", "GPU contention"). When a metric and a symptom disagree,
   suspect the metric first.
2. **Sweep deeper than feels necessary.** 15 frames read 66/66 while two real
   bugs sat at ~19 and ~120 frames in. 30 read 66/66 while four more hid past
   it. Depth is cheap (150 frames ≈ 31s); there is no reason to run short.
3. **Audit what your harness actually covers.** "66/66 identical" meant
   sprites-only for a long time, because 18 of 30 opcodes emitted no trace line.
   *The tooling gap and the bug list turned out to be the same list.*
4. **Build the measurement that has ONE possible cause.** Every hour lost this
   project went to a measurement with several. Composited frames stack 2-3
   overlapping sprites; attributing a few pixels to one of them is guesswork.
   `blitcheck.py` (headless, no GL/browser/scheduler) answered in seconds what
   an hour of staring could not — and disproved a "fix" that had made things
   worse.
5. **Verify a hypothesis is load-bearing before building on it, and test the
   ones that say "we don't need this".** Three separate root-cause stories in
   this repo's history were confidently written down and all three were wrong
   ("63/66", "RANDOM stream desync", "alwaysOnTopThreadTags is a workaround we
   can delete"). Each was *inferred* from downstream damage rather than
   measured. Ten minutes of instrumentation beat each of them.

Corollary for the human-facing side: **the oracles cannot see everything.** Two
of the three rendering bugs found were reported by a person looking at the
screen, at a moment both sweeps read green. Run the thing and look at it.

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

## Oracle diff: compare the TS port against the Go engine (no more guessing)

### START HERE — current state and how to reproduce it

Two independent oracles. Both need a vite server on `:5199`
(`npx vite --port 5199 --strictPort`, from `ts/`) and a built `JohnnyCastaway2026`.
**Pin Playwright to 1.61.0** — plain `--with playwright` resolves to whatever is
newest and then demands an uncached browser build, and the sweep dies at launch.

| Oracle | Command (from `ts/`) | Status | Runtime |
|---|---|---|---|
| Draw calls | `uv run --with playwright==1.61.0 python tools/oracle-diff/sweep.py 150` | **66/66** | ~31s |
| Pixels | `uv run --with playwright==1.61.0 --with pillow --with numpy python tools/oracle-diff/pixels.py 60` | **53/66** | ~6m |

The draw-call oracle proves the INTERPRETER is right (same sprites, coords,
order, timing, and — since the coverage audit below — the state opcodes too). It
is structurally blind to the COMPOSITOR: layer z-order, layer lifetime and WHEN a
frame is presented are all invisible to it, which is why the pixel oracle exists.
Every rendering bug found so far passed the draw-call diff untouched.

Supporting tools, each built to answer a question the sweeps could not:
- `schedlog.py` + `JC_SCHED_LOG=1` — dump both engines' SCHEDULER DECISION
  sequences and diff those. This is what cracks scheduling bugs; see below.
- `JC_TRACE_RESOLVE=1` — adds `RESOLVED SHEET.BMP#n WxH` and `CLIP x,y wxh` per
  draw, so runtime-resolved slot indices stop being guesswork.
- `blitcheck.py` — headless single-sprite blit comparator (no GL, no browser, no
  scheduler). Answers "do the two blit rules agree?" in seconds.
- `PIXEL_OUT=/tmp/x` on `pixels.py` writes the differing frame pair out.

**The remaining 13 pixel differences are all catalogued** (see the pixel-oracle
section). None is an unknown; two classes are deliberate stopping points.

- The Go engine can emit a **canonical draw-call trace** with `-trace <ADS> <tag>
  [maxFrames]` → writes `go-trace.txt` (one line per DRAW/CLEAR/DELAY/GOTO/PURGE,
  frame-delimited). It runs on the WSLg display (DISPLAY=:0; Mesa llvmpipe — do
  NOT use xvfb-run, which forces DISPLAY=:99 and segfaults). The `-trace` arg
  MUST be checked before `-t` in main.go's parser (both share the `-t` prefix).
  Requires rebuilding the repo binary: `go build -o JohnnyCastaway2026 .`
- The TS port emits the SAME format: load `?dump=1`, then `window.__trace(n)`
  returns n frames of trace text (setTraceSink in ts/src/ttm/interpreter.ts).
- **`ts/tools/oracle-diff/diff.py <ADS> <tag> [frames]`** runs both and diffs
  them (needs a vite server on :5199 + the built Go binary).
- RNG is seeded deterministically in trace mode (two independent mulberry32
  streams — ADS scene-pick and TTM TIMER — mirrored bit-for-bit in Go trace.go
  and TS interpreter.ts), so whole ADS chains diff, not just single scenes.
  `sweep.py` covers all 66 ADS entry tags.

### Harness invariants — break one and it will lie to you

- **Unequal trace length is a FAILURE, not a prefix match.** A comparison that
  truncates to `min(len(go), len(ts))` silently passes any trace that stopped
  early. See rule 1 above for what that cost.
- **Poll for readiness (`window.__ready === true`), never a blind `sleep`.** A
  fixed sleep racing async asset decode made trace lengths vary run-to-run.
- **Each scene needs fresh-process state** or traces differ: `adsInit()` (zeroes
  every thread incl. background/clouds/holiday) + `traceResetForScene()`
  (re-seeds both RNG streams, clears the frame budget). Verified byte-identical
  to one-process-per-scene, and order-independent.
- **Loop `adsPlay` until the frame budget fills**, mirroring `runTestMode` —
  some scenes end their ADS chunk after one frame but re-enter to keep going.
- **`-traceserver` filters raylib's own INFO spam by line prefix**; it shares
  stdout with the `===TRACE …===`/`===END===` protocol.
- **In-page scene switching (`window.__load`) must stay equivalent to a cold
  reload.** It is what makes the sweep fast; `COLD_RELOAD=1` forces the old path
  if a state leak is ever suspected.
- **Any opcode added to one engine must be added to the trace too**, or the
  oracle silently stops covering it (see rule 3).

### Debugging a scheduling divergence: diff DECISION SEQUENCES, not draw calls

This is the technique that cracked every scheduler bug here, and it is the first
thing to reach for when the draw-call sweep shows a divergence.

- Go: `JC_SCHED_LOG=1 ./JohnnyCastaway2026 -trace STAND 2 15 2>&1 >/dev/null | grep ^SCHED`
  (env-gated in `trace.go`, verified not to perturb the trace — safe to leave
  in, unlike `debugEnabled` which needs flip-build-revert).
- TS: `uv run --with playwright==1.61.0 python tools/oracle-diff/schedlog.py STAND 2 15`.

Both emit the same `SCHED …` lines: `op ADD_SCENE/STOP_SCENE` with the live
`skip=`/`rand=` flags, `IF_IS_RUNNING`/`IF_NOT_RUNNING` with the `running=` each
engine saw, `PICK` with the whole weighted op list plus total and draw,
`ADD`/`STOP`/`REAP`/`FIRE`, and `LOOP`/`MINI` with the full thread array
(`{idx=slot:tag rN tTimer dDelay stSceneTimer}`). **The first differing line is
the bug; everything after it is downstream damage.** Filter out `STOP idx=` —
Go logs it on the reap path too, the port only on an explicit `stopScene`.

### Engine rules the port must honour (each cost a real bug)

Facts about how the engine actually behaves, salvaged from the bugs they caused.
These are the ones a re-implementation gets wrong by default.

- **`mini` is the engine's CLOCK, and dropping it breaks thread ordering.**
  ads.go computes `mini` = smallest (`timer`, `delay`) across running threads,
  subtracts it from every timer, *then* sleeps `mini*20ms`. A fixed-rate port
  should drop the SLEEP (the trace steps by frame, not wall clock) but must keep
  the SUBTRACTION — that is what orders thread wake-ups relative to each other.
  Consequence: a scheduler tick advances the clock by `mini`, not by 1, so a
  real-time caller has to charge `TICK_MS * mini` or playback runs that many
  times too fast.
- **The background(waves) and clouds threads are a CLOCK, not scenery.** They
  draw via `grDrawSprite` straight to the background surface and emit NO trace
  lines, so a port naturally skips them — but their timers take part in `mini`
  and quantize the whole scheduler to an 8-tick grid (`adsInitIsland` starts
  both; `islandInit` then sets background delay to 8, overriding the 40 above
  it; clouds are 8). Without them `mini` swallows a 150-tick hold whole and
  every reap lands on the wrong iteration. Model them as pure metronomes.
  Only 4 scenes are non-ISLAND and must NOT run them: JOHNNY:1/6, SUZY:1/2.
  Everything else either has the ISLAND flag or no story entry at all, and
  main.go's `if !found || ISLAND` runs `adsInitIsland` for both.
- **Composite at ads.go's `grUpdateDisplay` point** — after the frames are
  drawn, BEFORE the reap frees a finished thread's layer. Presenting after the
  tick returns silently drops every scene's FINAL frame. Corollary: a mere
  membership change is not a display change; the moment between a reap and the
  next scene's first draw is never presented.
- **A thread's layer outlives other threads' add/stop.** Each layer is created
  once (`grNewLayer`) and only that thread's own `CLEAR_SCREEN` or `grFreeLayer`
  touches it. Rebuilding all layers to fix compositing ORDER erases every other
  running scene — reorder in place instead.
- **`LOAD_SCREEN` releases the saved-zones layer.** Baked scenery is bound to
  the screen it was baked against; a new backdrop invalidates it.
- **Primitives inherit `fgColor`/`bgColor` = `0x0f`** from `adsAddScene`, not 0.
  A scene drawing a primitive before its first `SET_COLORS` depends on this.
- **`SET_CLIP_ZONE` args are INCLUSIVE corners** — the span is `x2-x1+1`. (The
  engine itself got this wrong; see `UPSTREAM-ISSUES.md`.)
- **`STOP_SCENE (5,10)` also stops tags 7 and 8** — an explicit alias in
  `adsStopSceneByTtmTag`, which VISITOR:5 depends on.
- **`IF_LASTPLAYED_LOCAL`/`ADD_SCENE_LOCAL`** (ACTIVITY.ADS tag 7 only) register
  a chunk at RUNTIME, and a matching local chunk SUPPRESSES the general dispatch
  for that (slot, tag).
- **Some entry tags legitimately run dry** before a frame budget fills
  (STAND:14 GOSUBs to a one-scene tag). `runTestMode`/`-traceserver` just loop
  `adsPlay` again — re-entry must NOT re-seed the RNG. The loop's exit condition
  is ads.go's own `numThreads != 0`, not "an END opcode ran".

### 1px primitives rasterize differently in GL and Canvas

Four separate traps, all found by the pixel oracle:

- `rl.DrawLine` samples on the integer lattice (the corner between pixels), so
  an axis-aligned 1px line at x lands in column x-1. The engine now uses
  `DrawLineV(+0.5)` to draw through pixel centres.
- Canvas antialiases stroke ENDPOINTS even on axis-aligned paths → use
  `fillRect` for those.
- Canvas antialiases DIAGONALS where GL picks one hard pixel per step → use
  Bresenham.
- `arc()+fill` antialiases where `rl.DrawCircle`'s triangle fan does not → fill
  span-by-span.

All follow GL_LINES' half-open convention: the far endpoint is excluded.

### The PIXEL oracle — what it sees that the draw-call oracle cannot

`pixels.py` compares RENDERED FRAMES. Go writes per-frame PNGs when the
traceserver request carries a 4th field (a shot directory → `traceShots`); the TS
side returns the same frames from `window.__shots(n)`.

Both sides capture *layers only, over transparency* — no island backdrop, no
clouds, since those are engine-side procedural animation the Canvas2D port
deliberately doesn't reproduce. Shot mode also zeroes `grDx/grDy`: VARPOS scenes
randomize the island position from the UNSEEDED global rand, so the same scene
lands elsewhere every run.

Two harness rules learned here, both of which silently corrupted results:

- **One shot per DISPLAYED COMPOSITE**, not per traced frame and not per
  scheduler iteration. `grUpdateDisplay` is called once per iteration including
  ones where nothing drew (16 shots for a 10-frame request), and a single
  iteration can run several threads emitting several frames but only one
  composite (10 shots where the port presents 9). Either mismatch misaligns the
  sequences and surfaces as phantom "1px sprite" differences.
- **Ignore pure black vs transparent.** Both engines composite over black, so
  that difference is invisible — but stripping the background for comparison
  promotes it to a large false positive. Forgive ONLY black; canary-test that a
  stray coloured pixel, a colour mismatch and a 1px shift are all still caught.

**Open: 13 scenes differ at 60 frames.** All catalogued, no unknowns:
- **JOHNNY:2/3/4/5 (20-72 px)** — the cap rows of the LARGEST bubbles only.
  raylib's circle fan segment count varies with radius; an exact match needs its
  own segment maths rather than the single cap rule used now.
- **FISHING:1/2/3/6 (15 px), VISITOR:4/6/7, BUILDING:3, FISHING:4 (3-4 px)** —
  ONE root cause: GL's per-step tie-breaking on diagonals. Every diff is a single
  pixel stepping one row early/late on the same column, or a line endpoint
  included on one side only. An analytic `round(x1+dx*t)` walk reproduces 173 of
  176 pixels on FISHING's long line, and Go's endpoint inclusion is INCONSISTENT
  between lines in the same frame — that is GL's diamond-exit rule, sub-pixel
  dependent and implementation-defined. Matching it means emulating that rule,
  not writing a cleaner Bresenham. **Deliberate stopping point:** the affected
  pixels are single dots on impact-lines and a fishing line, invisible at normal
  size.

### Tooling gaps still open

`blitcheck.py` covers sprite blits; there is **no single-primitive probe** for
LINE/CIRCLE/RECT in a live layer, which is why the remaining GL tie-break residue
had to be reverse-engineered from composited frames.

There is **no headless engine harness**. A `-spriteprobe` attempt failed because
`setupApp`/`grUpdateDisplay` are entangled with window, input and pacing state,
and was reverted. Anything wanting to exercise engine drawing without a window
needs those dependencies broken first.

One more trap worth stating on its own: **not every empty frame is a bug.** The
engine itself emits draw-less frames (BUILDING:2's `FRAME 0` is a bare
`PURGE`+`ENDFRAME`). Check the oracle trace before "fixing" a blank frame.

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

## Persistent scenery — the saved-zones layer (COPY_ZONE_TO_BG)

- Some scenes build scenery that must OUTLIVE the thread that drew it (SMDATE's
  dinner table + chairs, MJSAND's sandcastle, GJVIS6's passing tanker hull).
  `COPY_ZONE_TO_BG(x,y,w,h)` bakes that rect into a persistent `grSavedZonesLayer`
  that composites ABOVE the background but BELOW the active per-thread layers
  (order: background → clouds → savedZones → threads → holiday). Without it,
  such scenery vanishes the moment the scene's CLEAR_SCREEN wipes its layer.
- `SAVE_IMAGE1`, `SAVE_ZONE` are genuine no-ops (unimplemented in the original C
  too — graphics.go says so). `RESTORE_ZONE` just frees the whole saved layer.
  `CLEAR_IMGSLOT` (grRestoreBmpSlot) restores a BMP slot to its base (first-
  loaded) sheet — track a per-slot base to implement it.
- The Go engine's grCopyZoneToBg tries to redraw the last sprite/rect instead of
  copying rendered pixels (to avoid a render-texture readback artifact); a
  Canvas2D port can just copy layer→layer directly (no readback issue). It uses
  width+2 to paper over a 2px authoring gap in GJVIS6's hull data.

## ADS scheduling — gotchas that cause runaway, endless, or dead scenes

- **PURGE's meaning is decided at RUNTIME by `sceneTimer`, not by a mode flag.**
  ttm.go: `if sceneTimer != 0 { goto previous tag } else { isRunning = 2 }`.
  `sceneTimer` comes from ADD_SCENE's third arg read as **signed 16-bit**:
  `arg3 < 0` → `sceneTimer = -arg3` (a *timed* scene: PURGE loops it back and it
  keeps playing until ads.go drains the timer by `delay` per elapsed hold);
  `arg3 > 0` → `sceneIterations = arg3-1` (replay that many more times);
  `arg3 == 0` → ends on first PURGE. **61 scenes across BUILDING/VISITOR/SUZY/
  JOHNNY/MARY/ACTIVITY use a negative arg3**, so this is load-bearing, not an
  edge case. A port that collapses this into a static boolean ("ADS always ends
  / browser always loops") kills every timed PURGE-looping scene on its first
  PURGE. The standalone viewer needs its own explicit `loopForever` flag instead.
- **A finished thread must keep counting its hold timer down, or the whole
  script deadlocks.** A thread marked finished on the same tick it ran its last
  frame still holds `timer = delay`. If the scheduler skips finished threads
  when decrementing, that timer never reaches 0, the thread is never reaped, its
  triggered chunks never fire, and the chain stops dead (MARY.ADS tag 2 emitted
  4 trace lines vs the engine's 90 — it *looked* like an early-exit bug, but it
  was a stuck timer). ads.go re-arms `timer = delay` then immediately subtracts
  `mini`, so a just-finished thread lands on 0 and terminates in the SAME loop
  iteration — i.e. reap it promptly rather than making it wait `delay` ticks.
- **`isSceneRunning` counts `isRunning != 0`, which INCLUDES `isRunning == 2`**
  (ended but not yet reaped). Excluding finished-but-unreaped threads makes
  `IF_NOT_RUNNING` / `IF_IS_RUNNING` take the wrong branch — and because those
  guards gate what gets pushed into a RANDOM block, a wrong branch changes the
  block's total weight and desynchronises the whole RNG stream from that point.
- **PURGE does NOT stop the current frame — it finishes to the next UPDATE.** In
  ttmPlay, PURGE only sets isRunning=2 / a goto; `continueLoop` stays true, so
  DRAW opcodes AFTER the PURGE (up to UPDATE) still render (e.g. MJFIRE tag 142's
  trailing smoke puff). A port that ends the scene the instant it sees PURGE
  drops that last frame → a visible blink / lost final pose at scene changes.
  Fix: set a pending-done/goto flag on PURGE and apply it at the frame's UPDATE.
- **Triggered chunks (IF_LASTPLAYED bookmarks) MUST be scoped to the played
  entry tag.** `adsLoad` enables bookmarking only inside the requested tag's
  region — every OTHER `:TAG` marker turns it back off. Bookmarking across the
  whole file lets a completed scene match chunks belonging to unrelated entry
  sequences (different tags, even different TTM slots), spawning an exponential
  pile of concurrent scenes. Correctly scoped, the count stays ~1-2.
- **Timing: one engine tick = 20ms, and a frame is held `delay` ticks.** ttmPlay
  sets `delay` (SET_DELAY min 4 / TIMER random); grUpdateDisplay holds the frame
  until `elapsed >= delay*0.02s`. The Go main loop subtracts `mini` (smallest
  timer) each iteration THEN sleeps `mini*20ms`. **Keep the subtraction, drop
  only the sleep** — see the `mini` entry under "Engine rules" above. (An
  earlier version of this file advised the opposite, "count each timer down by 1
  per rAF tick"; that is what broke multi-thread scene ordering and took a long
  time to find. A port doing that must ALSO charge `TICK_MS * mini` per tick or
  playback runs that many times too fast.)
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
