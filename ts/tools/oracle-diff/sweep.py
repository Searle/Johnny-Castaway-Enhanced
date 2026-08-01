#!/usr/bin/env python3
"""Run the oracle diff across EVERY ADS script + entry tag and summarize.

Reuses ONE Playwright browser AND one persistent Go trace-server across all
scenes. The old sweep relaunched the Go binary per scene (~2s raylib/GL init
each = ~130s of pure startup); -traceserver pays that once and serves each
scene's trace on demand over stdin/stdout.

Usage (from ts/, with a vite server on :5199 and the Go binary built):
    uv run --with playwright==1.61.0 python tools/oracle-diff/sweep.py [frames]
"""
import json, os, sys, subprocess, re, difflib
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


class GoTraceServer:
    """Persistent `JohnnyCastaway2026 -traceserver` process. Send it "ADS tag
    frames" lines; read back a "===TRACE ..==="/"===END===" block per scene.

    raylib writes its own INFO/WARNING logs to stdout, interleaved between our
    blocks, so we filter those out while reading the block body. The trace text
    written between the delimiters is itself clean (it comes from an in-memory
    buffer on the Go side), so filtering by line prefix is safe.
    """

    def __init__(self):
        # -window: decorated, resizable window so the oracle is watchable while
        # the sweep runs (set ORACLE_WINDOW=0 to run in the plain window).
        cmd = [GO_BIN, "-traceserver"]
        if os.environ.get("ORACLE_WINDOW", "1") != "0":
            cmd.append("-window")
        self.proc = subprocess.Popen(
            cmd, cwd=REPO,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )

    def send(self, ads, tag, frames):
        """Queue a scene request without waiting for the result, so the caller
        can do the (independent) TS-side trace while Go computes. Returns False
        if the server is gone."""
        if self.proc.poll() is not None:
            return False
        try:
            self.proc.stdin.write(f"{ads} {tag} {frames}\n")
            self.proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError):
            return False

    def read(self, ads, tag):
        """Block until the block for (ads, tag) arrives; return its clean body
        (or None if the server died). Because requests are answered in order,
        reading right after send() pairs correctly."""
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

    def trace(self, ads, tag, frames):
        return self.read(ads, tag) if self.send(ads, tag, frames) else None

    def close(self):
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.write("\n")  # blank line = quit
                self.proc.stdin.flush()
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def main():
    frames = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    with open(INDEX) as f:
        index = json.load(f)
    jobs = [(a["name"].replace(".ADS", ""), t) for a in index.get("ads", []) for t in a["tags"]]

    from playwright.sync_api import sync_playwright
    passed, failed, errored = [], [], []
    loaded = False  # has the page been loaded once (so __load can switch in-page)?
    go_server = GoTraceServer()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 700, "height": 560})
        for name, tag in jobs:
            # Pipeline: fire the Go request first, then do the (independent) TS
            # trace while the Go engine computes concurrently, then collect the
            # Go block. Turns per-scene cost from go+ts into ~max(go, ts).
            go_ok = go_server.send(name, tag, frames)
            try:
                # Switch scenes IN-PAGE (window.__load) rather than reloading the
                # document. A reload re-parses the app and re-decodes every sprite
                # sheet: ~1.34s/scene vs ~0.48s, i.e. ~95% of the sweep's wall
                # clock. Verified to produce byte-identical traces to a cold
                # reload, including when scenes are visited in a different order.
                # COLD_RELOAD=1 forces the old path if a state leak is ever
                # suspected.
                if loaded and os.environ.get("COLD_RELOAD") != "1":
                    ok = page.evaluate(
                        f"() => window.__load({json.dumps(name + '.ADS')}, {tag})"
                    )
                    if not ok:
                        raise RuntimeError(f"__load rejected {name}.ADS:{tag}")
                else:
                    page.goto(f"{TS_URL}/?ads={name}.ADS&tag={tag}&dump=1", wait_until="networkidle")
                    page.wait_for_function("() => typeof window.__load === 'function'", timeout=8000)
                    loaded = True
                # Poll for assets-decoded-and-playback-live instead of a blind
                # sleep. A short/partial TS trace (assets still loading) was the
                # real source of the run-to-run flake: it shrank `n` so a
                # truncated prefix silently "passed".
                page.wait_for_function("() => window.__ready === true", timeout=8000)
                ts = page.evaluate(f"() => window.__trace({frames})")
            except Exception as e:
                if go_ok:
                    go_server.read(name, tag)  # drain the pending Go block to stay in sync
                loaded = False  # page state is suspect — cold-reload the next scene
                errored.append((name, tag, str(e)[:60]))
                print(f"  ERR  {name}.ADS tag {tag}  ({str(e)[:50]})")
                continue
            go = go_server.read(name, tag) if go_ok else None
            if go is None:
                errored.append((name, tag, "go-trace failed/died"))
                print(f"  ERR  {name}.ADS tag {tag}  (go trace failed)")
                continue
            g, t = norm(go), norm(ts)
            # Length mismatch is now a FAILURE, not silently truncated to
            # min(len). If one side is short, the traces genuinely disagree —
            # either a real early-stop divergence or (if flaky) a harness bug we
            # want visible, not hidden behind a passing prefix.
            if len(g) != len(t):
                failed.append((name, tag, f"len {len(g)}vs{len(t)}"))
                print(f"  DIFF {name}.ADS tag {tag}  (length {len(g)} vs {len(t)})")
            elif len(g) == 0:
                errored.append((name, tag, "empty trace"))
                print(f"  ERR  {name}.ADS tag {tag}  (empty trace)")
            elif g == t:
                passed.append((name, tag))
                print(f"  ok   {name}.ADS tag {tag}  ({len(g)} lines)")
            else:
                d = sum(1 for x in difflib.unified_diff(g, t) if x[:1] in "+-" and x[:2] not in ("++", "--"))
                failed.append((name, tag, f"{d} lines"))
                print(f"  DIFF {name}.ADS tag {tag}  ({d} lines differ)")
        browser.close()
    go_server.close()

    print()
    print(f"=== {len(passed)}/{len(jobs)} identical | {len(failed)} diverge | {len(errored)} errored ({frames} frames) ===")
    if failed:
        print("Diverging:", ", ".join(f"{n}:{t} ({d})" for n, t, d in failed))
    if errored:
        print("Errored:", ", ".join(f"{n}:{t}" for n, t, _ in errored))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
