//go:build !linux

package main

// preferX11Backend is Linux-specific (see platform_linux.go); a no-op elsewhere.
func preferX11Backend() {}
