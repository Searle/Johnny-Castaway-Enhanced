package main

import "image"

// rgbaFromBytes wraps a tightly-packed RGBA8 byte slice (4 bytes per pixel,
// row-major, no padding) as an *image.RGBA without copying.
func rgbaFromBytes(pixelData []byte, width, height int) *image.RGBA {
	return &image.RGBA{
		Pix:    pixelData,
		Stride: width * 4,
		Rect:   image.Rect(0, 0, width, height),
	}
}
