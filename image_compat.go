package main

import (
	"image"

	rl "github.com/gen2brain/raylib-go/raylib"
)

// newRGBAImage builds a raylib Image from a tightly-packed RGBA8 byte slice
// (4 bytes per pixel, row-major, no padding). It goes through Go's image.RGBA
// and rl.NewImageFromImage, which exists in both the desktop raylib-go and the
// WebAssembly fork — unlike rl.NewImage(data, w, h, mipmaps, format), which the
// wasm fork does not provide.
func newRGBAImage(pixelData []byte, width, height int) *rl.Image {
	img := &image.RGBA{
		Pix:    pixelData,
		Stride: width * 4,
		Rect:   image.Rect(0, 0, width, height),
	}
	return rl.NewImageFromImage(img)
}
