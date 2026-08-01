package main

// Walk oracle reference: emits the engine's walk animation frame stream so the
// TS port (ts/tools/walk-check.ts) can be diffed against it exactly.
//
// Run: ./run.sh   (from ts/tools/walkoracle)
//
// CAVEAT — this RE-HOSTS walk.go's state machine rather than calling it, because
// walk.go's `data` is a raw C-style pointer into walkData and walkAnimate() is
// entangled with the renderer (grClearScreen/grDrawSprite) and thread structs.
// It reads the REAL walkData/calcpath tables (copied in by run.sh, never edited),
// so the DATA cannot drift — but the CONTROL FLOW is a transcription. If walk.go
// changes, update this too or the oracle silently stops proving anything.
// The step logic below is a line-by-line mirror of walkAnimate(); keep it that way.

import "fmt"

var (
	path         []int
	pathIdx      int
	currentSpot  int
	currentHdg   int
	nextSpot     int
	nextHdg      int
	finalSpot    int
	finalHdg     int
	increment    int
	lastTurn     int
	hasArrived   int
	isBehindTree int
	dataIdx      int
)

func turnDir(to, from int) int {
	d := (to - from) & 0x07
	if d == 0 {
		return 0
	}
	if d < 4 {
		return 1
	}
	return -1
}

func walkInitFixed(fromSpot, fromHdg, toSpot, toHdg int, p []int) {
	path = p
	pathIdx = 0
	currentSpot, currentHdg = fromSpot, fromHdg
	finalSpot, finalHdg = toSpot, toHdg
	hasArrived, isBehindTree = 0, 0
	if currentSpot == finalSpot {
		nextSpot, nextHdg, lastTurn = -1, finalHdg, 1
	} else {
		pathIdx++
		nextSpot = path[pathIdx]
		nextHdg = walkDataStartHeadings[currentSpot][nextSpot]
		lastTurn = 0
	}
	increment = turnDir(nextHdg, currentHdg)
}

func walkStep() (int, int, int, int, int, bool) {
	if hasArrived != 0 {
		return 0, 0, 0, 0, 0, false
	}
	if nextHdg != -1 {
		if (((nextHdg - currentHdg) & 0x07) % 7) > 1 {
			currentHdg = (currentHdg + increment) & 7
			dataIdx = walkDataBookmarksTurns[currentSpot] + currentHdg
			if lastTurn != 0 {
				dataIdx += 9
			}
		} else if currentSpot != finalSpot {
			nextHdg = -1
			if (currentSpot == 3 && nextSpot == 4) || (currentSpot == 4 && nextSpot == 3) {
				isBehindTree = 1
			} else {
				isBehindTree = 0
			}
			dataIdx = walkDataBookmarks[currentSpot][nextSpot]
		} else {
			dataIdx = walkDataBookmarksTurns[finalSpot] + finalHdg + 9
			hasArrived = 1
		}
	} else {
		dataIdx++
		if walkData[dataIdx][1] == 0 {
			currentHdg = walkDataEndHeadings[currentSpot][nextSpot]
			currentSpot = nextSpot
			if currentSpot != finalSpot {
				pathIdx++
				nextSpot = path[pathIdx]
				nextHdg = walkDataStartHeadings[currentSpot][nextSpot]
			} else {
				nextHdg = finalHdg
				lastTurn = 1
			}
			increment = turnDir(nextHdg, currentHdg)
			currentHdg = (currentHdg + increment) & 7
			dataIdx = walkDataBookmarksTurns[currentSpot] + currentHdg
			if lastTurn != 0 {
				dataIdx += 9
				if currentHdg == finalHdg {
					hasArrived = 1
				}
			}
			isBehindTree = 0
		}
	}
	r := walkData[dataIdx]
	delay := 6
	if hasArrived != 0 {
		delay = 80
	}
	return int(r[1]) - 1, int(r[2]), int(r[3]), int(r[0]), delay, true
}

func main() {
	// Exercise every spot/heading pair over a deterministic direct path.
	for from := 0; from < NumOfNodes; from++ {
		for to := 0; to < NumOfNodes; to++ {
			for fh := 0; fh < 8; fh++ {
				for th := 0; th < 8; th++ {
					// direct path from->to when legal, else skip
					var p []int
					if from == to {
						p = []int{from}
					} else if walkMatrix[UndefNode][from][to] != 0 {
						p = []int{from, to}
					} else {
						continue
					}
					walkInitFixed(from, fh, to, th, p)
					fmt.Printf("W %d,%d->%d,%d:", from, fh, to, th)
					for i := 0; i < 400; i++ {
						x, y, s, f, d, ok := walkStep()
						if !ok {
							break
						}
						fmt.Printf(" %d/%d/%d/%d/%d", x, y, s, f, d)
					}
					fmt.Println()
				}
			}
		}
	}
}
