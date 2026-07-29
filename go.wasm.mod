// WebAssembly build overlay. Desktop builds use go.mod (upstream raylib-go);
// wasm builds use this file, which swaps in the pure-Go browser fork:
//
//   GOOS=js GOARCH=wasm go build -modfile=go.wasm.mod -o main.wasm .
//
// Keep the require/exclude lines in sync with go.mod; only the replace block
// and the fork's own deps are extra.
module JohnnyCastaway2026

go 1.26.1

require github.com/gen2brain/raylib-go/raylib v0.55.1

require (
	github.com/BrownNPC/Raylib-Go-Wasm/wasm-runtime v0.0.0-00010101000000-000000000000 // indirect
	github.com/BrownNPC/wasm-ffi-go v1.3.0 // indirect
)

replace (
	github.com/BrownNPC/Raylib-Go-Wasm/wasm-runtime => ./Raylib-Go-Wasm/wasm-runtime
	github.com/gen2brain/raylib-go/raylib => ./Raylib-Go-Wasm/raylib
)
