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

3. Copy this repo's page shell over the fork's defaults (adds viewport-fit
   scaling of the canvas — see `web/`):

   ```sh
   cp web/index.html web/index.js Raylib-Go-Wasm/index/
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

The animated screensaver runs in the browser: the full story/animation engine
is driven frame-by-frame via `requestAnimationFrame` (the blocking desktop loop
is inverted with a goroutine + frame-sync channel; see `frameloop_js.go`). The
canvas scales to fill the viewport, preserving aspect ratio (`web/`).

Remaining polish, none blocking:

- **Sound** — `loadSfx()` extracts WAVs to a temp directory then loads them by
  path; the browser has no writable temp filesystem, so sound is currently
  silent. A browser path would load from the embedded FS instead.
- **Filter shaders** — the CRT/dither/scanline fragment shaders are desktop
  GLSL and fail to compile as WebGL (GLSL ES 3.00). The default no-shader path
  renders fine; only the optional filters are affected.
