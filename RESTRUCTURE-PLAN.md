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

**Verify.** Clouds visible in front of the ocean and behind Johnny; capture a frame
where Johnny stands under a cloud and confirm he is drawn over it. Draw-call oracle
66/66, pixel oracle 53/66 with the same 13 scenes.

**Note.** `presentLayersOnly()` (pixel-oracle reference format) must keep excluding
the island and clouds — graphics.go:850 does the same under `traceShots`. Only
`savedZones` + `layers[]` + `holiday`.

---

## Step 2 — Frame-digest oracle (the missing instrument)

**Problem.** The draw-call oracle is structurally blind to the compositor. The pixel
oracle is slow (~6 min), has 13 permanently-failing scenes from GL tie-break
residue, and **caught none of the five bugs above**. Nothing verifies composite
structure or presentation timing.

**Change.** Both engines emit one text line per **presented composite**, diffed like
`sweep.py`. Proposed format — one line, stable field order, no floats:

```
F <n> bg=<SCR|none> isl=<x>,<y>,tide=<hi|lo>,raft=<0-5>,night=<0|1> clouds=<count> zones=<0|1> L=[<slot>:<tag>@<nsprites>,...] hol=<0-4>
```

Rules:
- Emitted at the composite point, i.e. exactly where `grUpdateDisplay` is called
  (ads.go:771) and where `onPresent` fires in the port — **one line per displayed
  composite**, not per traced frame and not per scheduler iteration. This is the
  same alignment rule the pixel oracle already documents in INSIGHTS.md; get it
  wrong and the sequences misalign and every later line differs.
- `L=[...]` lists live thread layers in composite order with a per-layer sprite
  count. This is what catches z-order, layer lifetime, and reap-timing bugs.
- Go side: gate behind a new flag (e.g. `-framedigest`), reusing the
  `-traceserver` stdout protocol so `sweep.py`'s harness is reused wholesale.
- TS side: `window.__digest(n)` alongside `__trace(n)`, same runner
  (`runForFrames`).

**Implementation notes.**
- Do NOT reuse the `traceEnabled` early-return in `grUpdateDisplay`
  (graphics.go:687) — that path skips compositing entirely. Digest mode needs the
  real composite structure, like `traceShots` does.
- Keep the digest OUT of the draw-call trace stream. They are separate oracles;
  mixing them breaks 66/66.
- Add `ts/tools/oracle-diff/digest.py` mirroring `sweep.py` (all 66 tags, poll
  `__ready`, unequal length is a FAILURE not a prefix match).

**Verify.** Canary-test the harness before trusting it (INSIGHTS rule 1): confirm it
FAILS when clouds are moved to the wrong slot, when a scene's final frame is
dropped, and when a layer is reaped one iteration early. A digest oracle that passes
those three is trustworthy; one that only reports 66/66 is not.

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

**Verify.** All oracles green (draw-call 66/66, digest, story-check, walk 1792/1792)
**plus** a long unattended run: no wedge, no blink, no teleport, waves and clouds
animating throughout, scene count decrementing by exactly one per beat.

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
- **One step per commit.** Each commit states which oracles ran and their numbers.
- **Never delete a flag without first proving it is not load-bearing** — flip it,
  observe the failure, then decide. Three root-cause stories in this repo's history
  were confidently wrong because they were inferred rather than measured.
- **Run the thing and look at it after every step.** Every bug in the table above
  was found by a human watching the screen while both sweeps read green.
- Keep `git status` clean of diagnostic patches; revert instrumentation before
  committing.
