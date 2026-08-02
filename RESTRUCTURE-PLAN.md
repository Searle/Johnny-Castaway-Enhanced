# Restructure plan

Read `INSIGHTS.md` first — especially the five method rules. This plan assumes them.

## Diagnosis

The ported *algorithms* are correct and verified: TTM interpreter (draw-call oracle
66/66), walk state machine (walk oracle 1792/1792), story scene picker
(`story-check`), island maths. **Every bug found by a human so far has been in the
glue, not the algorithms.**

The cause is one structural decision. `story.go`'s `storyPlay` is a **blocking
loop** — `adsPlayWalk` blocks until the walk ends, `adsPlay` blocks until the scene
ends, sequencing is statement order. `ts/src/main.ts` re-expressed that as an
**event-driven rAF state machine** where sequencing is implied by flags. Each bug
fix added another flag, raising the odds of the next bug.

Size comparison — the whole engine screensaver driver vs. the port's:

| | lines |
|---|---|
| `storyPlay` (story.go:134-272) | 139 |
| `adsPlayWalk` (ads.go:1062-1127) | 66 |
| ADS main loop (ads.go:741-800) | 60 |
| **engine total** | **265** |
| `ts/src/main.ts` | **955** |

This is 1992 code. If the port is 3.6x larger and less correct, the port is wrong.

Bugs found by eye, all in glue, none catchable by either oracle:

| symptom | cause |
|---|---|
| VISITOR:4 wedged at frame ~54 | missing state transition on drain |
| shore frozen during holds | present coupled to scene-draw event |
| Johnny blinks one frame | present fired after a reap freed a layer |
| Johnny teleports between scenes | `prevSpot` cleared by an invented flag |
| clouds mostly hidden | clouds in the wrong composite slot |

The last one was never noticed by any check because nothing verifies **composite
structure**. Both oracles verify what the interpreter *computes*, never what
reaches the screen or when.

## Order of work

**Step 1 → Step 2 → Step 3 → Step 4.** Step 2 (the frame-digest oracle) lands
before Step 3 (the risky restructure) so the restructure is verifiable rather than
asserted.

Step 2 is also the only step with a hard **speed** requirement, and for the same
reason: it has to be cheap enough to run after every edit *during* Step 3, not just
once at the end. A 6-minute gate gets deferred, and a deferred gate finds bugs after
they are buried. Budget it like `sweep.py` (~24s for 66 tags × 60 frames, measured),
not like `pixels.py` (~6 min).

Step 1 is deliberately first and small: it is a contained, obviously-correct fix
that also removes two workarounds Step 3 would otherwise have to carry forward.

**Accept this about Step 1: no automated check can verify it.** The pixel oracle's
`presentLayersOnly` deliberately excludes the island and clouds, so it is blind to
exactly the slot the fix is about, and the digest does not exist yet. Step 1 is
therefore verified by eye plus "the other oracles did not regress". That is
acceptable only because the change is small and structural. If Step 1 turns out to
need real judgement calls, stop and do Step 2 first instead — swapping the order
costs little and the alternative is another unverified compositor change.

---

## Step 1 — Fixed-slot compositor

**Problem.** `grUpdateDisplay` (graphics.go:672-1233) composites a fixed five-slot
stack:

```
1 background surface (grBackgroundSur — island is painted onto this)
2 clouds        (ttmCloudsThread.ttmLayer, if isRunning != 0)
3 saved zones   (grSavedZonesLayer)
4 thread layers (ttmThreads[0..N], in slot order)
5 holiday       (ttmHolidayThread.ttmLayer, if isRunning != 0)
```

`ts/src/render/canvas2d.ts` has `background` (ImageBitmap), `bgLayer`,
`savedZones`, `layers[]`, `overlay`. **Clouds are not a slot** — they are pushed
into `layers[]` via `renderer.newLayer()`, so they sit among the scene threads.
Ordering is currently "fixed" by creating the cloud layer before any scene layer
and recreating it inside `stopPlayback` (main.ts:99, main.ts:283). That workaround
fails whenever layer creation order changes, which is why clouds are mostly hidden.

**Change.**

1. In `ts/src/render/renderer.ts`, replace `backgroundLayer()` /
   `clearBackgroundLayer()` / `overlayLayer()` / `clearOverlayLayer()` with one
   named-slot API:
   ```ts
   type Slot = "island" | "clouds" | "savedZones" | "holiday";
   slot(name: Slot): Layer;      // created on first use
   clearSlot(name: Slot): void;
   ```
   `layers[]` (scene threads) stays as-is — it is genuinely dynamic and
   slot-ordered, matching `ttmThreads[0..N]`.
2. In `canvas2d.ts` `present()`, composite in exactly the engine order above.
   Delete the `overlay` field in favour of the `holiday` slot.
3. `resetLayers()` must clear **only** `layers[]`. Slots persist — the island and
   clouds outlive the scenes drawn on them, exactly as in the engine.
4. Delete from `main.ts`: `story.cloudLayer`, the `newLayer()` call at main.ts:283,
   and the cloud-layer recreation block in `stopPlayback` (main.ts:95-100).
   `animateClouds` writes to `renderer.slot("clouds")`.

**Verify.** No automated check covers this (see "Order of work"), so be deliberate:

- Capture a frame where a cloud passes over Johnny and confirm **he is drawn over
  the cloud**, and another where the cloud is over open sea and **visible in front
  of the ocean**. Both, not just one — the bug is an ordering bug and one image
  cannot distinguish "above the ocean" from "above Johnny".
- Confirm clouds survive a scene change *and* a walk (they are slot 2, which
  outlives slot 4).
- Confirm a holiday decoration still draws above the scene.
- Regression: draw-call 66/66, pixel oracle 53/66 with the same 13 scenes and the
  same pixel counts.

**Note.** `presentLayersOnly()` (pixel-oracle reference format) must keep excluding
the island and clouds — graphics.go:850 does the same under `traceShots`. Only
`savedZones` + `layers[]` + `holiday`.

---

## Step 2 — Frame-digest oracle (the missing instrument)

**Problem.** The draw-call oracle is structurally blind to the compositor. The pixel
oracle is slow (~6 min), has 13 permanently-failing scenes from GL tie-break
residue, and **caught none of the five bugs above**. Nothing verifies composite
structure or presentation timing.

**It must be fast enough to run on every change.** This is a hard requirement, not
a nice-to-have: an oracle that costs 6 minutes gets run at the end, when a bug is
already buried under other work. Target: **comparable to `sweep.py`** — all 66 tags
in well under a minute. That is achievable because the digest is a TEXT oracle; see
"Why this is fast, and why it does not perturb timing" below.

**Change.** Both engines emit one text line per **presented composite**, diffed like
`sweep.py`. Proposed format — one line, stable field order, no floats:

```
F <n> bg=<SCR|none> isl=<x>,<y>,tide=<hi|lo>,raft=<0-5>,night=<0|1> clouds=<n> zones=<0|1> L=[<slot>:<tag>,...] hol=<0-4>
```

Rules:
- Emitted at the composite point, i.e. exactly where `grUpdateDisplay` is called
  (ads.go:771) and where `onPresent` fires in the port — **one line per displayed
  composite**, not per traced frame and not per scheduler iteration. This is the
  same alignment rule the pixel oracle already documents in INSIGHTS.md; get it
  wrong and the sequences misalign and every later line differs.
- `L=[...]` lists live thread layers **in composite order**, each as
  `sceneSlot:sceneRootTag`. Order and membership are the payload — that is what
  catches z-order, layer lifetime and reap-timing bugs. All of it is read straight
  off `grUpdateDisplay`'s arguments (`TTtmThread.sceneSlot`, `.sceneRootTag`,
  `.isRunning`, graphics.go:185), so nothing has to be drawn to produce it.
- **Do NOT include a per-layer sprite count.** No such counter exists on either
  side (verified), so it would have to be added twice with identical semantics —
  when to reset it, whether CLEAR_SCREEN zeroes it, whether an off-screen blit
  counts. That is a new source of divergence unrelated to the bugs this oracle
  exists to catch, and the draw-call oracle already proves sprite-level equality.
  Keep this oracle about STRUCTURE (which layers, in what order, when shown).
- Go side: gate behind a new flag (e.g. `-framedigest`), reusing the
  `-traceserver` stdout protocol so `sweep.py`'s harness is reused wholesale.
- TS side: `window.__digest(n)` alongside `__trace(n)`, driven by the SAME
  frame-counted runner (`runForFrames`), never by the rAF loop.

### Why this is fast, and why it does not perturb timing

Both existing text oracles already run headless and unpaced; this one inherits that.
Two distinct kinds of "timing" must not be confused:

- **Wall-clock pacing** — `time.Sleep(frameDelayMS)` (graphics.go:1205) and the
  frame-hold loop `(end-start) >= grUpdateDelay*0.02` (graphics.go:1228). Both are
  already short-circuited by `traceEnabled`. This is PRESENTATION timing: it decides
  when a human sees a frame, and nothing else. Skipping it is what makes `sweep.py`
  do 66 scenes × 60 frames in **~24s**, measured, at 66/66.
- **Engine-clock timing** — `mini`, `timer`, `delay`, and the reap step in the ADS
  main loop. This is LOGICAL timing and must run exactly as normal. It is driven by
  the tick loop, not by the wall clock, so it is unaffected. INSIGHTS.md states the
  rule directly: *drop the SLEEP, keep the SUBTRACTION.*

The digest samples state inside the logical loop, so it is blind to wall-clock
pacing **by construction**. A no-graphics, no-waiting mode is therefore not a risk
here — it is the established pattern.

**Take a THIRD path through `grUpdateDisplay`**, not `traceShots`':

```
if digestEnabled { emitDigest(...); return }   // before any compositing
if traceEnabled && !traceShots { return }      // existing draw-call path
```

`traceShots` deliberately runs the full letterbox / monitor-rect / GPU blit path
because the pixel oracle needs real PIXELS (`grCaptureFrame`, graphics.go:1243,
does `LoadImageFromTexture` + `ExportImage` per frame — that plus base64 transfer of
~60 full frames per scene is where the pixel oracle's 6 minutes goes, NOT waiting).
The digest needs only the layer list, available from the arguments at the top of the
function. So it should skip compositing entirely, like `traceEnabled` does, and end
up **at least as fast as the draw-call sweep**.

**Implementation notes.**
- Keep the digest OUT of the draw-call trace stream. They are separate oracles;
  mixing them breaks 66/66.
- Add `ts/tools/oracle-diff/digest.py` mirroring `sweep.py` (all 66 tags, poll
  `__ready`, unequal length is a FAILURE not a prefix match).
- The island/clouds fields are engine-side procedural state the port models
  separately. If they prove to diverge for reasons unrelated to compositing (e.g.
  the port's cloud RNG differs), drop those fields rather than weakening the
  oracle — `L=[...]` and the frame count are the load-bearing part.

**Verify — canary FIRST, before trusting a single green run** (INSIGHTS rule 1, and
the corollary that a probe reporting "no problem" is worthless until seen reporting
one). Introduce each of these deliberately and confirm the oracle FAILS:

1. clouds composited in the wrong slot (the bug no check caught);
2. a scene's final frame dropped (present after the reap instead of before);
3. a layer reaped one iteration early;
4. an extra present on an iteration where nothing drew.

If any of those still reports green, the oracle is broken — fix it before relying
on it. Record the four results in the commit message.

**Then.** Retire `pixels.py` to an occasional spot-check. Keep it — it is the only
thing that validates primitive rasterization — but it stops being a gate.

---

## Step 3 — Coroutine driver (the change that stops the bleeding)

**Problem.** `main.ts` encodes sequencing in flags: `advancing`, `keepStory`,
`keepBackground`, `story.walk !== null`, `scheduler.isDrained`,
`lastTickPresented`, `lastTickReaped`. 18 flag sites in main.ts, 9 in scheduler.ts.
Four of the five bugs above are flag-interaction bugs.

**Change.** Express the driver as an async coroutine that reads like `storyPlay`:

```ts
async function storyPlay(signal: AbortSignal) {
  while (!signal.aborted) {
    const episode = story.buildEpisode();      // island state computed here
    await buildIsland();                       // adsInitIsland
    let prevSpot: number | null = null;        // story.go:168 — reset PER EPISODE
    let prevHdg = 0;
    for (const scene of episode) {
      setSceneOffset(scene);                   // ttmDx before the walk (story.go:207)
      if (prevSpot !== null) await playWalk(prevSpot, prevHdg, scene.spotStart, scene.hdgStart);
      if (scene.dayNo !== 0) sound.play(17);
      await playScene(scene);
      prevSpot = scene.spotEnd;                // UNCONDITIONAL (story.go:227)
      prevHdg = scene.hdgEnd;
    }
    releaseIsland();                           // adsReleaseIsland
  }
}
```

`await playScene(...)` resolves when the ADS script drains; `await playWalk(...)`
resolves when `walkAnimate` returns delay 0. The rAF loop's only job becomes:
pump the active pump-function, advance the island metronomes, present.

**Flags this deletes:**

| flag | why it goes |
|---|---|
| `advancing` | no re-entrancy — the coroutine is at one statement |
| `keepStory` | teardown is scoped to `playScene`'s lifetime |
| `story.walk` as mode selector | a walk is just what `playWalk` is awaiting |
| `isDrained` branch in the loop | becomes `playScene`'s resolve condition |
| `lastTickPresented`/`lastTickReaped` | present once per iteration, at the engine's point |

**Flags that must stay** (verify each is load-bearing before deleting — INSIGHTS
rule 5, and test the hypotheses that say "we don't need this"):

- `suppressDraw` (interpreter, 34 sites, one mechanism): fast-forward replays a
  prologue to reach an entry tag; the engine jumps straight to the tag offset.
  Genuinely required.
- `TtmThread.keepBackground`: **re-test after Step 1.** With the island as a proper
  slot, a scene's `LOAD_SCREEN` of ISLETEMP.SCR may no longer collide with it. If
  it does not, delete the flag.
- `loopForever`: standalone TTM viewing has no ADS duration timer. Required.

**Constraint.** The harness entry points must keep working unchanged:
`window.__ready`, `__load`, `__trace`, `__shots`, `__schedlog`, `__dumpStep`, and
`?dump` mode's synchronous stepper. The coroutine must therefore be pumpable
synchronously — drive it from an explicit step function, not from raw `await` on
timers. If `?dump` mode cannot pump the coroutine, keep `?dump` on the existing
direct-tick path and let only interactive playback use the coroutine.

**Verify.** Run the digest oracle after **every** edit, not just at the end — that
is what Step 2's speed budget bought. On completion: all oracles green (draw-call
66/66, digest, story-check, walk 1792/1792) **plus** a long unattended run: no
wedge, no blink, no teleport, waves and clouds animating throughout, scene count
decrementing by exactly one per beat.

The digest cannot see everything either. It has no opinion on *pixels* (that is the
draw-call and pixel oracles) and none on wall-clock pacing — a build that plays at
8x speed passes it. Watch the real thing before calling Step 3 done.

---

## Step 4 — Delete flags against the engine

With Steps 1-3 done and the digest oracle in place, remove remaining accidental
complexity one flag at a time, re-running the digest oracle after each:

1. Re-test `keepBackground` (see above); delete if Step 1 made it redundant.
2. Audit `scheduler.ts`'s remaining flags against ads.go:741-800 — every one that
   does not correspond to engine state is suspect.
3. Grep `main.ts` for `story.` field accesses; anything not present in `storyPlay`
   is port-invented and needs justification or deletion.
4. Re-measure `wc -l ts/src/main.ts`. Target: within ~2x of the engine's 265 lines
   for equivalent responsibility. If it is still 900+, the restructure did not land.

---

## Guardrails

- **Do not start Step 3 before Step 2 is green and canary-tested.** The restructure
  is unverifiable without it.
- **No text oracle can see wall-clock pacing.** All of them (draw-call, digest,
  schedlog) step by frame with pacing disabled, so a build running at 8x speed
  passes every one. That exact bug has happened here — charging 1 tick instead of
  `mini` per iteration. Step 3 rewrites the loop that owns pacing, so after it,
  time a known scene against the Go engine on the wall clock, or watch it. One
  measurement, but it must be taken.
- **One step per commit.** Each commit states which oracles ran and their numbers.
- **Never delete a flag without first proving it is not load-bearing** — flip it,
  observe the failure, then decide. Three root-cause stories in this repo's history
  were confidently wrong because they were inferred rather than measured.
- **Run the thing and look at it after every step.** Every bug in the table above
  was found by a human watching the screen while both sweeps read green.
- Keep `git status` clean of diagnostic patches; revert instrumentation before
  committing.
