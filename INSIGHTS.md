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

## Oracle diff: compare the TS port against the Go engine (no more guessing)

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

### The harness must fail loudly, or it will lie to you

- **A comparison that truncates to `min(len(go), len(ts))` silently passes any
  TS trace that stopped early.** That single line inflated the score to a
  confident-looking "63/66 byte-identical" when the honest number was **10/66**.
  Worse, it produced a *plausible wrong story*: the few scenes that did fail
  looked like a harmless "1-frame phase shift", and the shifting failure set
  across runs got blamed on GPU contention. Both were fabrications of the
  measurement. **Unequal trace length is a FAILURE, not a prefix match.**
- The TS side must be polled for readiness (`window.__ready === true`, set once
  assets are decoded and playback is live), never a blind `sleep`. A fixed sleep
  racing async asset decode is what made trace lengths vary run-to-run.
- Lesson worth keeping: when a metric and a symptom disagree, **distrust the
  metric first**. Re-running the same scene 3× and diffing the divergence-set
  md5 is the cheap discriminator between a real bug and a flaky harness.

### Speed (sweep: 3m25s → 1m32s)

- `-traceserver` inits raylib ONCE and serves scenes from stdin
  (`ADS tag frames` → `===TRACE X.ADS N===`…`===END===` on stdout; raylib's own
  INFO spam interleaves on stdout, so filter by line prefix). Per-scene process
  launch cost ~2s of GL init × 66.
- Each scene needs fresh-process state or traces differ: `adsInit()` (zeroes all
  threads incl. background/clouds/holiday) + `traceResetForScene()` (re-seeds
  both RNG streams, clears the frame budget). Verified byte-identical to
  per-process `-trace`, and order-independent.
- Loop `adsPlay` until the frame budget fills — mirroring runTestMode. Some
  scenes (STAND.ADS tag 14) end their ADS chunk after one frame but re-enter to
  keep animating, so a single `adsPlay` returns early.
- `sweep.py` pipelines Go against Playwright: fire the Go request, run the
  independent TS trace while Go computes, then read the Go block → per-scene
  cost becomes ~max(go, ts) instead of go+ts.
- `traceEnabled` also skips the per-frame pacing sleep in graphics.go (the diff
  steps by frame count, not wall clock).

### Status: 66/66 byte-identical (deterministic)

**How to debug this class of bug** — dump the SCHEDULER DECISION SEQUENCE from
both engines and diff *that*, not the draw calls. Both sides now emit the same
`SCHED …` line format:

- Go: `JC_SCHED_LOG=1 ./JohnnyCastaway2026 -trace STAND 2 15 2>&1 >/dev/null | grep ^SCHED`
  (env-gated in `trace.go`; verified to leave the trace byte-identical, so it is
  safe to leave in — no flip-build-revert needed, unlike `debugEnabled`).
- TS: `uv run --with playwright python ts/tools/oracle-diff/schedlog.py STAND 2 15`
  (`window.__schedlog(n)` in `?dump` mode).

Lines cover `op ADD_SCENE/STOP_SCENE` (with the live `skip=`/`rand=` flags),
`IF_IS_RUNNING`/`IF_NOT_RUNNING` (with the `running=` each engine saw), `PICK`
(the whole weighted op list, the total, and the draw), `ADD`/`STOP`/`REAP`/`FIRE`,
and `LOOP`/`MINI` with the full thread array (`{idx=slot:tag rN tTimer dDelay
stSceneTimer}`). The first line that differs is the bug; everything after it is
downstream damage. Filter out `STOP idx=` when diffing — Go logs it on the reap
path too, TS only on the explicit `stopScene`.

**A cautionary tale about that RANDOM-desync theory.** The previous status entry
here claimed the remaining 33 failures were one root cause: the ADS RANDOM stream
going out of phase, because a STOP_SCENE was dropped from a random block
(`inSkip` true where Go had it false), giving a total weight of 5 vs 6 and a
different modulus. That story was **wrong in every particular** — the decision
logs showed TS collecting `[stop:61 w1, nop w5]`, total 6, draw 3, picking
exactly what Go picked. It had been inferred from the downstream draw-call diff
rather than measured. Ten minutes of decision-sequence logging refuted it. The
actual causes were four unrelated timing/harness bugs (below). **Diff the
decisions before believing any story about which branch was taken.**

### The four bugs behind the 33 failures (fixed)

1. **Scene entry didn't reset `delay` to 4.** `adsAddScene` sets `delay = 4`;
   the TS `TtmThread` constructor fast-forwards the op stream to the entry tag
   and inherited whatever `SET_DELAY`/`TIMER` it scanned past (STAND:2 entered
   with 6 and 10). The engine jumps straight to the tag offset and never
   executes those. Every later frame boundary shifted.
2. **The `mini` clock was replaced by a 1-per-tick countdown.** ads.go computes
   `mini` = smallest (`timer`, `delay`) across running threads, subtracts it
   from every timer, *then* sleeps `mini*20ms`. The port dropped the sleep
   (correct — the trace steps by frame) but ALSO dropped the subtraction
   (wrong): that subtraction is what orders thread wake-ups relative to each
   other. With 1-per-tick, a finished thread had to be force-reaped to avoid
   stalling, so it died in the same iteration it ended instead of living out
   its hold while other threads ran frames.
3. **The background(waves)/clouds threads are a CLOCK, not just scenery.**
   `adsInitIsland` starts both (`isRunning = 3`); `islandInit` then sets the
   background thread to delay 8 (overriding the 40 above it), clouds to 8. They
   draw via `grDrawSprite` straight to the background surface and emit **no**
   trace lines — so a port that skips them looks fine — but their timers are in
   the `mini` computation, which quantizes the whole scheduler to an 8-tick
   grid. Without them `mini` swallows a 150-tick hold whole and every reap lands
   on the wrong iteration. Modelled in the TS scheduler as pure metronomes
   (timers only, no rendering). Only 4 scenes are non-ISLAND and must NOT run
   them: JOHNNY:1, JOHNNY:6, SUZY:1, SUZY:2 (`sceneHasIsland`); everything else
   either has the ISLAND flag or no story entry at all, and main.go's
   `if !found || ISLAND` runs `adsInitIsland` for both.
4. **The trace budget counted the wrong thing.** Go stops at the Nth ENDFRAME
   (`traceFrameEnd` → `traceReachedBudget` → `adsPlay` returns *before* the
   mini/reap step). The TS harness counted "ticks that changed the display" —
   but one tick can run TWO threads and emit two frames, so the TS trace
   overshot by a frame (16 vs 15) and scenes whose decisions and draw calls were
   perfectly correct still failed on length. Budget where frames are emitted.

5. **`IF_LASTPLAYED_LOCAL` / `ADD_SCENE_LOCAL` were no-ops.** These (0x1070 /
   0x1520) occur in exactly ONE place — ACTIVITY.ADS tag 7 — which is why 15
   frames never reached them. `IF_LASTPLAYED_LOCAL` registers a chunk at
   RUNTIME (not at `adsLoad` time like the general ones), and a matching local
   chunk SUPPRESSES the general dispatch for that (slot, tag). `ADD_SCENE_LOCAL`
   is two-pass: reached via the guard above it, it's just the queued body;
   replayed later by the trigger, it actually adds the scene (args (?, slot,
   tag, arg3, ?)). With both stubbed out, the general chunk fired instead and
   the script branched to scene 4:7 where the engine plays 4:22.

Plus: some entry tags legitimately run dry before the budget fills (STAND:14
GOSUBs to a one-scene tag; STAND:1's chain can end early on a given RANDOM
outcome). `runTestMode` / `-traceserver` just loop `adsPlay` again — re-entry
must NOT re-seed the RNG. The exit condition is ads.go's own `for numThreads
!= 0` (`isDrained`), not "an END opcode ran" (`isStopped`).

6. **`STOP_SCENE (5, 10)` also stops tags 7 and 8.** An explicit alias in
   `adsStopSceneByTtmTag`. VISITOR.ADS tag 5 depends on it: the chunk fired by
   5:9's completion does `STOP_SCENE 5 10` to kill the *running* 5:7 before
   adding 5:3. Without the alias nothing stopped, 5:7 kept running, and 5:3
   landed in thread slot 1 instead of 0 — changing frame-emission order from
   there on. Only visible at 150 frames (670 vs 656).

**Sweep at more than 15 frames.** 15 frames gave a clean 66/66 while ACTIVITY:7
was still wrong (its local-chunk path is ~19 frames in); 60 frames gave 66/66
while VISITOR:5 was still wrong (the STOP alias is ~120 frames in). A short
horizon only proves the OPENING of each scene matches. Current status is
**66/66 at 15, 60 and 150 frames**.

### Speed round 2 (sweep: 1m32s @15 frames → 20s @60, 31s @150)

Two changes, each verified byte-identical to the previous oracle:

- **`grUpdateDisplay` returns immediately in trace mode.** The trace is emitted
  by `ttmPlay`'s opcode handlers; compositing every layer onto
  `grFinalRenderSur` and presenting it was pure overhead — and it *dominated*
  (4.70s of a 4.9s scene at 60 frames, scaling linearly with frame count).
  Skipping it: **4.70s → 0.23s/scene**, and it no longer scales with frames.
- **The sweep switches scenes IN-PAGE** (`window.__load`) instead of reloading
  the document per scene (1.34s → 0.48s). Reloading re-parsed the app and
  re-decoded every sprite sheet. `loadAnimation` now caches decoded sheets by
  URL, which is what makes the switch cheap (ADS scripts share TTMs heavily).
  Verified identical to a cold reload, including visiting scenes in a different
  order. `COLD_RELOAD=1` forces the old path if a state leak is ever suspected.

Consequence: **there is no longer any reason to sweep at 15 frames.** 150 frames
now costs less than 15 did, and 15 twice hid real bugs (see above).

**Pin Playwright to 1.61.0** (`uv run --with playwright==1.61.0 …`). Plain
`--with playwright` resolves to whatever is newest and then demands a browser
build that isn't in `~/.cache/ms-playwright` — the sweep dies at launch. 1.61.0
matches cached chromium 1228.

### The oracle diff cannot see rendering bugs — so there is a PIXEL oracle too

`ts/tools/oracle-diff/pixels.py` compares RENDERED FRAMES, not draw calls:
Go writes per-frame PNGs when the traceserver request carries a 4th field (a
shot directory → `traceShots`); the TS side returns the same frames from
`window.__shots(n)`. First run found **16/66 scenes with real rendering
differences that the draw-call sweep rates 66/66 perfect.**

Both sides capture *layers only, over transparency* — no island backdrop, no
clouds. Those are engine-side procedural animation (drawn straight to the
background surface, emitting no TTM draw calls) that the Canvas2D port
deliberately doesn't reproduce; including them would make every frame differ on
out-of-scope content. Their timers still run, so scheduling is unaffected.
Shot mode also zeroes `grDx/grDy`: VARPOS scenes randomize the island position
from the UNSEEDED global rand, so the same scene lands elsewhere every run,
while the port pins the offset to 0 for its baked backdrop.

Known differences it currently reports (all pre-existing, none regressions):
- **JOHNNY:1/6, SUZY:1/2 (~12k px)** — the port fills an opaque black rect
  behind the clock sprite where the engine leaves it transparent. Invisible in
  practice (those scenes are on a black background) but a real key-colour bug.
- **FISHING:1-8, WALKSTUF:1/3, ACTIVITY:9, MARY:2 (76-358 px)** — the port's
  sprite is 1px wider/taller; the diff is a single edge row/column.

### Look at the picture too

The trace compares draw *calls*. A frame whose calls are perfect can still be
composited or presented wrongly, and the sweep will happily report 66/66. A user
spotting "Johnny is missing on frame 14 of ACTIVITY:12" found exactly that:

- **Composite INSIDE the tick, at ads.go's `grUpdateDisplay` call site** — after
  the frames are drawn, BEFORE the reap frees any finished thread's layer. This
  is a position, not just a timing detail: a scene's last frame is drawn,
  displayed, and only then does its layer go away. Presenting after `tick()`
  returns (i.e. after the reap) silently DROPS every scene's final frame —
  BUILDING.ADS tag 1 draws Johnny's last walking sprite on tag 16's layer,
  PURGEs, and is reaped in the same iteration, so the viewer saw an empty island
  where the engine shows him mid-stride. The scheduler now exposes an
  `onPresent` hook and the callers (rAF loop, `__dumpStep`) composite there.
  Bonus fix: the rAF loop runs several ticks per frame when catching up, and
  presenting once at the end collapsed them into one — `onPresent` gives each
  tick its own frame (BUILDING:1 went 78 → 93 distinct frames per 12s).
- **Don't present between the reap and the next draw.** The same
  `grUpdateDisplay`-before-reap ordering means the moment when the old scene has
  been reaped and new ones added but nothing has drawn is never shown. The TS
  `tick()` was reporting a membership change as `changed`, so the dump stepper
  captured that in-between state: both fresh layers empty, the old one freed → a
  blank frame. Only a frame that actually RAN counts as a display change.
- **A thread's layer must outlive an add/stop of some OTHER thread.** In the
  engine each thread's render texture is made once by `grNewLayer` and only its
  own `CLEAR_SCREEN` (or `grFreeLayer` at stop) touches it. A `rebuildLayers`
  that called `resetLayers()` and handed everyone a fresh empty layer to fix
  compositing ORDER also erased every other running scene's pixels. Reorder the
  existing layers instead (`orderLayers`), and free exactly one on stop/reap.
- Not every empty frame is a bug: the engine itself emits draw-less frames (e.g.
  BUILDING:2's `FRAME 0` is a bare `PURGE`+`ENDFRAME`). Check the oracle trace
  before "fixing" a blank frame.

**A tick is no longer one time-unit.** `scheduler.tick()` now advances the clock
by `mini`, so the real-time render loop must charge `TICK_MS * lastTickCost`
per tick instead of one `TICK_MS`, or playback runs ~8× too fast.

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
  timer) each iteration THEN sleeps `mini*20ms`. A fixed-rate rAF port must NOT
  copy the subtract-mini step — with no sleep it collapses every scene's delay
  into one tick, so the whole script plays at a flat frame-per-tick (~30fps),
  far too fast. Instead count each timer down by 1 per rAF tick and pace rAF at
  ~20ms. (The single-thread TTM player already did this; only the ADS scheduler
  had the bug.)
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
