#!/usr/bin/env python3
"""Locate state that leaks across window.__load during a sweep.

18 digest scenes pass under COLD_RELOAD=1 and fail in the normal in-page sweep,
so something carries over between scenes that a page reload clears. INSIGHTS.md
states the invariant this breaks: "In-page scene switching (window.__load) must
stay equivalent to a cold reload."

Rather than guess at candidates, this fingerprints EVERY piece of state that
could plausibly carry over, at the same point in each scene (just before the
frame-counted run), and diffs the fingerprint sequence between a warm sweep and
a cold one. The FIRST scene whose fingerprint differs is where the leak lands,
and the FIELD that differs names it — one measurement, one possible cause.

Fields covered: the three seeded RNG streams, TtmThread statics, the scheduler's
island metronomes and thread array, renderer slot presence, and the digest's own
frame counter.

Usage (from ts/, vite on :5199):
    uv run --with playwright==1.61.0 python tools/oracle-diff/leakcheck.py [n]

`n` is how many scenes of the sweep order to walk (default 40).
"""
import json, os, sys

TS_URL = os.environ.get("TS_URL", "http://localhost:5199")
HERE = os.path.dirname(__file__)
TS = os.path.abspath(os.path.join(HERE, "..", ".."))
INDEX = os.path.join(TS, "public", "anim", "index.json")

# Runs in the page, immediately after __load and before any frame stepping.
FINGERPRINT = r"""
() => {
  const s = window.__sched;
  const r = window.__renderer;
  const st = window.__ttmStatics ? window.__ttmStatics() : null;
  const slot = (n) => (r && r.__slotCanvas(n) ? 1 : 0);
  return {
    // Scheduler-visible engine state.
    threads: s ? s.debugScenes().map(x => `${x.slot}:${x.tag}/${x.delay}`).join(",") : "none",
    metronome: s && s.__metronome ? s.__metronome() : "n/a",
    // Renderer slots: island/clouds/holiday should be absent in the ADS viewer.
    slots: `${slot("island")}${slot("clouds")}${slot("savedZones")}${slot("holiday")}`,
    layers: r ? r.__layerCanvases().length : -1,
    // Interpreter statics + RNG seeds.
    statics: st ? JSON.stringify(st) : "n/a",
  };
}
"""


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    with open(INDEX) as f:
        index = json.load(f)
    jobs = [(a["name"].replace(".ADS", ""), t)
            for a in index.get("ads", []) for t in a["tags"]][:limit]

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        def sweep(warm):
            """Walk the scene list, fingerprinting each. warm=True uses __load."""
            page = browser.new_page(viewport={"width": 700, "height": 560})
            out = []
            loaded = False
            for name, tag in jobs:
                if warm and loaded:
                    ok = page.evaluate(
                        f"() => window.__load({json.dumps(name + '.ADS')}, {tag})")
                    if not ok:
                        out.append((name, tag, {"err": "load rejected"}))
                        continue
                else:
                    page.goto(f"{TS_URL}/?ads={name}.ADS&tag={tag}&dump=1",
                              wait_until="networkidle")
                    page.wait_for_function(
                        "() => typeof window.__load === 'function'", timeout=8000)
                    loaded = True
                page.wait_for_function("() => window.__ready === true", timeout=8000)
                out.append((name, tag, page.evaluate(FINGERPRINT)))
                # Consume the scene exactly as the digest sweep does, so the
                # NEXT scene inherits whatever this one leaves behind.
                page.evaluate("() => window.__digest(60)")
            page.close()
            return out

        warm = sweep(True)
        cold = sweep(False)
        browser.close()

    print(f"{len(jobs)} scenes fingerprinted (warm = __load, cold = full reload)\n")
    first = None
    for (n, t, w), (_, _, c) in zip(warm, cold):
        diffs = [k for k in w if w[k] != c.get(k)]
        if diffs:
            if first is None:
                first = (n, t, diffs, w, c)
            print(f"  DIFF {n}:{t}  fields: {', '.join(diffs)}")
    if first is None:
        print("  no fingerprint differences — the leak is in state this probe "
              "does not cover; widen FINGERPRINT.")
        sys.exit(1)
    n, t, diffs, w, c = first
    print(f"\nFIRST leak at {n}:{t}")
    for k in diffs:
        print(f"  {k}:\n    warm: {str(w[k])[:200]}\n    cold: {str(c.get(k))[:200]}")
    sys.exit(1)


if __name__ == "__main__":
    main()
