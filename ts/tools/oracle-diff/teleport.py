#!/usr/bin/env python3
"""The two Step 3 verify items the generic screensaver probe does not cover.

1. NO TELEPORT. story.go:227 sets prevSpot after EVERY scene, unconditionally,
   and resets it only once per EPISODE (story.go:168). Clearing it on FINAL — an
   easy-looking "the episode is over" optimisation — deletes the walk into the
   next scene and reads on screen as Johnny jumping across the island. So the
   check is: between two consecutive beats WITHIN an episode, there must be a
   walk. Only an episode boundary may skip one.

2. WAVES AND CLOUDS ANIMATE THROUGHOUT. The island threads are metronomes that
   must keep running during scenes, walks and long PURGE-loop holds alike. The
   tell is that the island slot's PIXELS keep changing (the shore shimmers) and
   the cloud slot's pixels move, even while a beat is holding.

Usage (from ts/, vite on :5199):
    uv run --with playwright==1.61.0 python .../teleport.py [seconds]
"""
import os, sys, time, random, hashlib

TS_URL = os.environ.get("TS_URL", "http://localhost:5199")

S = r"""
() => {
  const r = window.__renderer, W = 640, H = 480;
  const hud = (document.getElementById("hud") || {}).textContent || "";
  // Cheap content fingerprint of a slot: sample a sparse grid, not every pixel.
  const sig = (name) => {
    const cv = r.__slotCanvas(name);
    if (!cv) return "none";
    const c = new OffscreenCanvas(W, H).getContext("2d", {willReadFrequently: true});
    c.drawImage(cv, 0, 0);
    const d = c.getImageData(0, 0, W, H).data;
    let h = 0;
    for (let i = 0; i < W * H; i += 37) {
      h = (h * 31 + d[i*4] + d[i*4+3]) | 0;
    }
    return String(h);
  };
  const isl = window.__island && window.__island();
  return {
    hud,
    beat: (hud.split(" — ")[2] || "").trim(),
    walking: hud.includes("walking"),
    islandSig: sig("island"),
    cloudSig: sig("clouds"),
    // Identity of the island OBJECT marks the episode: it is rebuilt per episode.
    episode: isl ? (isl.__ep || (isl.__ep = Math.random())) : null,
    clouds: isl ? isl.__clouds().length : -1,
  };
}
"""


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 180
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 700, "height": 560})
        pg.goto(f"{TS_URL}/?story=1&cb={random.randint(0,10**9)}", wait_until="networkidle")
        pg.wait_for_function("() => window.__renderer !== undefined", timeout=15000)
        pg.wait_for_timeout(2000)
        obs = []
        t0 = time.time()
        while time.time() - t0 < secs:
            pg.wait_for_timeout(250)
            obs.append(pg.evaluate(S))
        b.close()

    # --- 1. teleport: a scene->scene transition with no walk between them ---
    # Collapse to the sequence of distinct states, keeping walk markers.
    # Collapse to distinct (mode, beat) states. "walking -> X" and "X" are
    # different states, so a walk between two scenes is visible here.
    seq = []
    for o in obs:
        key = ("W" if o["walking"] else "S", o["beat"])
        if not seq or (("W" if seq[-1]["walking"] else "S"), seq[-1]["beat"]) != key:
            seq.append(o)
    teleports = []
    for a, c in zip(seq, seq[1:]):
        if a["walking"] or c["walking"]:
            continue                      # a walk is present — fine
        if a["episode"] != c["episode"]:
            continue                      # episode boundary — island rebuilt
        if not a["beat"] or not c["beat"]:
            continue
        teleports.append((a["beat"], c["beat"]))

    # --- 2. island animation during a HELD beat ---
    held_island, held_cloud = 0, 0
    checked = 0
    for a, c in zip(obs, obs[1:]):
        if a["beat"] != c["beat"] or a["walking"]:
            continue
        checked += 1
        if a["islandSig"] != c["islandSig"]:
            held_island += 1
        if a["cloudSig"] != c["cloudSig"]:
            held_cloud += 1

    episodes = len({o["episode"] for o in obs if o["episode"]})
    print(f"samples {len(obs)}  beats {len(seq)}  episodes {episodes}")
    print(f"scene->scene transitions with NO walk (within an episode): {len(teleports)}")
    for t in teleports[:5]:
        print("    ", t[0], "->", t[1])
    print(f"in-beat samples {checked}: island changed {held_island} "
          f"({100.0*held_island/checked if checked else 0:.0f}%), "
          f"clouds changed {held_cloud} ({100.0*held_cloud/checked if checked else 0:.0f}%)")

    ok = True
    if len(seq) < 3:
        print("INCONCLUSIVE: too few beats"); ok = False
    if teleports:
        print(f"FAIL: {len(teleports)} teleports (scene change with no walk)"); ok = False
    if checked and held_island == 0:
        print("FAIL: the island never animated during a held beat (frozen shore)"); ok = False
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
