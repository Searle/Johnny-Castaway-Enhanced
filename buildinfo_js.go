//go:build js

package main

// isWeb reports whether this is the WebAssembly/browser build. Used to skip
// desktop-only patterns that are unsupported on the web, notably the blocking
// rl.WindowShouldClose() loops (raylib panics on WindowShouldClose on web;
// the browser drives frames via SetMainLoop instead).
const isWeb = true
