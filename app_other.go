//go:build !js

package main

// runApp is the normal desktop entry: the full blocking story loop.
func runApp() {
	runStory()
}
