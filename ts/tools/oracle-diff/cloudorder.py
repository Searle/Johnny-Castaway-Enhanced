#!/usr/bin/env python3
"""Verify the fixed-slot compositor's CLOUD ORDER on the real screensaver.

Step 1 of RESTRUCTURE-PLAN.md moves clouds from the dynamic scene-layer array
into fixed slot 2 (above the island, below saved zones / scenes / holiday).
No text oracle covers that slot, so this probe asks the compositor directly.

The question "are clouds in the right slot?" cannot be answered by one image:
a cloud over open sea looks the same whether it is slot 2 or slot 4. So this
reads the SLOTS THEMSELVES out of the renderer and asks about a pixel where a
cloud and a scene layer OVERLAP:

    cloud pixel opaque AND scene-layer pixel opaque  ->  who wins on screen?

Engine answer: the scene (slot 4) always wins over clouds (slot 2). If the
composited screen pixel matches the CLOUD instead, the order is wrong.

It also confirms clouds are visible over open sea (cloud pixel opaque, no scene
pixel -> screen shows the cloud, not the ocean backdrop), which is the other
half of the ordering bug.

Usage (from ts/, vite on :5199):
    uv run --with playwright==1.61.0 python tools/oracle-diff/cloudorder.py [seconds]
"""
import os, sys, json

TS_URL = os.environ.get("TS_URL", "http://localhost:5199")

# Runs in the page. Reaches into the renderer's private slot map, reads the
# cloud slot, the scene layers and the visible canvas, and classifies pixels.
# Clouds spawn at y 25..101; Johnny stands near y>=279. They therefore almost
# never overlap on their own, which makes "wait and watch" inconclusive. This
# drags every cloud down over the scene so the overlap case is FORCED, then the
# probe reads the composite. Cloud geometry is irrelevant to slot order — only
# who wins where they overlap is.
FORCE_OVERLAP = r"""
() => {
  const isl = window.__island && window.__island();
  const r = window.__renderer;
  if (!isl || !r) return false;
  // Find the scene layers' actual opaque bounding box and park every cloud on
  // top of it, so the overlap case is guaranteed rather than hoped for.
  const W = 640, H = 480;
  const scenes = r.__layerCanvases();
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (const cv of scenes) {
    const c = new OffscreenCanvas(W, H).getContext("2d", {willReadFrequently: true});
    c.drawImage(cv, 0, 0);
    const d = c.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) {
      if (d[i * 4 + 3] < 250) continue;
      const x = i % W, y = (i / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxY < 0) return false;               // nothing drawn yet
  const cx = ((minX + maxX) / 2) | 0, cy = ((minY + maxY) / 2) | 0;
  // Cloud sprites are up to 264x76; centre them on the scene's centre.
  for (const c of isl.__clouds()) { c.x = cx - 100; c.y = Math.max(0, cy - 30); }
  return true;
}
"""

PROBE = r"""
() => {
  const r = window.__renderer;
  if (!r) return {err: "no __renderer"};
  const cloud = r.__slotCanvas("clouds");
  const island = r.__slotCanvas("island");
  if (!cloud) return {err: "no cloud slot"};
  const scenes = r.__layerCanvases();
  if (!scenes.length) return {err: "no scene layers"};

  const W = 640, H = 480;
  const px = (cv) => {
    const c = new OffscreenCanvas(W, H).getContext("2d", {willReadFrequently: true});
    c.drawImage(cv, 0, 0);
    return c.getImageData(0, 0, W, H).data;
  };
  // Snapshot every surface AND the screen without yielding to rAF. Reading the
  // slot canvases and the visible canvas at different moments lets the cloud
  // animation move between the two reads, which shows up as phantom "cloud
  // hidden" pixels one column apart (measured: adjacent x, the two cloud greys
  // swapped). Copy everything first, measure afterwards.
  const snap = (cv) => { const o = new OffscreenCanvas(W, H); o.getContext("2d").drawImage(cv, 0, 0); return o; };
  // Re-composite SYNCHRONOUSLY right now, so the screen and the slot surfaces
  // are guaranteed to be the same instant. Sampling the live canvas instead let
  // the rAF loop redraw a drifting cloud between the two reads, which showed up
  // as phantom "cloud hidden" pixels one column apart (measured: adjacent x,
  // the two cloud greys swapped). present() is the very code under test.
  r.present();
  const screenS = snap(document.getElementById("screen"));
  const cloudS = snap(cloud);
  const islandS = island ? snap(island) : null;
  const sceneS = scenes.map((cv) => snap(cv));

  const cloudPx = px(cloudS);
  const islandPx = islandS ? px(islandS) : null;
  const scenePx = sceneS.map(px);
  const screenPx = px(screenS);

  let overlap = 0, sceneWins = 0, cloudWins = 0, neither = 0;
  let openSea = 0, cloudVisible = 0;
  const samples = [];
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (cloudPx[o + 3] < 250) continue;           // only solid cloud pixels
    const cr = cloudPx[o], cg = cloudPx[o+1], cb = cloudPx[o+2];
    // topmost opaque scene-layer pixel (scene layers composite in order)
    let s = null;
    for (const sp of scenePx) {
      if (sp[o + 3] >= 250) s = [sp[o], sp[o+1], sp[o+2]];
    }
    const sr = screenPx[o], sg = screenPx[o+1], sb = screenPx[o+2];
    const eq = (a) => a && Math.abs(a[0]-sr) <= 2 && Math.abs(a[1]-sg) <= 2 && Math.abs(a[2]-sb) <= 2;
    const isCloud = Math.abs(cr-sr) <= 2 && Math.abs(cg-sg) <= 2 && Math.abs(cb-sb) <= 2;

    if (s) {
      // Cloud and scene overlap here. Only counts if the two differ in colour,
      // otherwise "who won" is unanswerable.
      if (Math.abs(cr-s[0]) <= 2 && Math.abs(cg-s[1]) <= 2 && Math.abs(cb-s[2]) <= 2) continue;
      overlap++;
      if (eq(s)) sceneWins++;
      else if (isCloud) cloudWins++;
      else { neither++; if (samples.length < 5) samples.push({i, cloud:[cr,cg,cb], scene:s, screen:[sr,sg,sb]}); }
    } else {
      // Open sea / island: no scene pixel. The cloud should be what shows,
      // unless the holiday or savedZones slot covers it (rare).
      const ip = islandPx ? [islandPx[o], islandPx[o+1], islandPx[o+2]] : null;
      const islandOpaque = islandPx && islandPx[o+3] >= 250;
      if (Math.abs(cr-(ip?ip[0]:-9)) <= 2 && islandOpaque &&
          Math.abs(cg-ip[1]) <= 2 && Math.abs(cb-ip[2]) <= 2) continue;
      openSea++;
      if (isCloud) cloudVisible++;
    }
  }
  return {overlap, sceneWins, cloudWins, neither, openSea, cloudVisible, samples,
          layers: scenes.length};
}
"""


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 90.0
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 700, "height": 560})
        pg.on("console", lambda m: print("  [console]", m.text) if m.type == "error" else None)
        # Cache-bust: vite HMR can leave window.__renderer pointing at a stale
        # module instance whose slots are empty, which reads as a silent all-zero
        # "INCONCLUSIVE" run. A unique URL guarantees a fresh module graph.
        import random as _r
        pg.goto(f"{TS_URL}/?story=1&cb={_r.randint(0,10**9)}", wait_until="networkidle")
        pg.wait_for_function("() => window.__renderer !== undefined", timeout=15000)

        tot = {"overlap": 0, "sceneWins": 0, "cloudWins": 0, "neither": 0,
               "openSea": 0, "cloudVisible": 0}
        checks = 0
        bad = []
        import time
        t0 = time.time()
        while time.time() - t0 < secs:
            pg.wait_for_timeout(700)
            pg.evaluate(FORCE_OVERLAP)
            pg.wait_for_timeout(120)  # let a cloud tick redraw at the new y
            r = pg.evaluate(PROBE)
            if r.get("err"):
                continue   # between episodes: no scene layer to compare against
            checks += 1
            for k in tot:
                tot[k] += r.get(k, 0)
            if r.get("cloudWins", 0) or r.get("neither", 0):
                bad.append(r)
        b.close()

    print(json.dumps(tot, indent=2))
    print(f"samples checked: {checks}")
    ok = True
    if tot["overlap"] == 0:
        print("INCONCLUSIVE: never caught a cloud overlapping a scene layer.")
        ok = False
    else:
        pct = 100.0 * tot["sceneWins"] / tot["overlap"]
        print(f"cloud/scene overlap: {tot['overlap']} px, scene on top {pct:.1f}%")
        if tot["cloudWins"]:
            print(f"FAIL: {tot['cloudWins']} px where the CLOUD covered the scene")
            print(json.dumps(bad[0]["samples"], indent=2))
            ok = False
    if tot["openSea"] == 0:
        print("INCONCLUSIVE: no cloud pixels over open sea/island.")
        ok = False
    else:
        pct = 100.0 * tot["cloudVisible"] / tot["openSea"]
        print(f"cloud over sea/island: {tot['openSea']} px, cloud visible {pct:.1f}%")
        if pct < 99.0:
            print("FAIL: clouds hidden where nothing should cover them")
            ok = False
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
