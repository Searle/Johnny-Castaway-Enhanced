// Browsers block audio until a user gesture. miniaudio (raylib's web audio
// backend) creates its AudioContext suspended and does not expose it, so track
// every AudioContext at construction time and resume them all on the first
// pointer/key interaction with the page.
(function enableAudioOnGesture() {
  const contexts = [];
  ["AudioContext", "webkitAudioContext"].forEach((name) => {
    const Orig = window[name];
    if (!Orig) return;
    window[name] = function (...args) {
      const ctx = new Orig(...args);
      contexts.push(ctx);
      return ctx;
    };
    window[name].prototype = Orig.prototype;
  });
  const resumeAll = () => {
    contexts.forEach((c) => {
      if (c.state === "suspended") c.resume().catch(() => {});
    });
  };
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, resumeAll, { passive: true }),
  );
})();

// disable right click context menu
document.getElementById("canvas").addEventListener(
  "contextmenu",
  (e) => e.preventDefault(),
);

// Canvas sizing is handled purely by CSS (see the #stage wrapper in
// index.html); no JS is needed, and none is used, so it doesn't fight
// emscripten's own canvas-style management.

// INITIALIZE RAYLIB
import Module from "./rl/raylib.js";

const wasmBinary = await fetch("./rl/raylib.wasm")
  .then((r) => r.arrayBuffer());

// --- WebGL availability check ----------------------------------------------
// raylib needs WebGL. If the browser can't create a context (e.g. hardware
// acceleration disabled, or Chrome disabled the GPU after repeated crashes),
// the wasm would panic at the first GL call ("bindTexture on undefined").
// Detect that up front on a throwaway canvas and show a readable message
// instead of a raw crash.
const _canvas = document.getElementById("canvas");
(function requireWebGL() {
  let gl = null;
  try {
    const t = document.createElement("canvas");
    gl = t.getContext("webgl") || t.getContext("experimental-webgl");
  } catch (e) { /* falls through to the message below */ }
  if (gl) return;
  const stage = document.getElementById("stage");
  if (stage) {
    stage.innerHTML =
      '<div style="color:#ddd;font:16px/1.5 sans-serif;max-width:32em;' +
      'text-align:center;padding:1em">WebGL is not available in this browser.' +
      '<br><br>Enable hardware acceleration (or WebGL) and reload. In Chrome: ' +
      'Settings → System → “Use graphics acceleration when available”, ' +
      'then relaunch. See <code>chrome://gpu</code> for status.</div>';
  }
  throw new Error("WebGL unavailable");
})();

const raylib = await Module({
  canvas: _canvas,
  wasmBinary: new Uint8Array(wasmBinary),
});

// INITIALIZE GO
const go = new Go();
// inject raylib
go.importObject.raylib = raylib;
go.importObject.globalThis = globalThis;
globalThis.raylib = raylib;
// compatibility with old bindings (v1)
globalThis.mod = raylib;

import { Runtime } from "./runtime.js"; // helper funtions
//init
const runtime = new Runtime();
// inject custom runtime methods
Object.assign(go.importObject.gojs, {
  CStringFromGoString: runtime.CStringFromGoString.bind(runtime),
  CStringGetLength: runtime.CStringGetLength.bind(runtime),
  CStringArrayGetLength: runtime.CStringArrayGetLength.bind(runtime),
  CopyToC: runtime.CopyToC.bind(runtime),
  CopyToGo: runtime.CopyToGo.bind(runtime),
  Alert: runtime.Alert.bind(runtime),
});

WebAssembly.instantiateStreaming(fetch("main.wasm"), go.importObject).then(
  (result) => {
    const instance = result.instance;
    globalThis.goInstance = instance;
    go.run(instance);
  },
);
