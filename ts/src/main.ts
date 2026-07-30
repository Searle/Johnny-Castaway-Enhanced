import { loadIndex, loadAnimation, type AnimIndex, type IndexEntry } from "./manifest";
import { Canvas2DRenderer } from "./render/canvas2d";
import { TtmThread } from "./ttm/interpreter";

// One TTM "tick" is ~33ms in the original (the ADS loop's per-tick sleep).
const TICK_MS = 33;

// Root of the batch-extracted assets (tsextract -all writes anim/<TTM>/…).
const ANIM_ROOT = `${import.meta.env.BASE_URL}anim`;

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const ttmSelect = document.getElementById("ttm") as HTMLSelectElement;
const tagSelect = document.getElementById("tag") as HTMLSelectElement;
const restartBtn = document.getElementById("restart") as HTMLButtonElement;

const renderer = new Canvas2DRenderer(canvas);

// Mutable playback state. The rAF loop reads `thread`; loaders swap it. A load
// token guards against overlapping async loads (rapid dropdown changes).
let thread: TtmThread | null = null;
let frames = 0;
let loadToken = 0;

async function loadScene(entry: IndexEntry, tag: number) {
  const token = ++loadToken;
  thread = null;
  hud.textContent = `loading ${entry.name}…`;
  try {
    const { manifest, sheets } = await loadAnimation(`${ANIM_ROOT}/${entry.dir}`);
    if (token !== loadToken) return; // superseded by a newer selection
    renderer.clearClip();
    renderer.setBackground(null);
    renderer.clearScreen();
    thread = new TtmThread(manifest, sheets, renderer, tag);
    frames = 0;
    renderer.present();
  } catch (err) {
    if (token === loadToken) hud.textContent = `error: ${(err as Error).message}`;
    console.error(err);
  }
}

// Populate the tag dropdown for a TTM and select `preferred` (or the entry's
// default drawing tag — which skips bootstrap tags that only load + PURGE).
function fillTags(entry: IndexEntry, preferred?: number) {
  tagSelect.innerHTML = "";
  for (const t of entry.tags) {
    const opt = document.createElement("option");
    opt.value = String(t);
    opt.textContent = t === entry.defaultTag ? `${t} (default)` : String(t);
    tagSelect.append(opt);
  }
  const tag = preferred ?? entry.defaultTag ?? entry.tags[0];
  tagSelect.value = String(tag);
  return tag;
}

function currentEntry(index: AnimIndex): IndexEntry {
  return index.ttms.find((t) => t.name === ttmSelect.value) ?? index.ttms[0];
}

async function main() {
  const index = await loadIndex(ANIM_ROOT);
  if (!index.ttms.length) throw new Error("no animations in index.json — run `npm run extract -- -all`");

  // Populate the animation dropdown.
  for (const t of index.ttms) {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.textContent = `${t.name}  (${t.tags.length} tags)`;
    ttmSelect.append(opt);
  }

  // Optional deep-link: ?anim=MJJOG.TTM&tag=1
  const params = new URLSearchParams(location.search);
  const wantAnim = params.get("anim");
  const wantTag = params.get("tag") != null ? Number(params.get("tag")) : undefined;
  if (wantAnim && index.ttms.some((t) => t.name === wantAnim.toUpperCase())) {
    ttmSelect.value = wantAnim.toUpperCase();
  }

  const entry0 = currentEntry(index);
  const tag0 = fillTags(entry0, wantTag);
  await loadScene(entry0, tag0);

  ttmSelect.addEventListener("change", () => {
    const entry = currentEntry(index);
    const tag = fillTags(entry);
    void loadScene(entry, tag);
  });
  tagSelect.addEventListener("change", () => {
    void loadScene(currentEntry(index), Number(tagSelect.value));
  });
  restartBtn.addEventListener("click", () => {
    void loadScene(currentEntry(index), Number(tagSelect.value));
  });

  // Single shared render loop.
  let acc = 0;
  let last = performance.now();
  function loop(now: number) {
    acc += now - last;
    last = now;
    if (thread) {
      let changed = false;
      let budget = 10; // cap catch-up after a tab switch
      while (acc >= TICK_MS && budget-- > 0) {
        acc -= TICK_MS;
        if (thread.tick()) changed = true;
      }
      if (changed) {
        renderer.present();
        frames++;
        hud.textContent = `${ttmSelect.value} — tag ${tagSelect.value} — frame ${frames}${thread.isDone ? " (done)" : ""}`;
      }
    } else {
      acc = 0; // don't accumulate ticks while a scene is loading
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  hud.textContent = `error: ${err.message ?? err}`;
});
