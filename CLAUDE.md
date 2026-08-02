# Working in this repo

`INSIGHTS.md` is the substantive reference — read it first, especially the seven
method rules at the top. `RESTRUCTURE-PLAN.md` is the current work plan. This
file only covers how to RUN things without breaking your own machine or your
own measurements.

## Running the oracles

All commands below are run from `ts/`, with a vite server on `:5199`
(`npx vite --port 5199 --strictPort`) and a built Go binary
(`go build -o JohnnyCastaway2026 .` in the repo root).

**Pin Playwright to 1.61.0.** Plain `--with playwright` resolves to whatever is
newest and then demands an uncached browser build, and the sweep dies at launch.

| Check | Command | Window? |
|---|---|---|
| Draw calls | `uv run --with playwright==1.61.0 python tools/oracle-diff/sweep.py 150` | headless |
| Frame digest | `uv run --with playwright==1.61.0 python tools/oracle-diff/digest.py 60` | headless |
| Pixels | `uv run --with playwright==1.61.0 --with pillow --with numpy python tools/oracle-diff/pixels.py 60` | **needs a window** |
| Walk | `npm run walk-check` | n/a |
| Story logic | `npm run story-check` | n/a |
| Cloud/slot order | `uv run --with playwright==1.61.0 python tools/oracle-diff/cloudorder.py 45` | browser only |

### Do not pop a window unless the check needs one

The two TEXT oracles (`sweep.py`, `digest.py`) run **headless by default** and
must stay that way. Neither draws anything: the draw-call trace comes from
ttmPlay's opcode handlers and `grUpdateDisplay` returns early, and the digest
reads the layer list straight off `grUpdateDisplay`'s arguments. Verified
byte-identical between `DISPLAY=:0` and `DISPLAY=` (md5-compared over
STAND/FISHING/JOHNNY). They set `DISPLAY=""` on the child themselves.

Set `ORACLE_WINDOW=1` to get a decorated, watchable window back when you
actually want to see a sweep run.

**`pixels.py` is the exception and keeps its window by default** — it captures
real composited frames (`traceShots` → `grCaptureFrame` →
`LoadImageFromTexture`), so it needs a live GL surface. Don't "fix" it to match
the others.

Running the Go engine by hand (`-trace`, `-traceserver`, `-framedigest`) on the
WSLg display works with `DISPLAY=:0` (Mesa llvmpipe). Do **not** use `xvfb-run`
— it forces `DISPLAY=:99` and segfaults.

## Instrumentation hygiene

Revert diagnostic patches before committing; `git status` should carry no
scratch instrumentation. Anything that must stay (e.g. the `__renderer` /
`__island` / `__slotCanvas` handles that `cloudorder.py` needs) gets a comment
saying which check consumes it and why no existing oracle covers that ground.

Scratch scripts belong in the session scratchpad, not the repo. A probe only
graduates into `ts/tools/oracle-diff/` once it has been canary-tested — see the
next section.

## Before trusting any new probe, make it fail

INSIGHTS rule: *a probe that reports "no problem" is worthless until you have
seen it report one.* Introduce the bug deliberately, confirm the probe goes red,
then revert and confirm it goes green. Both directions, recorded.

Two traps that cost real time here, both specific to this setup:

- **Vite HMR races the probe.** Editing a source file mid-run leaves
  `window.__renderer` pointing at a stale module instance whose slots are empty,
  which reads as a silent all-zero "INCONCLUSIVE" — not as an error. Browser
  probes should cache-bust (`?cb=<random>`) and you should let vite settle
  before starting a run.
- **Sampling a live rAF loop is racy.** Reading a slot canvas and the visible
  canvas at different moments lets the cloud animation move between the two,
  which surfaces as phantom "wrong pixel" results one column apart. Re-composite
  synchronously (`renderer.present()`) and snapshot, rather than sampling
  whatever the loop last painted.

## Determinism: three seeded RNG streams

Every field the digest reports is deterministic, because the oracles run on
**three independent seeded streams**, re-seeded per scene:

| stream | Go | TS | covers |
|---|---|---|---|
| ADS | `traceRngAds` | `randAds` | scene selection (RANDOM blocks) |
| TIMER | `traceRngTimer` | `randTimer` | the TTM `TIMER` opcode |
| island | `traceRngIsland` / `islandRand` | `randIsland` | backdrop, tide, VARPOS position, clouds |

They are **isolated on purpose**: a shared stream lets one subsystem's draw
count shift another's choices. That was learned the hard way for ADS/TIMER, and
the island stream was added for the same reason.

Before the island stream existed, that code read the unseeded global `rand`,
which made **the Go engine nondeterministic against itself** — 10 identical
`STAND 2` runs gave 4 `tide=hi` / 6 `tide=lo`, cloud counts 4/1/2, backdrop
`OCEAN02`/`OCEAN01`. The first *four* runs agreed before the flake appeared, so
sample properly (15-20 runs) before trusting a field. The right fix was seeding
the stream, not shrinking the format.

Two constraints when touching island RNG:

- **Draw count and order must match on both sides.** Go's `&&` short-circuits,
  so a scene without `LOWTIDE_OK` performs *no* tide draw; the VARPOS block does
  1-3 coin flips plus 2 range draws depending on the branch. `__digest` runs the
  REAL `Story.calculateIslandFromScene` rather than a reimplementation for
  exactly this reason.
- **Outside trace mode both engines fall back to the normal random**, so real
  playback keeps its variety. Only the oracles are deterministic.

**The backdrop NAME is deliberately not reported**, for a different reason: it
measures "who last called `LOAD_SCREEN`", which the two architectures answer
differently by design (the engine's island installs `OCEAN0n`/`NIGHT`; the port
keeps a baked `ISLETEMP` and suppresses the scene's load via `keepBackground`).
Comparing it would encode a false equivalence. Everything the choice depends on
— night, tide, position — is reported directly instead.
