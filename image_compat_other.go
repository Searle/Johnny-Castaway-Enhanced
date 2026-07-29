//go:build !js

package main

import rl "github.com/gen2brain/raylib-go/raylib"

// newRGBAImage builds a raylib Image from tightly-packed RGBA8 bytes. On
// desktop raylib-go, NewImageFromImage uploads the whole buffer at once, so
// this is cheap. (See image_compat_js.go for the WebAssembly path.)
func newRGBAImage(pixelData []byte, width, height int) *rl.Image {
	return rl.NewImageFromImage(rgbaFromBytes(pixelData, width, height))
}
