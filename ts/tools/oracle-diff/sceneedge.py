#!/usr/bin/env python3
"""Is there a composite at a SCENE BOUNDARY where the figure is missing?

Companion to screensaver.py, which watches a beat's interior. This watches the
EDGES — the walk->scene handover, where a user reported Johnny vanishing for a
frame that screensaver.py scored 0 blinks on.

Why screensaver.py missed it, twice over: its blink test needs EVERY scene layer
empty at once AND looks for a SINGLE blank between two full composites. The real
defect produced TWO consecutive blanks at the end of every walk, so the
"isolated dip" pattern never matched. Printing the pixel counts either side of
each beat transition made it obvious at a glance:

    before:  walking -> SCENE   [.., 529, 508, 0, 0, 529, ..]
    after:   walking -> SCENE   [.., 530, 505, 505, 530, 383, ..]

Method: hook present() and record, per composite, the total opaque pixels of the
scene layers PLUS how many of them are on the island's own body (the region
where Johnny stands). A composite whose scene content collapses to near-nothing
between two composites that both had substantial content is the symptom, whether
or not it reached exactly zero.

Also records the beat, so a dip can be attributed to a scene START or END.
"""
import os, sys, json, random, time

TS_URL = os.environ.get("TS_URL", "http://localhost:5199")

HOOK = r"""
() => {
  const r = window.__renderer;
  window.__log = [];
  const orig = r.present.bind(r);
  const W = 640, H = 480;
  r.present = function () {
    orig();
    let total = 0;
    // Sample every 3rd pixel: enough to see a figure appear/vanish, ~9x cheaper
    // than a full scan, and this runs inside the render loop.
    for (const cv of r.__layerCanvases()) {
      const c = new OffscreenCanvas(W, H).getContext("2d", {willReadFrequently: true});
      c.drawImage(cv, 0, 0);
      const d = c.getImageData(0, 0, W, H).data;
      for (let i = 0; i < W * H; i += 3) if (d[i * 4 + 3] >= 250) total++;
    }
    const hud = (document.getElementById("hud") || {}).textContent || "";
    window.__log.push({
      n: total,
      layers: r.__layerCanvases().length,
      beat: (hud.split(" — ")[2] || "").trim(),
    });
    if (window.__log.length > 20000) window.__log.shift();
  };
}
"""


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 150
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 700, "height": 560})
        pg.goto(f"{TS_URL}/?story=1&cb={random.randint(0,10**9)}", wait_until="networkidle")
        pg.wait_for_function("() => window.__renderer !== undefined", timeout=15000)
        pg.wait_for_timeout(1500)
        pg.evaluate(HOOK)
        pg.wait_for_timeout(int(secs * 1000))
        log = pg.evaluate("() => window.__log")
        b.close()

    if not log:
        print("no composites recorded"); sys.exit(1)

    ns = [e["n"] for e in log]
    typical = sorted(ns)[len(ns) // 2]
    print(f"composites {len(log)}  median scene pixels {typical}")

    # A DIP: content collapses to <15% of typical, between two composites that
    # both had >50% of typical. That is a figure vanishing for one frame,
    # whether or not it hit exactly zero.
    lo, hi = max(1, typical * 15 // 100), typical * 50 // 100
    dips = []
    for i in range(1, len(log) - 1):
        a, c, d = log[i - 1], log[i], log[i + 1]
        if a["n"] > hi and c["n"] < lo and d["n"] > hi:
            dips.append((i, a["n"], c["n"], d["n"], a["beat"], c["beat"], d["beat"]))

    # Also: transitions where the beat CHANGES, and what content did across it.
    edges = []
    for i in range(1, len(log)):
        if log[i]["beat"] != log[i - 1]["beat"]:
            lo_i, hi_i = max(0, i - 3), min(len(log), i + 4)
            edges.append((log[i - 1]["beat"], log[i]["beat"],
                          [log[j]["n"] for j in range(lo_i, hi_i)]))

    print(f"one-frame dips (<{lo} between two >{hi}): {len(dips)}")
    for d in dips[:8]:
        print(f"   #{d[0]}: {d[1]} -> {d[2]} -> {d[3]}   beats {d[4]!r} | {d[5]!r} | {d[6]!r}")

    print(f"\nbeat transitions: {len(edges)}")
    for a, c, window in edges[:12]:
        print(f"   {a!r} -> {c!r}: {window}")

    sys.exit(0 if not dips else 1)


if __name__ == "__main__":
    main()
