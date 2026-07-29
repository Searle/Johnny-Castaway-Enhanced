# WebAssembly (browser) build — experimental

The game can be compiled to WebAssembly and run in a browser **without
emscripten**, using the pure-Go fork
[BrownNPC/Raylib-Go-Wasm](https://github.com/BrownNPC/Raylib-Go-Wasm),
which reimplements the raylib bindings against a prebuilt raylib WASM runtime.

The desktop build is unaffected: it keeps using upstream
`github.com/gen2brain/raylib-go` via the normal `go.mod`. The WASM build uses a
separate module overlay, `go.wasm.mod`, that swaps in the fork with `replace`
directives — so no source `import` paths or the desktop `go.mod` change.

## One-time setup

1. Clone the fork into the repo root (it is git-ignored):

   ```sh
   git clone https://github.com/BrownNPC/Raylib-Go-Wasm
   ```

2. Copy Go's wasm loader into the fork's serve directory:

   ```sh
   cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" Raylib-Go-Wasm/index/wasm_exec.js
   ```

## Build

```sh
GOOS=js GOARCH=wasm go build -modfile=go.wasm.mod -o Raylib-Go-Wasm/index/main.wasm .
```

## Run

Serve `Raylib-Go-Wasm/index/` over HTTP and open it in a browser:

```sh
python3 -m http.server 8080 -d Raylib-Go-Wasm/index
# then open http://localhost:8080/
```

(The fork also ships a `server/server.go` that serves the same directory.)

## Status

Work in progress. The package compiles and starts under `GOOS=js`, but the
blocking story/animation loop still needs to be inverted to the browser's
`requestAnimationFrame` model (raylib's `WindowShouldClose` is unsupported on
web; use `SetMainLoop`). Sound loading, which extracts WAVs to a temp
directory, also needs a browser-friendly path.
