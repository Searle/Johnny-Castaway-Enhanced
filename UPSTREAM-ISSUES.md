# Upstream issues

Engine bugs found in this fork that also exist **upstream**
(`fbreve/Johnny-Castaway-Enhanced`, remote `origin`), staged here so they can be
turned into focused pull requests later.

Scope: only genuine *bugs in shared engine code* belong here. This fork's Linux
/ WebAssembly port, the TypeScript port in `ts/`, the oracle-diff tooling and
the asset extractor are additions, not fixes, and are out of scope for upstream
PRs.

Each entry records what is wrong, how it was proven, and what a minimal
upstream-only patch looks like — deliberately separate from how the fix landed
here, since our commits are entangled with port-specific work.

---

## 1. `grSetClipZone` treats inclusive corners as an exclusive span

**Status:** fixed here in `06f6862`; still present upstream.
**Upstream location:** `graphics.go`, `grSetClipZone()` — line 1237 at
`origin/main` `6a16941`.
**Introduced by:** `3668ac8` "Fix palm tree climbing clipping bug" (2026-06-27).
**Severity:** cosmetic. One column and one row of a clip zone are lost. Almost
never visible in play, because the affected pixels sit at the outer edge of a
zone the original artists sized with margin.

### The bug

The TTM `SET_CLIP_ZONE` (`0x4004`) args are `(x1, y1, x2, y2)` — top-left and
**bottom-right corners, both inside the zone**. The span is therefore
`x2 - x1 + 1` columns. The code computes:

```go
w := x2 - x1
h := y2 - y1
```

which clips one column and one row short.

This is not a matter of interpretation: the same function's full-screen-reset
test already assumes the inclusive convention —

```go
isFullScreenReset := x1 <= 0 && y1 <= 0 &&
    x2 >= int16(screenWidth-1) && y2 >= int16(screenHeight-1)
```

`x2 >= screenWidth-1` only means "reaches the last column" if `x2` is an
inclusive coordinate. The width computation contradicts it. The commit's own
comment likewise describes the args as corners ("the dump disassembler labels
arg3/arg4 as `w` and `h` but they are really x2 and y2").

The `x2-x1` form was inherited faithfully from the original SDL2 source, which
the commit quotes in a comment it removed:

```c
// SDL_Rect rect = { x1, y1, x2-x1, y2-y1 };
```

So this is an inherited off-by-one, not a slip introduced during the port.

### The fix

```diff
-	w := x2 - x1
-	h := y2 - y1
+	w := x2 - x1 + 1
+	h := y2 - y1 + 1
```

Nothing else changes. `w <= 0 || h <= 0` still rejects degenerate zones, and the
full-screen-reset path is untouched.

### Evidence

Concrete case — `MJFISH.TTM` sets the clip `(370,203)-(457,292)`:

| | width × height | right edge | bottom edge |
|---|---|---|---|
| upstream | 87 × 89 | 456 | 291 |
| correct | 88 × 90 | **457** | **292** |

Verified by rendering the same scenes through two independent engines and
comparing pixels (`ts/tools/oracle-diff/pixels.py`). Before the fix, 16 of 66
scenes differed; the clip fix accounts for 6 of them — FISHING:1/2/3/6,
ACTIVITY:9, WALKSTUF:3 — all with the identical signature of one missing column
plus one missing row.

Two hypotheses were eliminated first, so the attribution is not guesswork:
- the sprite **blit arithmetic** is identical between the two engines
  (9122/9122 cels, flipped and unflipped — `ts/tools/oracle-diff/blitcheck.py`);
- the **sprite dimensions** agree exactly (engine-resolved sizes vs the
  independently extracted bitmaps).

With both ruled out, replaying the frame with no clipping at all reached column
463 while both engines stopped at 456/457, which localised the cause to
clipping; logging the rect each engine actually applied then showed 87×89
against 88×90.

### Suggested PR

Title: `fix(graphics): SET_CLIP_ZONE spans are inclusive (x2-x1+1)`

Two-line change plus a comment recording the convention and pointing at the
full-screen-reset test as corroboration. Worth noting in the PR body that the
`x2-x1` form came from the SDL2 original, so the same off-by-one is likely
present in any other port derived from it.

The exact patch, applied and diffed against `origin/main` `6a16941`:

```diff
--- a/graphics.go
+++ b/graphics.go
@@ -1234,8 +1234,13 @@ func grSetClipZone(sur *rl.RenderTexture2D, x1, y1, x2, y2 int16) {
 		}
 	}
 
-	w := x2 - x1
-	h := y2 - y1
+	// The TTM args are INCLUSIVE corners: (x1,y1) and (x2,y2) are both pixels
+	// inside the zone, so the span is x2-x1+1 columns. The isFullScreenReset
+	// test above already assumes this (it treats x2 >= screenWidth-1 as
+	// "reaches the last column"). Computing x2-x1 — the form inherited from
+	// the SDL2 original — clipped one column and one row short.
+	w := x2 - x1 + 1
+	h := y2 - y1 + 1
 
 	if w <= 0 || h <= 0 {
 		delete(activeClipZones, sur)
```

**Verification status — read before opening the PR.** The patch applies cleanly
to `origin/main` and the hunk is `gofmt`-clean. It has **not** been run against
pristine upstream, because upstream `main` does not compile on Linux
(`graphics.go:55` `syscall.NewLazyDLL` — Windows-only APIs in a shared file;
splitting those out is part of this fork's Linux port, not upstream). The
behavioural evidence above comes from this fork's build, where the surrounding
`grSetClipZone` code is byte-identical to upstream's. Anyone preparing the PR
should confirm on Windows, or state plainly that it was verified on a Linux
fork of the same function.

Note `gofmt -l graphics.go` already reports upstream's own file as unformatted
(an unrelated struct-alignment block). A PR should **not** reformat it — keep
the diff to the two lines.

---

## Observations — not (yet) filed as bugs

Things noticed while working in shared code that look suspicious but have **not**
been proven wrong, and should not go into a PR without evidence.

- **`grCopyZoneToBg` uses `width+2`.** Upstream documents this as a deliberate
  workaround for a ~2px authoring gap in GJVIS6's tanker-hull data. Given issue
  1, it is worth asking whether part of that fudge was really compensating for
  the same inclusive/exclusive confusion — but the current comment describes a
  data problem, and no measurement here contradicts it.

- **`grDrawSpriteFlip` carries a commented-out `x += width - 1`** ("In original
  C, but NOT NEEDED, in Raylib"). That assessment is **correct**: the headless
  comparator confirms raylib's negated-source-rect flip and a Canvas2D mirror
  about `x+w` produce identical column mappings. Recorded here only because it
  looks like an off-by-one and is not one — an earlier attempt to "fix" it made
  rendering measurably worse.

---

## Not upstream issues

For the record, so they are not re-investigated:

- `ads.go` "the `inSkipBlock = 0|1` were swapped originally" and the
  `numAdsChunksLocal` gating fix are **already in upstream** — they are
  upstream's own fixes, inherited here.
