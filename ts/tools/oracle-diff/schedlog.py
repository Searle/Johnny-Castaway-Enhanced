#!/usr/bin/env python3
"""Capture the TS port's SCHEDULER DECISION sequence for one scene.

Companion to the Go engine's JC_SCHED_LOG output (trace.go schedLog). Both emit
the same "SCHED ..." line format, so the two decision sequences can be diffed
directly — which shows WHICH BRANCH each engine took and why, instead of the
downstream draw-call damage.

Usage (from ts/, with a vite server on :5199):
    uv run --with playwright==1.61.0 python tools/oracle-diff/schedlog.py STAND 2 [frames]

Go side:
    JC_SCHED_LOG=1 ./JohnnyCastaway2026 -trace STAND 2 15 2>&1 >/dev/null | grep ^SCHED
"""
import os, sys

TS_URL = os.environ.get("TS_URL", "http://localhost:5199")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    ads, tag = sys.argv[1].upper(), int(sys.argv[2])
    frames = int(sys.argv[3]) if len(sys.argv) > 3 else 15

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 700, "height": 560})
        pg.goto(f"{TS_URL}/?ads={ads}.ADS&tag={tag}&dump=1", wait_until="networkidle")
        pg.wait_for_function("() => typeof window.__schedlog === 'function'", timeout=8000)
        pg.wait_for_function("() => window.__ready === true", timeout=8000)
        print(pg.evaluate(f"() => window.__schedlog({frames})"))
        b.close()


if __name__ == "__main__":
    main()
