//go:build js

package main

import rl "github.com/gen2brain/raylib-go/raylib"

// registerSoundFS hands the embedded resources to raylib's virtual filesystem
// so LoadSound(path) can find them. The web build must load sounds by path:
// LoadWaveFromMemory([]byte) panics on the fork's FFI (it cannot marshal a Go
// slice), whereas LoadSound takes a string, which marshals fine.
func registerSoundFS() {
	rl.AddFileSystem(embeddedSounds)
}

// loadOneSound loads an embedded WAV by its virtual-filesystem path.
func loadOneSound(filename string) rl.Sound {
	return rl.LoadSound("resources/" + filename)
}
