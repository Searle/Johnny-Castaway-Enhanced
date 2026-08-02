#!/usr/bin/env python3
"""Unattended screensaver check for RESTRUCTURE-PLAN Step 3.

The oracles cannot see any of this: they step by frame with pacing disabled and
drive a single ADS tag. This drives the REAL screensaver and watches for the
symptoms the coroutine restructure is supposed to fix, plus the ones it must not
introduce:

  wedge     — the frame counter stops advancing while a beat is still running
  blink     — a composited frame with NO scene content at all (Johnny vanishing)
  stall     — the beat never changes over a long window
  progress  — beats and episodes actually advance

It also samples wall-clock PACING, which every text oracle is blind to: a build
running at 8x passes all of them. Reported as engine-frames per real second.

Usage (from ts/, vite on :5199):
    uv run --with playwright==1.61.0 python .../screensaver.py [seconds]
"""
import os, sys, json, time, random

TS_URL = os.environ.get("TS_URL", "http://localhost:5199")

SAMPLE = r"""
() => {
  const r = window.__renderer;
  const hud = (document.getElementById("hud") || {}).textContent || "";
  const W = 640, H = 480;
  // What the VIEWER sees. An empty scene LAYER is not a bug — the Go engine
  // emits genuinely empty frames too (measured: STAND:10 has 2 in 80), and the
  // island still fills the screen underneath. A blink is the composited SCREEN
  // going dark, which is what a human would actually notice.
  const sc = new OffscreenCanvas(W, H).getContext("2d", {willReadFrequently: true});
  sc.drawImage(document.getElementById("screen"), 0, 0);
  const sd = sc.getImageData(0, 0, W, H).data;
  let screenNonBlack = 0;
  for (let i = 0; i < W * H; i++) {
    if (sd[i*4] > 8 || sd[i*4+1] > 8 || sd[i*4+2] > 8) screenNonBlack++;
  }
  const m = hud.match(/frame (\d+)/);
  return {
    hud,
    frame: m ? Number(m[1]) : -1,
    layers: r.__layerCanvases().length,
    screenNonBlack,
    walking: hud.includes("walking"),
    beat: (hud.split(" — ")[2] || "").trim(),
    day: (hud.match(/day (\d+)/) || [0, "?"])[1],
  };
}
"""


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 180
    from playwright.sync_api import sync_playwright
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 700, "height": 560})
        pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
        pg.on("console", lambda m: errors.append("console: " + m.text[:200]) if m.type == "error" else None)
        pg.goto(f"{TS_URL}/?story=1&cb={random.randint(0,10**9)}", wait_until="networkidle")
        pg.wait_for_function("() => window.__renderer !== undefined", timeout=15000)
        pg.wait_for_timeout(2000)
        # Hook present() to record EVERY composite's scene-layer pixel count.
        # Polling at 2/sec cannot catch a ONE-FRAME blink; this can. An isolated
        # dip (content -> blank -> content) is the "Johnny vanishes at a scene
        # change" symptom. Measured: 18 such dips when presenting after the reap,
        # 0 with the guard in place.
        pg.evaluate("""() => {
          const r = window.__renderer; window.__presents = [];
          const orig = r.present.bind(r);
          r.present = function(){
            orig();
            const W=640,H=480; let n=0;
            for (const cv of r.__layerCanvases()){
              const c=new OffscreenCanvas(W,H).getContext("2d",{willReadFrequently:true});
              c.drawImage(cv,0,0); const d=c.getImageData(0,0,W,H).data;
              for(let i=0;i<W*H;i++) if(d[i*4+3]>=250)n++;
            }
            window.__presents.push(n);
            if (window.__presents.length > 8000) window.__presents.shift();
          };
        }""")

        obs = []
        t0 = time.time()
        while time.time() - t0 < secs:
            pg.wait_for_timeout(500)
            s = pg.evaluate(SAMPLE)
            s["t"] = time.time() - t0
            obs.append(s)
        presents = pg.evaluate("() => window.__presents") or []
        b.close()

    if not obs:
        print("no observations"); sys.exit(1)

    beats = []
    for o in obs:
        if not beats or beats[-1] != o["beat"]:
            beats.append(o["beat"])
    playing = [o for o in obs if not o["walking"]]
    walks = [o for o in obs if o["walking"]]

    # Blink: the composited screen went (near) black while a beat was live.
    # The island alone covers ~270k px, so anything under ~50k means the
    # backdrop or the island slot vanished — the symptom a human reports.
    blinks = [o for o in obs if o["screenNonBlack"] < 50000]

    # Wedge: the frame counter frozen across a long run of samples while the
    # beat never changes either.
    wedge = 0
    run = 0
    for a, c in zip(obs, obs[1:]):
        if c["frame"] == a["frame"] and c["beat"] == a["beat"]:
            run += 1
            wedge = max(wedge, run)
        else:
            run = 0

    # Pacing: engine frames per real second, over samples inside one beat.
    rates = []
    for a, c in zip(obs, obs[1:]):
        if c["beat"] == a["beat"] and c["frame"] > a["frame"]:
            dt = c["t"] - a["t"]
            if dt > 0:
                rates.append((c["frame"] - a["frame"]) / dt)
    rates.sort()
    med = rates[len(rates)//2] if rates else float("nan")

    print(f"observations {len(obs)}  distinct beats {len(beats)}  walk samples {len(walks)}")
    print(f"beats seen: {' -> '.join(b for b in beats[:8] if b)}")
    print(f"median pace: {med:.1f} engine frames/sec  (samples {len(rates)})")
    print(f"longest frozen run: {wedge} samples ({wedge*0.5:.1f}s)")
    print(f"near-black screen samples: {len(blinks)}  (min nonblack {min(o['screenNonBlack'] for o in obs)})")
    if errors:
        print(f"PAGE ERRORS ({len(errors)}):")
        for e in errors[:5]:
            print("   ", e)

    ok = True
    if errors:
        print("FAIL: page errors"); ok = False
    if len(beats) < 3:
        print(f"FAIL: only {len(beats)} beats in {secs:.0f}s — not advancing"); ok = False
    if not walks:
        print("WARN: no walk sampled (may be legitimate for short runs)")
    if blinks:
        print(f"FAIL: {len(blinks)} samples where the SCREEN went near-black (blink)"); ok = False
    # PACING is the one thing no text oracle can see: they all step by frame with
    # wall-clock pacing disabled, so a build running at 8x passes every one. One
    # engine tick is 20ms, and a scheduler tick advances the clock by `mini`
    # (usually 8 with clouds running), so a correct build displays well under
    # ~15 frames/sec. Charging 1 tick per iteration instead of `mini` measures
    # ~29 f/s — that exact bug has shipped here before.
    dips = sum(1 for a, c, d in zip(presents, presents[1:], presents[2:])
               if a > 0 and c == 0 and d > 0)
    print(f"composites {len(presents)}  isolated blank composites (blink) {dips}")
    if dips:
        print(f"FAIL: {dips} one-frame blinks — a composite with content, then "
              f"blank, then content again (presenting after the reap?)"); ok = False
    if rates and med > 15.0:
        print(f"FAIL: playback at {med:.1f} frames/sec — too fast; is the clock "
              f"being charged `mini` per tick?"); ok = False
    # A long idle STAND hold legitimately freezes the FRAME counter, so a frozen
    # run only counts as a wedge if it spans most of the run.
    if wedge * 0.5 > secs * 0.5:
        print(f"FAIL: wedged for {wedge*0.5:.0f}s of a {secs:.0f}s run"); ok = False
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
