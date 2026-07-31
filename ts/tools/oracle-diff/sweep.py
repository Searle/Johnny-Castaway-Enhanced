#!/usr/bin/env python3
"""Run the oracle diff across EVERY ADS script + entry tag and summarize.

Reuses ONE Playwright browser across all scenes (launching a browser per scene
was the bottleneck). The Go trace still needs one process launch per scene.

Usage (from ts/, with a vite server on :5199 and the Go binary built):
    uv run --with playwright python tools/oracle-diff/sweep.py [frames]
"""
import json, os, sys, subprocess, re, difflib, time
import functools
print = functools.partial(print, flush=True)  # observable in background runs

HERE = os.path.dirname(__file__)
TS = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(TS, ".."))
INDEX = os.path.join(TS, "public", "anim", "index.json")
GO_BIN = os.path.join(REPO, "JohnnyCastaway2026")
TS_URL = os.environ.get("TS_URL", "http://localhost:5199")


def norm(text):
    out = []
    for line in text.splitlines():
        if line.startswith("SCENE"):
            continue
        out.append(re.sub(r"^FRAME \d+", "FRAME", line))
    return out


def go_trace(ads, tag, frames):
    p = os.path.join(REPO, "go-trace.txt")
    if os.path.exists(p):
        os.remove(p)
    try:
        subprocess.run([GO_BIN, "-trace", ads, str(tag), str(frames)],
                       cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
    except subprocess.TimeoutExpired:
        return None
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return f.read()


def main():
    frames = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    with open(INDEX) as f:
        index = json.load(f)
    jobs = [(a["name"].replace(".ADS", ""), t) for a in index.get("ads", []) for t in a["tags"]]

    from playwright.sync_api import sync_playwright
    passed, failed, errored = [], [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 700, "height": 560})
        for name, tag in jobs:
            go = go_trace(name, tag, frames)
            if go is None:
                errored.append((name, tag, "go-trace failed/timeout"))
                print(f"  ERR  {name}.ADS tag {tag}  (go trace failed)")
                continue
            try:
                page.goto(f"{TS_URL}/?ads={name}.ADS&tag={tag}&dump=1", wait_until="networkidle")
                page.wait_for_function("() => typeof window.__trace === 'function'", timeout=8000)
                time.sleep(0.8)
                ts = page.evaluate(f"() => window.__trace({frames})")
            except Exception as e:
                errored.append((name, tag, str(e)[:60]))
                print(f"  ERR  {name}.ADS tag {tag}  ({str(e)[:50]})")
                continue
            g, t = norm(go), norm(ts)
            n = min(len(g), len(t))
            if g[:n] == t[:n] and n > 0:
                passed.append((name, tag))
                print(f"  ok   {name}.ADS tag {tag}  ({n} lines)")
            else:
                d = sum(1 for x in difflib.unified_diff(g[:n], t[:n]) if x[:1] in "+-" and x[:2] not in ("++", "--"))
                failed.append((name, tag, d))
                print(f"  DIFF {name}.ADS tag {tag}  ({d} lines differ)")
        browser.close()

    print()
    print(f"=== {len(passed)}/{len(jobs)} identical | {len(failed)} diverge | {len(errored)} errored ({frames} frames) ===")
    if failed:
        print("Diverging:", ", ".join(f"{n}:{t}({d})" for n, t, d in failed))
    if errored:
        print("Errored:", ", ".join(f"{n}:{t}" for n, t, _ in errored))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
