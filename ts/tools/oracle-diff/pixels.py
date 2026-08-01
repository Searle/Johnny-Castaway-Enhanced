#!/usr/bin/env python3
"""PIXEL oracle: compare the TS port's RENDERED frames against the Go engine's.

Why this exists, alongside the draw-call oracle (sweep.py):

    The draw-call trace proves the INTERPRETER is right — same sprites, same
    coordinates, same order, same timing. It is structurally blind to the
    COMPOSITOR: layer z-order, layer lifetime, and the moment a frame is
    presented are all invisible to it. Every rendering bug found so far passed
    the trace diff untouched while looking obviously wrong on screen:

      - ACTIVITY.ADS tag 12: Johnny vanished for a frame (the port presented a
        moment between a scene's reap and the next scene's first draw, which the
        engine never displays).
      - BUILDING.ADS tag 1: Johnny's final walking frame was dropped (the port
        composited after the reap had already freed that scene's layer).

    Both were caught by a human looking at the screen. This makes that check
    automatic.

Both sides capture the SAME thing: the saved-zones + thread layers composited
over transparency, WITHOUT the island background or clouds. Those are
engine-side procedural animation (islandInit / islandAnimateClouds draw straight
to the background surface, emitting no TTM draw calls) that the Canvas2D port
deliberately doesn't reproduce — it uses a baked ISLETEMP.SCR. Including them
would make every frame differ on knowingly out-of-scope content and drown the
sprite comparison. Their timers still run on both sides, so scheduling is
unaffected.

Usage (from ts/, with a vite server on :5199 and the Go binary built):
    uv run --with playwright==1.61.0 --with pillow --with numpy python tools/oracle-diff/pixels.py [frames] [ADS tag]

    # one scene, writing the differing frames out for inspection:
    PIXEL_OUT=/tmp/pix uv run ... tools/oracle-diff/pixels.py 60 BUILDING 1
"""
import base64, io, json, os, re, subprocess, sys, tempfile
import functools
print = functools.partial(print, flush=True)

HERE = os.path.dirname(__file__)
TS = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(TS, ".."))
INDEX = os.path.join(TS, "public", "anim", "index.json")
GO_BIN = os.path.join(REPO, "JohnnyCastaway2026")
TS_URL = os.environ.get("TS_URL", "http://localhost:5199")
OUT_DIR = os.environ.get("PIXEL_OUT")


class GoShotServer:
    """Persistent traceserver that also writes per-frame PNGs.

    Protocol: "ADS tag frames shotdir" — the 4th field turns on compositing and
    frame capture (see trace.go traceShots). Without it the server skips
    compositing entirely, which is what makes the draw-call sweep fast.
    """

    def __init__(self):
        cmd = [GO_BIN, "-traceserver"]
        if os.environ.get("ORACLE_WINDOW", "1") != "0":
            cmd.append("-window")
        self.proc = subprocess.Popen(
            cmd, cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )

    def shots(self, ads, tag, frames, shotdir):
        if self.proc.poll() is not None:
            return None
        os.makedirs(shotdir, exist_ok=True)
        for f in os.listdir(shotdir):
            os.remove(os.path.join(shotdir, f))
        self.proc.stdin.write(f"{ads} {tag} {frames} {shotdir}\n")
        self.proc.stdin.flush()
        want = f"===TRACE {ads}.ADS {tag}==="
        started = False
        for line in self.proc.stdout:
            line = line.rstrip("\n")
            if not started:
                if line == want:
                    started = True
                continue
            if line == "===END===":
                break
        return sorted(
            os.path.join(shotdir, f) for f in os.listdir(shotdir) if f.endswith(".png")
        )

    def close(self):
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.write("\n")
                self.proc.stdin.flush()
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def load_rgba(path_or_dataurl):
    from PIL import Image
    if isinstance(path_or_dataurl, str) and path_or_dataurl.startswith("data:"):
        raw = base64.b64decode(path_or_dataurl.split(",", 1)[1])
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    return Image.open(path_or_dataurl).convert("RGBA")


def compare(go_img, ts_img):
    """Return (differing_pixel_count, total_opaque_pixels).

    Compares only where either side has a non-transparent pixel, and treats a
    pixel as matching if the RGB values agree; alpha is used just to decide
    whether a pixel is drawn at all. That keeps the check about "is the right
    sprite in the right place", not about blending minutiae between an OpenGL
    render texture and a Canvas2D composite.

    Vectorised with numpy — the per-pixel Python loop this replaces was 640*480
    iterations per frame and made a full 66-scene pixel sweep take ~5m30s, of
    which the comparison was the bulk.
    """
    import numpy as np
    if go_img.size != ts_img.size:
        return -1, 0
    g = np.asarray(go_img, dtype=np.uint8)
    t = np.asarray(ts_img, dtype=np.uint8)
    ga = g[:, :, 3] > 8
    ta = t[:, :, 3] > 8
    drawn_mask = ga | ta
    # A pixel is bad if only one side drew it, or both drew it in different RGB.
    rgb_differs = np.any(g[:, :, :3] != t[:, :, :3], axis=2)
    bad_mask = drawn_mask & ((ga != ta) | (ga & ta & rgb_differs))
    return int(np.count_nonzero(bad_mask)), int(np.count_nonzero(drawn_mask))


def main():
    frames = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    with open(INDEX) as f:
        index = json.load(f)
    if len(sys.argv) > 3:
        jobs = [(sys.argv[2].upper(), int(sys.argv[3]))]
    else:
        jobs = [(a["name"].replace(".ADS", ""), t) for a in index.get("ads", []) for t in a["tags"]]

    from playwright.sync_api import sync_playwright
    go = GoShotServer()
    tmp = tempfile.mkdtemp(prefix="jc-pixels-")
    passed, failed, errored = [], [], []
    loaded = False
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 700, "height": 560})
        for name, tag in jobs:
            try:
                if loaded:
                    if not page.evaluate(f"() => window.__load({json.dumps(name + '.ADS')}, {tag})"):
                        raise RuntimeError("__load rejected")
                else:
                    page.goto(f"{TS_URL}/?ads={name}.ADS&tag={tag}&dump=1", wait_until="networkidle")
                    page.wait_for_function("() => typeof window.__shots === 'function'", timeout=8000)
                    loaded = True
                page.wait_for_function("() => window.__ready === true", timeout=8000)
                ts_shots = page.evaluate(f"() => window.__shots({frames})")
            except Exception as e:
                loaded = False
                errored.append((name, tag, str(e)[:60]))
                print(f"  ERR  {name}.ADS tag {tag}  ({str(e)[:50]})")
                continue

            go_shots = go.shots(name, tag, frames, os.path.join(tmp, "go"))
            if not go_shots:
                errored.append((name, tag, "go shots failed"))
                print(f"  ERR  {name}.ADS tag {tag}  (go capture failed)")
                continue

            n = min(len(go_shots), len(ts_shots))
            if len(go_shots) != len(ts_shots):
                failed.append((name, tag, f"count {len(go_shots)}vs{len(ts_shots)}"))
                print(f"  DIFF {name}.ADS tag {tag}  (frame count {len(go_shots)} vs {len(ts_shots)})")
                continue

            worst = (0, 0, -1)
            for i in range(n):
                bad, drawn = compare(load_rgba(go_shots[i]), load_rgba(ts_shots[i]))
                if bad > worst[0]:
                    worst = (bad, drawn, i)
            bad, drawn, idx = worst
            if bad == 0:
                passed.append((name, tag))
                print(f"  ok   {name}.ADS tag {tag}  ({n} frames pixel-identical)")
            else:
                pct = 100.0 * bad / max(drawn, 1)
                failed.append((name, tag, f"{bad}px @f{idx}"))
                print(f"  DIFF {name}.ADS tag {tag}  (worst frame {idx}: {bad}/{drawn} px, {pct:.1f}%)")
                if OUT_DIR:
                    os.makedirs(OUT_DIR, exist_ok=True)
                    load_rgba(go_shots[idx]).save(f"{OUT_DIR}/{name}-{tag}-f{idx}-go.png")
                    load_rgba(ts_shots[idx]).save(f"{OUT_DIR}/{name}-{tag}-f{idx}-ts.png")
        browser.close()
    go.close()

    print()
    print(f"=== {len(passed)}/{len(jobs)} pixel-identical | {len(failed)} differ | {len(errored)} errored ({frames} frames) ===")
    if failed:
        print("Differing:", ", ".join(f"{n}:{t} ({d})" for n, t, d in failed))
    if errored:
        print("Errored:", ", ".join(f"{n}:{t}" for n, t, _ in errored))
    sys.exit(1 if failed or errored else 0)


if __name__ == "__main__":
    main()
