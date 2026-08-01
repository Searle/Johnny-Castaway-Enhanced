package main

import (
	"fmt"
	"io"
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
	traceOut           io.Writer = os.Stdout

	// traceShots turns grUpdateDisplay's compositing back on and writes each
	// displayed frame to traceShotDir as a PNG — the PIXEL oracle. The draw-call
	// trace proves the interpreter is right; only rendered pixels can prove the
	// COMPOSITOR is (layer order, layer lifetime, when a frame is presented).
	// Every rendering bug found so far — Johnny vanishing in ACTIVITY:12, his
	// last walk frame lost in BUILDING:1 — passed the draw-call diff untouched.
	traceShots   = false
	traceShotDir = ""
	traceShotNo  = 0 // own counter — see grCaptureFrame for why not traceFrameNo
	// traceFrameNo as of the last shot, so a composite is captured only when a
	// new TTM frame was drawn since the previous one.
	lastShotFrameNo = 0
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
	if c, ok := traceOut.(io.Closer); ok && traceOut != os.Stdout {
		c.Close()
	}
}

// traceResetForScene restores the exact state a freshly-launched -trace process
// would have at the start of a scene: RNG streams re-seeded to their initial
// values, frame counter and budget flag cleared. The persistent -traceserver
// mode calls this before every scene so each trace matches the one-process-per-
// scene baseline bit-for-bit (otherwise scene N would inherit scene N-1's RNG
// position).
func traceResetForScene() {
	traceRngAds = 0x1234abcd
	traceRngTimer = 0x9e3779b9
	traceFrameNo = 0
	traceCurTag = 0
	traceReachedBudget = false
}

// Deterministic RNG for trace mode. When traceEnabled, the ADS RANDOM-block
// pick and the TTM TIMER opcode draw from these instead of the global math/rand,
// so a run is reproducible and the TS port (identical mulberry32 PRNG, same
// seeds) makes the same choices — the traces diff end-to-end.
//
// TWO INDEPENDENT STREAMS: ADS scene selection (traceRngAds) and TTM TIMER
// (traceRngTimer). Concurrent scenes consume TIMER randoms in amounts that
// depend on exact frame interleaving; a single shared stream let that shift the
// ADS pick and select a different scene. Separate streams keep the ADS picks
// deterministic regardless of how many TIMER randoms the frames drew.
var (
	traceRngAds   uint32 = 0x1234abcd // ADS RANDOM-block picks
	traceRngTimer uint32 = 0x9e3779b9 // TTM TIMER opcode
)

func mulberry32(state *uint32, n int) int {
	if n <= 0 {
		return 0
	}
	*state += 0x6D2B79F5
	z := *state
	z = (z ^ (z >> 15)) * (z | 1)
	z ^= z + (z^(z>>7))*(z|61)
	z = z ^ (z >> 14)
	return int(z % uint32(n))
}

// traceRandAds / traceRandTimer draw from their respective streams.
func traceRandAds(n int) int   { return mulberry32(&traceRngAds, n) }
func traceRandTimer(n int) int { return mulberry32(&traceRngTimer, n) }

// schedLog: temporary scheduler-decision log for the oracle diff. Goes to
// stderr (stdout carries the -traceserver protocol) and only when JC_SCHED_LOG
// is set, so it costs nothing in normal runs. Used to compare the ADS
// scheduler's DECISION SEQUENCE (add/stop/reap/random pick/conditional branch)
// against the TS port's, which is far more diagnostic than diffing draw calls.
var schedLogEnabled = os.Getenv("JC_SCHED_LOG") != ""

func schedLog(format string, a ...any) {
	if !schedLogEnabled {
		return
	}
	fmt.Fprintf(os.Stderr, "SCHED "+format+"\n", a...)
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
