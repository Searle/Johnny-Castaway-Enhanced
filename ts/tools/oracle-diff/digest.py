#!/usr/bin/env python3
"""FRAME-DIGEST oracle: diff the COMPOSITE STRUCTURE of both engines.

The draw-call sweep (sweep.py) proves the INTERPRETER is right — same sprites,
coords, order, timing — but it is structurally blind to the compositor. The
pixel oracle (pixels.py) only partly covers that gap, costs ~6 minutes, and
caught none of the compositor bugs that humans found by watching the screen.

This diffs one line per DISPLAYED COMPOSITE from each engine:

    F <n> isl=<x>,<y> tide=<hi|lo> raft=<0-5> night=<0|1> clouds=<n> zones=<0|1> L=[<slot>:<tag>,...] hol=<0-4>

`L=[...]` is the payload: WHICH thread layers composite, in WHAT ORDER, and —
via the line's position in the sequence — WHEN. That is exactly the blind spot:
z-order, layer lifetime and presentation timing.

Every field is deterministic: the island's procedural state (tide, position,
clouds) runs on a THIRD seeded RNG stream (traceRngIsland / randIsland),
isolated from the ADS and TIMER streams and re-seeded per scene. Before that
existed it read the unseeded global rand and the GO ENGINE DISAGREED WITH
ITSELF run to run. The backdrop NAME is still excluded, but for an unrelated
reason — it measures "who last called LOAD_SCREEN", which the two architectures
answer differently by design. See the format note in trace.go.

It is a TEXT oracle emitted from the arguments already at hand, so it skips
compositing entirely and runs at draw-call-sweep speed (measured: 27s for all
66 tags, headless) — fast enough to run after every edit, which is the point.

WHAT THIS ORACLE CANNOT SEE — canary-tested, not assumed. RESTRUCTURE-PLAN.md
Step 2 lists four deliberate bugs the digest must catch. Measured results:

  2. scene's final frame dropped (present after the reap)  CAUGHT (93->92)
  3. a layer reaped one iteration early                    CAUGHT (93->104)
  4. an extra present on a no-draw iteration               CAUGHT (93->128)
  1. clouds composited in the wrong slot                   *** NOT CAUGHT ***

Canary 1 slips through by construction: `L=[...]` lists SCENE THREADS, and the
clouds are a fixed compositor slot that never appears in it. Three
baseline-passing scenes stayed green with the clouds deliberately blitted above
every scene layer. The plan's claim that the digest makes the Step 1 compositor
work verifiable is therefore WRONG, and seeding the island RNG did not change it:
`clouds=<n>` reports how many clouds EXIST, never which SLOT they composite in.
Nothing in a per-composite text line can express z-order between a fixed slot
and the scene array.

Slot ORDER is covered by cloudorder.py instead, which reads the slots directly
and asks who wins where a cloud and a scene overlap. Run BOTH; neither is a
substitute for the other.

Usage (from ts/, with a vite server on :5199 and the Go binary built):
    uv run --with playwright==1.61.0 python tools/oracle-diff/digest.py [frames]
    uv run --with playwright==1.61.0 python tools/oracle-diff/digest.py 60 STAND 2
"""
import json, os, sys, subprocess, difflib
import functools
print = functools.partial(print, flush=True)  # observable in background runs

# Scenes that still diverge.
#
# WALKSTUF:1 is the only genuine one left. The other 18 (MARY:5, MISCGAG:1/2 and
# every STAND) were ONE bug, fixed in scheduler.ts: restart() — adsPlay
# re-entry for a script that ran dry — was re-initialising the island
# metronomes, which adsInitIsland only ever does ONCE per scene, before the
# engine's `for !traceReachedBudget { adsPlay(...) }` loop. Resetting bg to 8
# mid-scene put it half a period out of step, which changed `mini` and therefore
# the composite count for the rest of the run. Localised by logging the re-arm
# DECISION on both sides: the sequences were identical for 69 events, then the
# engine read bg=5 where the port read bg=8. With the fix the schedlogs match
# exactly, 475 = 475 lines with zero differences.
#
# KNOWN HARNESS ISSUE — run with COLD_RELOAD=1 for a true reading. Those 18 pass
# on a cold reload and still fail in the normal in-page sweep, so state leaks
# across window.__load, breaking INSIGHTS.md's "__load must stay equivalent to a
# cold reload" invariant.
#
# ONE leak has been found and fixed (stale traceFrameNo/traceReachedBudget: see
# stopPlayback in main.ts) using tools/oracle-diff/leakcheck.py, which
# fingerprints every carry-over candidate at scene start and diffs a warm sweep
# against a cold one. Warm and cold fingerprints now match over 20 scenes, yet
# the warm sweep still fails — so at least one more leak lives in state that
# probe does not yet cover. Widen FINGERPRINT and run it again; the most likely
# remaining candidate is the shared `manifest` handed out by loadAnimation's
# cache (LoadedSheet itself is immutable — name + frames — so the sheets are
# not the suspect).
#
# Never grow this list to make a run green.
KNOWN_FAILING = {
    ("WALKSTUF", 1),
    # Pass on COLD_RELOAD=1; fail in the in-page sweep only (see above).
    ("MARY", 5), ("MISCGAG", 1), ("MISCGAG", 2),
    ("STAND", 1), ("STAND", 2), ("STAND", 3), ("STAND", 4), ("STAND", 5),
    ("STAND", 6), ("STAND", 7), ("STAND", 8), ("STAND", 9), ("STAND", 10),
    ("STAND", 11), ("STAND", 12), ("STAND", 14), ("STAND", 15), ("STAND", 16),
}

HERE = os.path.dirname(__file__)
TS = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(TS, ".."))
INDEX = os.path.join(TS, "public", "anim", "index.json")
GO_BIN = os.path.join(REPO, "JohnnyCastaway2026")
TS_URL = os.environ.get("TS_URL", "http://localhost:5199")


class GoDigestServer:
    """Persistent `JohnnyCastaway2026 -framedigest` process — the same stdin/
    stdout protocol as -traceserver, so this is sweep.py's harness verbatim,
    only the block body carries digest lines instead of draw calls."""

    def __init__(self):
        cmd = [GO_BIN, "-framedigest"]
        env = dict(os.environ)
        # Run with NO window by default. The digest skips compositing entirely
        # (it reads the layer list off grUpdateDisplay's arguments), so it never
        # needs a visible surface — verified byte-identical between DISPLAY=:0
        # and DISPLAY= over STAND/FISHING/JOHNNY. Popping a raylib window on
        # every sweep is pure noise on the user's desktop.
        # ORACLE_WINDOW=1 restores a decorated, watchable window.
        if env.get("ORACLE_WINDOW", "0") != "0":
            cmd.append("-window")
        else:
            env["DISPLAY"] = ""
        self.proc = subprocess.Popen(
            cmd, cwd=REPO, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )

    def send(self, ads, tag, frames):
        if self.proc.poll() is not None:
            return False
        try:
            self.proc.stdin.write(f"{ads} {tag} {frames}\n")
            self.proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError):
            return False

    def read(self, ads, tag):
        want = f"===TRACE {ads}.ADS {tag}==="
        started = False
        body = []
        for line in self.proc.stdout:
            line = line.rstrip("\n")
            if not started:
                if line == want:
                    started = True
                continue
            if line == "===END===":
                return "\n".join(body)
            if line.startswith(("INFO:", "WARNING:")):
                continue
            body.append(line)
        return None  # EOF before END → server died mid-scene

    def close(self):
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.write("\n")  # blank line = quit
                self.proc.stdin.flush()
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def norm(text):
    return [l for l in text.splitlines() if l.startswith("F ")]


def main():
    frames = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    with open(INDEX) as f:
        index = json.load(f)
    if len(sys.argv) > 3:
        jobs = [(sys.argv[2].upper(), int(sys.argv[3]))]
    else:
        jobs = [(a["name"].replace(".ADS", ""), t) for a in index.get("ads", []) for t in a["tags"]]

    from playwright.sync_api import sync_playwright
    passed, failed, errored = [], [], []
    loaded = False
    go = GoDigestServer()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 700, "height": 560})
        for name, tag in jobs:
            go_ok = go.send(name, tag, frames)
            try:
                # In-page scene switching, exactly as sweep.py does it (a cold
                # reload per scene is ~95% of the wall clock).
                if loaded and os.environ.get("COLD_RELOAD") != "1":
                    ok = page.evaluate(f"() => window.__load({json.dumps(name + '.ADS')}, {tag})")
                    if not ok:
                        raise RuntimeError(f"__load rejected {name}.ADS:{tag}")
                else:
                    page.goto(f"{TS_URL}/?ads={name}.ADS&tag={tag}&dump=1", wait_until="networkidle")
                    page.wait_for_function("() => typeof window.__digest === 'function'", timeout=8000)
                    loaded = True
                page.wait_for_function("() => window.__ready === true", timeout=8000)
                ts = page.evaluate(f"() => window.__digest({frames})")
            except Exception as e:
                if go_ok:
                    go.read(name, tag)  # drain to stay in sync
                loaded = False
                errored.append((name, tag, str(e)[:60]))
                print(f"  ERR  {name}.ADS tag {tag}  ({str(e)[:50]})")
                continue
            gtext = go.read(name, tag) if go_ok else None
            if gtext is None:
                errored.append((name, tag, "go digest failed/died"))
                print(f"  ERR  {name}.ADS tag {tag}  (go digest failed)")
                continue
            g, t = norm(gtext), norm(ts)
            # Unequal length is a FAILURE, never a prefix match — the harness
            # invariant that a truncating comparison once violated here, faking
            # a confident 63/66 when the truth was 10/66.
            if len(g) != len(t):
                failed.append((name, tag, f"len {len(g)}vs{len(t)}"))
                print(f"  DIFF {name}.ADS tag {tag}  (length {len(g)} vs {len(t)})")
            elif len(g) == 0:
                errored.append((name, tag, "empty digest"))
                print(f"  ERR  {name}.ADS tag {tag}  (empty digest)")
            elif g == t:
                passed.append((name, tag))
                print(f"  ok   {name}.ADS tag {tag}  ({len(g)} composites)")
            else:
                d = sum(1 for x in difflib.unified_diff(g, t)
                        if x[:1] in "+-" and x[:2] not in ("++", "--"))
                failed.append((name, tag, f"{d} lines"))
                print(f"  DIFF {name}.ADS tag {tag}  ({d} lines differ)")
                if os.environ.get("DIGEST_VERBOSE"):
                    for x in list(difflib.unified_diff(g, t, "go", "ts", lineterm=""))[:20]:
                        print("      " + x)
        browser.close()
    go.close()

    total = len(jobs)
    print(f"\n=== {len(passed)}/{total} identical | {len(failed)} diverge | "
          f"{len(errored)} errored ({frames} frames) ===")
    if failed:
        print("Differing: " + ", ".join(f"{n}:{t} ({w})" for n, t, w in failed))
    if errored:
        print("Errored: " + ", ".join(f"{n}:{t}" for n, t, _ in errored))

    # The gate is REGRESSIONS, not the raw count: a known-failing scene going
    # green is progress, a fresh one going red is the thing to stop for.
    new = [(n, t, w) for n, t, w in failed if (n, t) not in KNOWN_FAILING]
    fixed = sorted(KNOWN_FAILING - {(n, t) for n, t, _ in failed}
                   & {(n, t) for n, t in jobs})
    if fixed:
        print(f"NOW PASSING (update KNOWN_FAILING): "
              + ", ".join(f"{n}:{t}" for n, t in fixed))
    if new:
        print(f"NEW REGRESSIONS ({len(new)}): "
              + ", ".join(f"{n}:{t} ({w})" for n, t, w in new))
    else:
        print("no new regressions" + (f" ({len(failed)} known-failing)" if failed else ""))
    sys.exit(0 if not new and not errored else 1)


if __name__ == "__main__":
    main()
