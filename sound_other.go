//go:build !js

package main

import (
	"fmt"

	rl "github.com/gen2brain/raylib-go/raylib"
)

// registerSoundFS is only needed on the web build; a no-op on desktop.
func registerSoundFS() {}

// loadOneSound loads an embedded WAV straight from memory. This avoids a
// writable temp directory. See sound_js.go for the web variant.
func loadOneSound(filename string) rl.Sound {
	data, err := embeddedSounds.ReadFile("resources/" + filename)
	if err != nil {
		fmt.Printf("Warning: embedded sound %s not found\n", filename)
		return rl.Sound{}
	}
	wave := rl.LoadWaveFromMemory(".wav", data, int32(len(data)))
	snd := rl.LoadSoundFromWave(wave)
	rl.UnloadWave(wave)
	return snd
}
