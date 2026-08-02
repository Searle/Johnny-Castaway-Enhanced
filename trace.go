package main

import (
	"fmt"
	"io"
	"math/rand"
	"os"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"
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
	traceRngIsland = 0x85ebca6b
	traceFrameNo = 0
	traceCurTag = 0
	traceReachedBudget = false
}

// Deterministic RNG for trace mode. When traceEnabled, the ADS RANDOM-block
// pick and the TTM TIMER opcode draw from these instead of the global math/rand,
// so a run is reproducible and the TS port (identical mulberry32 PRNG, same
// seeds) makes the same choices — the traces diff end-to-end.
//
// THREE INDEPENDENT STREAMS, each isolated for the same reason: a stream that
// shares state with another lets one subsystem's draw count shift the other's
// choices.
//
//   - traceRngAds    ADS scene selection.
//   - traceRngTimer  TTM TIMER opcode. Concurrent scenes consume TIMER randoms
//     in amounts that depend on exact frame interleaving; sharing one stream let
//     that shift the ADS pick and select a different scene.
//   - traceRngIsland The island's procedural state: backdrop choice, tide,
//     VARPOS position, and cloud count/type/speed/position.
//
// The island stream was added last, and its absence was a real hole in the
// instrument rather than a property of the two engines: reading the UNSEEDED
// global rand made the Go engine nondeterministic AGAINST ITSELF. Measured over
// ten identical `STAND 2` runs — 4 tide=hi / 6 tide=lo, cloud counts 4/1/2,
// backdrop OCEAN02/OCEAN01 — which forced those fields out of the frame digest
// and left it blind to that whole class of state. Seeded, they are comparable.
var (
	traceRngAds    uint32 = 0x1234abcd // ADS RANDOM-block picks
	traceRngTimer  uint32 = 0x9e3779b9 // TTM TIMER opcode
	traceRngIsland uint32 = 0x85ebca6b // island: backdrop, tide, varpos, clouds
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

// islandRand is the island's draw. Outside trace/digest mode it falls through
// to the normal global rand, so real playback keeps its run-to-run variety —
// only the oracles get determinism.
func islandRand(n int) int {
	if !traceEnabled {
		if n <= 0 {
			return 0
		}
		return rand.Int() % n
	}
	return mulberry32(&traceRngIsland, n)
}

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
//
// traceResolve (JC_TRACE_RESOLVE=1) additionally logs the RESOLVED sheet name
// and cel size for the (imageNo, spriteNo) pair. `img=N` is a BMP SLOT index
// whose meaning is runtime state — which sheet is in that slot depends on every
// LOAD_IMAGE executed so far — so a bare slot number cannot be mapped to a
// sprite by reading data files. Guessing that mapping by eye is what sent three
// separate attempts at the 1px-edge bug chasing the wrong cel. With this on,
// the mapping is OBSERVED, and any disagreement between the engines about which
// sheet or what size is itself caught by the normal sweep.
var traceResolve = os.Getenv("JC_TRACE_RESOLVE") != ""

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

// traceClip logs the ACTIVE clip rect for a layer at draw time, under
// JC_TRACE_RESOLVE. The clip is the prime suspect for sprite edges that differ
// by exactly one pixel: the TTM args are INCLUSIVE corners (x1,y1)-(x2,y2), so
// the width is x2-x1+1, and an engine computing x2-x1 clips one column (and one
// row) short. Logging the rect each engine actually applied — rather than the
// opcode args — is what distinguishes "the scripts disagree" from "the same
// script produced different rects".
func traceClip(sur *rl.RenderTexture2D) {
	if !traceEnabled || !traceResolve {
		return
	}
	if r, ok := activeClipZones[sur]; ok {
		fmt.Fprintf(traceOut, "    CLIP %.0f,%.0f %.0fx%.0f\n", r.X, r.Y, r.Width, r.Height)
	} else {
		fmt.Fprintf(traceOut, "    CLIP none\n")
	}
}

// traceDrawResolved logs the sheet/size behind a draw, when JC_TRACE_RESOLVE is
// set. Kept separate from traceDraw so the default trace format — which the
// oracle diff compares byte-for-byte — is untouched.
func traceDrawResolved(slot *TTtmSlot, spriteNo, imageNo uint16) {
	if !traceEnabled || !traceResolve || slot == nil {
		return
	}
	name := "?"
	if int(imageNo) < len(slot.slotBmpNames) {
		name = slot.slotBmpNames[imageNo]
	}
	w, h := 0, 0
	if int(imageNo) < len(slot.sprites) && int(spriteNo) < len(slot.sprites[imageNo]) {
		if tex := slot.sprites[imageNo][spriteNo]; tex != nil {
			w, h = int(tex.Width), int(tex.Height)
		}
	}
	fmt.Fprintf(traceOut, "    RESOLVED %s#%d %dx%d\n", name, spriteNo, w, h)
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

// traceDumpCel writes one decoded sprite cel from the ENGINE's own texture to a
// PNG, so it can be compared against the extractor's PNG for the same cel. The
// two share decoder logic and palette construction, so any difference is in the
// resource bytes each one is reading — which is not decidable by reading code.
// Set JC_DUMP_CEL="SHEET.BMP:index:/path/out.png".
func traceDumpCel(slot *TTtmSlot, spriteNo, imageNo uint16) {
	spec := os.Getenv("JC_DUMP_CEL")
	if spec == "" || slot == nil {
		return
	}
	parts := strings.Split(spec, ":")
	if len(parts) != 3 {
		return
	}
	want, idx, out := parts[0], 0, parts[2]
	fmt.Sscanf(parts[1], "%d", &idx)
	if int(imageNo) >= len(slot.slotBmpNames) || slot.slotBmpNames[imageNo] != want || int(spriteNo) != idx {
		return
	}
	tex := slot.sprites[imageNo][spriteNo]
	if tex == nil {
		return
	}
	img := rl.LoadImageFromTexture(*tex)
	if img == nil {
		return
	}
	defer rl.UnloadImage(img)
	rl.ExportImage(*img, out)
	fmt.Fprintf(os.Stderr, "[dumpcel] wrote %s (%dx%d)\n", out, tex.Width, tex.Height)
}

// ---- frame-digest oracle ----------------------------------------------------
//
// The draw-call trace proves the INTERPRETER is right; it is structurally blind
// to the COMPOSITOR. The pixel oracle only partly covers that and costs ~6
// minutes, so it gets run at the end, when a bug is already buried. The digest
// is a TEXT oracle emitted at exactly the composite point, one line per
// DISPLAYED COMPOSITE, cheap enough to run after every edit.
//
// What it verifies that nothing else does: WHICH layers are composited, in WHAT
// ORDER, and WHEN a frame is shown. That is where every screensaver-era bug
// lived (clouds in the wrong slot, a scene's final frame dropped, a layer reaped
// an iteration early, a present on an iteration where nothing drew).
//
// Format (stable field order, no floats):
//
//	F <n> isl=<x>,<y> tide=<hi|lo> raft=<0-5> night=<0|1> clouds=<n> zones=<0|1> L=[<slot>:<tag>,...] hol=<0-4>
//
// Every field here is DETERMINISTIC. The island's procedural state (backdrop,
// tide, VARPOS position, cloud count) originally read from the UNSEEDED global
// rand, which made the Go engine disagree with ITSELF run to run — measured
// over ten identical `STAND 2` runs: 4 tide=hi / 6 tide=lo, cloud counts 4/1/2,
// backdrop OCEAN02/OCEAN01. Those fields were dropped for a while as a result,
// which quietly left the oracle blind to all of it. The real fix was a seeded
// island stream (traceRngIsland, reset per scene by traceResetForScene), not a
// smaller format.
//
// The BACKDROP NAME is deliberately absent, and for a different reason than the
// rand fields above — it is deterministic on both sides now, but it measures
// "who last called LOAD_SCREEN", which the two architectures answer differently
// by design. In the engine the ISLAND installs the backdrop (island.go:45/48
// grLoadScreen of NIGHT/OCEAN0n) and a scene's own LOAD_SCREEN of ISLETEMP.SCR
// is the island's own screen; the port keeps a baked ISLETEMP and suppresses
// the scene's load via TtmThread.keepBackground. Both are correct; comparing
// the name would encode a false equivalence. Everything the backdrop CHOICE
// depends on (night, tide, position) is reported directly instead.
//
// `L=[...]` is still the load-bearing payload: which thread layers composite,
// in what order. Order and membership are what catch z-order, layer-lifetime
// and reap-timing bugs, and all of it is read straight off grUpdateDisplay's
// arguments, so nothing has to be drawn to produce it.
//
// Deliberately NO per-layer sprite count: no such counter exists on either
// side, so it would have to be invented twice with identical semantics (when to
// reset, whether CLEAR_SCREEN zeroes it, whether an off-screen blit counts) — a
// new source of divergence unrelated to the bugs this exists to catch. The
// draw-call oracle already proves sprite-level equality. Keep this about
// STRUCTURE.
var (
	digestEnabled = false
	digestFrameNo = 0
	digestOut     io.Writer = os.Stdout
)

// digestResetForScene mirrors traceResetForScene for the digest's own counter.
func digestResetForScene() {
	digestFrameNo = 0
}

// emitDigest writes one line describing the composite that grUpdateDisplay is
// about to blit. Everything comes from the arguments and islandState, so
// nothing has to be drawn to produce it — which is what makes it as fast as the
// draw-call sweep.
func emitDigest(
	ttmThreads []TTtmThread,
	ttmHolidayThread *TTtmThread,
	ttmCloudsThread *TTtmThread,
) {
	tide := "hi"
	if islandState.lowTide != 0 {
		tide = "lo"
	}
	clouds := 0
	if ttmCloudsThread != nil && ttmCloudsThread.isRunning != 0 {
		clouds = int(islandState.clouds.numClouds)
	}
	zones := 0
	if grSavedZonesLayer != nil {
		zones = 1
	}
	hol := 0
	if ttmHolidayThread != nil && ttmHolidayThread.isRunning != 0 {
		hol = islandState.holiday
	}

	// The layer list IS the payload: membership and order are what catch
	// z-order, layer-lifetime and reap-timing bugs. It must therefore report the
	// order grUpdateDisplay ACTUALLY blits, which is not always fixed-array
	// order: when an always-on-top thread is present it makes two passes,
	// non-on-top first and on-top second (graphics.go, `if onTopIdx >= 0`).
	//
	// Reporting plain array order here was an ORACLE bug that made WALKSTUF:1
	// the last "failing" scene: the Go side said [1:1,1:2,1:4] while the port
	// said [1:4,1:1,1:2], and the PORT was right — 1:1 and 1:2 are on-top, so
	// they belong last. The oracle was measuring something the compositor does
	// not do.
	//
	// The johnnyIdx pass below it in grUpdateDisplay is deliberately NOT
	// mirrored: the port does not implement that exception yet (see the note on
	// ALWAYS_ON_TOP in scheduler.ts), so reporting it would flag a divergence
	// the digest cannot act on. It stays a known gap rather than a false green.
	onTopPresent := false
	for i := 0; i < MaxTTMThreads; i++ {
		if ttmThreads[i].isRunning != 0 && isAlwaysOnTopThread(ttmThreads[i].sceneSlot, ttmThreads[i].sceneTag) {
			onTopPresent = true
			break
		}
	}
	var l []string
	appendPass := func(wantOnTop bool) {
		for i := 0; i < MaxTTMThreads; i++ {
			if ttmThreads[i].isRunning == 0 {
				continue
			}
			if onTopPresent && isAlwaysOnTopThread(ttmThreads[i].sceneSlot, ttmThreads[i].sceneTag) != wantOnTop {
				continue
			}
			l = append(l, fmt.Sprintf("%d:%d", ttmThreads[i].sceneSlot, ttmThreads[i].sceneRootTag))
		}
	}
	appendPass(false)
	if onTopPresent {
		appendPass(true)
	}

	digestFrameNo++
	fmt.Fprintf(digestOut,
		"F %d isl=%d,%d tide=%s raft=%d night=%d clouds=%d zones=%d L=[%s] hol=%d\n",
		digestFrameNo, islandState.xPos, islandState.yPos, tide,
		islandState.raft, islandState.night, clouds, zones,
		strings.Join(l, ","), hol)
}
