//go:build js

package main

import (
	"bytes"
	"image/png"

	rl "github.com/gen2brain/raylib-go/raylib"
)

// newRGBAImage builds a raylib Image from tightly-packed RGBA8 bytes.
//
// The wasm fork's NewImageFromImage uploads the image one pixel at a time via
// a separate ImageDrawPixel FFI call each — hundreds of thousands of calls for
// a full-screen image, which is both very slow and leaks wasm memory faster
// than the GC reclaims it, eventually crashing ("cannot allocate memory") once
// the story loop starts reloading sprites. Instead, encode the pixels to PNG in
// Go and hand them to LoadImageFromMemory in a single FFI call (it correctly
// copies the []byte via CopySliceToC).
func newRGBAImage(pixelData []byte, width, height int) *rl.Image {
	var buf bytes.Buffer
	if err := png.Encode(&buf, rgbaFromBytes(pixelData, width, height)); err != nil {
		// Fall back to an empty image; a missing sprite is better than a crash.
		return rl.GenImageColor(width, height, rl.Blank)
	}
	data := buf.Bytes()
	return rl.LoadImageFromMemory(".png", data, int32(len(data)))
}
