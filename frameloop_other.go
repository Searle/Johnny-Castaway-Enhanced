//go:build !js

package main

// Desktop stubs for the web frame-sync primitives (see frameloop_js.go).
// These are never called on desktop (guarded by the isWeb constant, which the
// compiler folds away) but must exist for the package to compile.

func webYieldFrame() {}

func webStart(engine func()) { engine() }
