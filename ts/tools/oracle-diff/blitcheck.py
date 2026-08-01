#!/usr/bin/env python3
"""Headless single-sprite blit comparator.

WHAT THIS IS FOR

The pixel oracle (pixels.py) compares composited SCENE frames. A scene frame
routinely stacks 2-3 overlapping sprites — FISHING:1 frame 7 draws JOHNWALK#2,
TRUNK#0 and MJFISH1#23 into the same columns — so when a handful of pixels
differ, attributing them to one sprite is guesswork. Three separate attempts at
the "1px sprite edge" difference all foundered on exactly that: each measurement
had several possible causes, and the one I picked was wrong.

This tool removes the ambiguity by removing everything else. No window, no
OpenGL, no browser, no ADS scheduler, no frames, no compositing. It takes ONE
sprite cel and applies each engine's blit ARITHMETIC to a blank array:

    Go   (graphics.go grDrawSpriteFlip): src = (0,0,-w,h), dst = (x,y,w,h)
    TS   (canvas2d.ts drawSprite):       translate(x+w,y); scale(-1,1); draw at 0,0

Both reduce to "which source column lands in which destination column", which is
five lines of index arithmetic. A difference here has exactly ONE possible
cause, and the whole sheet can be swept in milliseconds.

WHAT IT DELIBERATELY DOES NOT DO

It does not prove either engine matches the ORIGINAL game — only whether the two
ports agree, and where they diverge. Ground truth for the flip convention has to
come from the original C (`x += width - 1` before a right-to-left blit, see the
commented-out line in grDrawSpriteFlip), not from this.

USAGE (from ts/)
    uv run --with pillow --with numpy python tools/oracle-diff/blitcheck.py
    uv run ... tools/oracle-diff/blitcheck.py MJFISH.TTM JOHNWALK.BMP
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(__file__)
TS = os.path.abspath(os.path.join(HERE, "..", ".."))
ANIM = os.path.join(TS, "public", "anim")


def blit_go(dst_w, dst_h, sprite, x, y, flip):
    """Go/raylib: DrawTexturePro(src=(0,0,±w,h), dst=(x,y,w,h)).

    A negative source width mirrors the sampled region. With point sampling and
    a 1:1 dst rect, destination column x+i takes source column (w-1-i) when
    flipped, and column i otherwise — the sprite occupies x … x+w-1 either way.
    """
    import numpy as np
    h, w = sprite.shape[:2]
    out = np.zeros((dst_h, dst_w, 4), dtype=np.uint8)
    for i in range(w):
        sx = (w - 1 - i) if flip else i
        dx = x + i
        if 0 <= dx < dst_w:
            _paste_column(out, sprite, sx, dx, y)
    return out


def blit_ts(dst_w, dst_h, sprite, x, y, flip):
    """Canvas2D: translate(x+w, y); scale(-1,1); drawImage(img,0,0).

    The mirror axis is x+w, so source column s maps to destination x+w-1-s.
    That is the same span as Go — the two only diverge if the axis is wrong,
    which is precisely what this tool is here to detect.
    """
    import numpy as np
    h, w = sprite.shape[:2]
    out = np.zeros((dst_h, dst_w, 4), dtype=np.uint8)
    for s in range(w):
        dx = (x + w - 1 - s) if flip else (x + s)
        if 0 <= dx < dst_w:
            _paste_column(out, sprite, s, dx, y)
    return out


def _paste_column(out, sprite, sx, dx, y):
    h = sprite.shape[0]
    y0, y1 = max(0, y), min(out.shape[0], y + h)
    if y1 <= y0:
        return
    out[y0:y1, dx] = sprite[y0 - y : y1 - y, sx]


def compare_cel(png_path, x=100, y=100, dst=(640, 480)):
    import numpy as np
    from PIL import Image
    spr = np.asarray(Image.open(png_path).convert("RGBA"), dtype=np.uint8)
    rows = []
    for flip in (False, True):
        g = blit_go(dst[0], dst[1], spr, x, y, flip)
        t = blit_ts(dst[0], dst[1], spr, x, y, flip)
        diff = int(np.count_nonzero((g != t).any(axis=2)))
        gc = np.where((g[:, :, 3] > 8).any(axis=0))[0]
        tc = np.where((t[:, :, 3] > 8).any(axis=0))[0]
        rows.append({
            "flip": flip,
            "diff": diff,
            "go_cols": (int(gc.min()), int(gc.max())) if gc.size else None,
            "ts_cols": (int(tc.min()), int(tc.max())) if tc.size else None,
            "w": int(spr.shape[1]),
        })
    return rows


def main():
    if len(sys.argv) > 2:
        sheets = [os.path.join(ANIM, sys.argv[1], sys.argv[2].replace(".BMP", "") + ".*.png")]
    else:
        sheets = [os.path.join(ANIM, "*", "*.png")]

    files = sorted(f for pat in sheets for f in glob.glob(pat))
    if not files:
        print("no sprite PNGs found — run `npm run extract -- -all` first")
        sys.exit(2)

    bad = 0
    checked = 0
    widths_bad = set()
    for f in files:
        for r in compare_cel(f):
            checked += 1
            if r["diff"]:
                bad += 1
                widths_bad.add(r["w"])
                if bad <= 12:
                    print(f"  DIFF {os.path.relpath(f, ANIM)} flip={int(r['flip'])} "
                          f"w={r['w']} go={r['go_cols']} ts={r['ts_cols']} ({r['diff']} px)")
    print()
    print(f"=== {checked - bad}/{checked} blits identical ===")
    if widths_bad:
        print("sprite widths that differ:", sorted(widths_bad))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
