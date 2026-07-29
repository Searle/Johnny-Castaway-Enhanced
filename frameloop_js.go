//go:build js

package main

import rl "github.com/gen2brain/raylib-go/raylib"

// Frame synchronization for the WebAssembly build.
//
// The desktop engine is one blocking loop that paces itself with time.Sleep.
// The browser cannot block: raylib's SetMainLoop owns the requestAnimationFrame
// loop and parks the main goroutine forever. So we run the whole story engine
// in a separate goroutine and pace it with the rAF loop.
//
// The rAF callback (webFrameTick) runs to completion each animation frame; it
// simply releases the engine to compose exactly one frame, without blocking on
// it. The engine calls webYieldFrame() at each frame boundary (where desktop
// would time.Sleep) and blocks there until the next rAF tick. Because Go's wasm
// runtime is single-threaded and cooperatively scheduled, the engine goroutine
// gets to run — and finish its frame, including the WebGL BeginDrawing/
// EndDrawing calls — while the rAF callback is parked in the scheduler between
// ticks.
//
// frameGo is buffered (size 1) so a tick that fires while the engine is still
// working is not lost and does not block the rAF callback.
var frameGo = make(chan struct{}, 1)

// webStart runs the engine in a goroutine and hands the rAF loop to raylib.
func webStart(engine func()) {
	go engine()
	rl.SetMainLoop(webFrameTick)
}

// webFrameTick is the rAF callback: release the engine for one frame. Never
// blocks (drops the signal if one is already pending), so the browser's frame
// loop keeps running smoothly regardless of engine timing.
func webFrameTick() {
	select {
	case frameGo <- struct{}{}:
	default:
	}
}

// webYieldFrame is called by the engine at each frame boundary: block until the
// next rAF tick releases it.
func webYieldFrame() {
	<-frameGo
}
