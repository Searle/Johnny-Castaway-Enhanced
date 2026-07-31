package main

import (
	"fmt"
	"os"
)

// Draw-call trace: a canonical, diffable log of what each TTM frame draws, so
// the Go engine can serve as an oracle for the TypeScript port (ts/). Both
// engines emit the SAME format; a plain text diff then pinpoints any divergence
// in sprite/position/delay/flow — no pixel guessing.
//
// Enabled by `-trace <ADS> <tag> [maxFrames]`. Output goes to stdout only
// (INFO/WARNING raylib logs go to stderr), so `2>/dev/null` yields a clean trace.
//
// Format (one event per line; a scene is entered once, then frames repeat):
//
//	SCENE slot=3 tag=36
//	FRAME
//	  DRAW s=13 img=3 @232,301 flip=0
//	  DELAY 7
//	  ENDFRAME
//
// Only the deterministic per-scene frame stream is compared (not random
// cross-scene selection, whose RNG differs between Go and JS).

var (
	traceEnabled       = false
	traceMaxFrame      = 0 // stop after this many frames (0 = unlimited)
	traceFrameNo       = 0
	traceCurTag        = uint16(0)
	traceReachedBudget = false // set true once maxFrame frames are traced
	traceOut           = os.Stdout
)

// traceInit opens the trace output file (raylib spams stdout/stderr with INFO
// logs, so the trace needs its own file to stay clean and diffable).
func traceInit(path string) {
	f, err := os.Create(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "trace: cannot create %s: %v\n", path, err)
		return
	}
	traceOut = f
	fmt.Fprintf(os.Stderr, "[trace] writing to %s\n", path)
}

// traceClose flushes and closes the trace file.
func traceClose() {
	if traceOut != nil && traceOut != os.Stdout {
		traceOut.Close()
	}
}

// Deterministic RNG for trace mode. When traceEnabled, the ADS RANDOM-block
// pick and the TTM TIMER opcode draw from THIS instead of the global math/rand,
// so a run is reproducible and the TS port (which implements the identical
// mulberry32 PRNG, same seed) produces the same random choices — making the
// draw-call traces diffable end-to-end instead of only within a single
// deterministic scene. Other random consumers (island/clouds/story) keep using
// the global rand; they don't affect the compared draw calls.
var traceRngState uint32 = 0x1234abcd // fixed seed shared with the TS port

// traceRandN returns a deterministic pseudo-random int in [0, n) using
// mulberry32 (a tiny, well-distributed 32-bit PRNG that's trivial to mirror in
// JS). Falls back to 0 for n <= 0.
func traceRandN(n int) int {
	if n <= 0 {
		return 0
	}
	traceRngState += 0x6D2B79F5
	z := traceRngState
	z = (z ^ (z >> 15)) * (z | 1)
	z ^= z + (z^(z>>7))*(z|61)
	z = z ^ (z >> 14)
	return int(z % uint32(n))
}

// traceScene marks entry into a scene (slot, root tag).
func traceScene(slot, tag uint16) {
	if !traceEnabled {
		return
	}
	traceCurTag = tag
	fmt.Fprintf(traceOut, "SCENE slot=%d tag=%d\n", slot, tag)
}

// traceFrameStart begins a displayed frame.
func traceFrameStart() {
	if !traceEnabled {
		return
	}
	fmt.Fprintf(traceOut, "FRAME %d\n", traceFrameNo)
}

// traceDraw logs a DRAW_SPRITE / DRAW_SPRITE_FLIP.
func traceDraw(x, y int16, spriteNo, imageNo uint16, flip bool) {
	if !traceEnabled {
		return
	}
	f := 0
	if flip {
		f = 1
	}
	fmt.Fprintf(traceOut, "  DRAW s=%d img=%d @%d,%d flip=%d\n", spriteNo, imageNo, x, y, f)
}

// traceOp logs a non-draw opcode of interest (DELAY, GOTO, PURGE, CLEAR, etc.).
func traceOp(format string, a ...any) {
	if !traceEnabled {
		return
	}
	fmt.Fprintf(traceOut, "  "+format+"\n", a...)
}

// traceFrameEnd closes a frame (at UPDATE) and returns true if the trace has hit
// its frame budget and the caller should stop.
func traceFrameEnd() bool {
	if !traceEnabled {
		return false
	}
	fmt.Fprintln(traceOut, "  ENDFRAME")
	traceFrameNo++
	return traceMaxFrame > 0 && traceFrameNo >= traceMaxFrame
}
