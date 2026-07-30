import { loadAnimation } from "./manifest";
import { Canvas2DRenderer } from "./render/canvas2d";
import { TtmThread } from "./ttm/interpreter";

// One TTM "tick" is ~33ms in the original (the ADS loop's per-tick sleep).
// Driving the interpreter at that rate makes SET_DELAY/TIMER values map to the
// same real-world durations the screensaver used.
const TICK_MS = 33;

// Which pre-extracted animation to play (see tools/tsextract). Overridable via
// ?anim=<dir> for quick experimentation.
const params = new URLSearchParams(location.search);
const animDir = params.get("anim") ?? "anim";
// Optional scene entry point; the real engine's ADS script picks this. Defaults
// to the TTM's first tag.
const startTagParam = params.get("tag");
const startTag = startTagParam != null ? Number(startTagParam) : undefined;

async function main() {
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  const hud = document.getElementById("hud") as HTMLDivElement;

  const renderer = new Canvas2DRenderer(canvas);

  hud.textContent = "loading assets…";
  const { manifest, sheets } = await loadAnimation(`${import.meta.env.BASE_URL}${animDir}`);
  const thread = new TtmThread(manifest, sheets, renderer, startTag);

  const usedTag = startTag ?? thread.tagIds[0];
  hud.textContent = `${manifest.ttm} — tag ${usedTag} (of ${thread.tagIds.join(",")})`;

  let acc = 0;
  let last = performance.now();
  let frames = 0;

  function loop(now: number) {
    acc += now - last;
    last = now;

    let changed = false;
    // Advance whole ticks; guard against huge catch-ups after a tab switch.
    let budget = 10;
    while (acc >= TICK_MS && budget-- > 0) {
      acc -= TICK_MS;
      if (thread.tick()) changed = true;
    }

    if (changed) {
      renderer.present();
      frames++;
      hud.textContent = `${manifest.ttm} — frame ${frames}`;
    }

    if (thread.isDone) {
      hud.textContent = `${manifest.ttm} — done`;
      return;
    }
    requestAnimationFrame(loop);
  }

  // Draw the initial background/black frame before the first tick lands.
  renderer.present();
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `error: ${err.message ?? err}`;
});
