#!/usr/bin/env python3
"""Oracle diff: compare the TS port's draw-call trace against the Go engine's.

The Go engine (repo root) is the authority. Both emit the SAME canonical trace
format (see trace.go / ts/src/ttm/interpreter.ts); this runs both for one scene
and diffs them, so any interpreter/render divergence is a precise diff line
instead of a pixel-guess.

Usage (from ts/):
    python tools/oracle-diff/diff.py BUILDING 5 [frames]

Prereqs:
    - Go engine built at repo root (the JohnnyCastaway2026 binary), runnable on
      the WSLg display (it opens a window briefly).
    - A vite dev server serving the TS port (default http://localhost:5199).
      Start it with: npx vite --port 5199 --strictPort
    - Playwright: run via `uv run --with playwright python tools/oracle-diff/diff.py ...`
"""
import subprocess, sys, os, re, difflib, time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TS_URL = os.environ.get("TS_URL", "http://localhost:5199")
GO_BIN = os.path.join(REPO, "JohnnyCastaway2026")


def norm(text: str) -> list[str]:
    """Strip FRAME numbers and SCENE lines so an off-by-one entry frame or the
    Go engine's extra island-setup scene lines don't drown the real diff."""
    out = []
    for line in text.splitlines():
        if line.startswith("SCENE"):
            continue
        out.append(re.sub(r"^FRAME \d+", "FRAME", line))
    return out


def go_trace(ads: str, tag: int, frames: int) -> str:
    trace_path = os.path.join(REPO, "go-trace.txt")
    if os.path.exists(trace_path):
        os.remove(trace_path)
    subprocess.run(
        [GO_BIN, "-trace", ads, str(tag), str(frames)],
        cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60,
    )
    with open(trace_path) as f:
        return f.read()


def ts_trace(ads: str, tag: int, frames: int) -> str:
    from playwright.sync_api import sync_playwright
    url = f"{TS_URL}/?ads={ads}.ADS&tag={tag}&dump=1"
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 700, "height": 560})
        pg.goto(url, wait_until="networkidle")
        pg.wait_for_function("() => typeof window.__trace === 'function'")
        time.sleep(1.0)  # let async asset load finish
        txt = pg.evaluate(f"() => window.__trace({frames})")
        b.close()
        return txt


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    ads = sys.argv[1].upper()
    tag = int(sys.argv[2])
    frames = int(sys.argv[3]) if len(sys.argv) > 3 else 30

    go = norm(go_trace(ads, tag, frames))
    ts = norm(ts_trace(ads, tag, frames))
    n = min(len(go), len(ts))  # ignore trailing frames past the shorter window
    go, ts = go[:n], ts[:n]

    diff = list(difflib.unified_diff(go, ts, "go-oracle", "ts-port", lineterm=""))
    if not diff:
        print(f"✅ {ads} tag {tag}: {frames} frames IDENTICAL (go == ts)")
        sys.exit(0)
    print(f"❌ {ads} tag {tag}: divergence ({sum(1 for d in diff if d[:1] in '+-' and d[:2] not in ('++','--'))} lines)")
    print("\n".join(diff))
    sys.exit(1)


if __name__ == "__main__":
    main()
