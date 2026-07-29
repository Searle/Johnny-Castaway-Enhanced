//go:build js

package main

// runApp is the WebAssembly entry. It runs the full story/animation engine in
// a goroutine and drives raylib's requestAnimationFrame loop, so the browser
// build now shows the animated screensaver (not just a static frame). The
// engine paces itself through webYieldFrame() at each frame boundary; see
// frameloop_js.go for the goroutine/rAF synchronization.
func runApp() {
	setupApp()

	webStart(func() {
		storyPlay()
	})
}
