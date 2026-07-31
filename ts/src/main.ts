import { loadIndex, loadAnimation, type AnimIndex, type IndexEntry, type AdsIndexEntry } from "./manifest";
import { Canvas2DRenderer } from "./render/canvas2d";
import { TtmThread } from "./ttm/interpreter";
import { AdsScheduler, loadAds } from "./ads/scheduler";
import { positionForScene } from "./ads/positioning";

// One TTM "tick" is ~33ms in the original (the ADS loop's per-tick sleep).
const TICK_MS = 20; // one engine time-unit = 20ms (grUpdateDisplay: delay * 0.02s)
const ANIM_ROOT = `${import.meta.env.BASE_URL}anim`;

const $ = (id: string) => document.getElementById(id)!;
const canvas = $("screen") as HTMLCanvasElement;
const hud = $("hud") as HTMLDivElement;
const modeSelect = $("mode") as HTMLSelectElement;
const ttmControls = $("ttmControls") as HTMLElement;
const adsControls = $("adsControls") as HTMLElement;
const ttmSelect = $("ttm") as HTMLSelectElement;
const tagSelect = $("tag") as HTMLSelectElement;
const adsSelect = $("ads") as HTMLSelectElement;
const adsTagSelect = $("adsTag") as HTMLSelectElement;
const restartBtn = $("restart") as HTMLButtonElement;

const renderer = new Canvas2DRenderer(canvas);

// Exactly one of these drives playback at a time.
let thread: TtmThread | null = null;
let scheduler: AdsScheduler | null = null;
let frames = 0;
let loadToken = 0;

function stopPlayback() {
  thread = null;
  scheduler = null;
  renderer.resetLayers();
  renderer.setBackground(null);
}

// ---- TTM single-scene mode ----

async function loadTtmScene(entry: IndexEntry, tag: number) {
  const token = ++loadToken;
  stopPlayback();
  hud.textContent = `loading ${entry.name}…`;
  try {
    const { manifest, sheets } = await loadAnimation(`${ANIM_ROOT}/${entry.dir}`);
    if (token !== loadToken) return;
    const layer = renderer.newLayer();
    thread = new TtmThread(manifest, sheets, renderer, layer, tag);
    frames = 0;
    renderer.present();
  } catch (err) {
    if (token === loadToken) hud.textContent = `error: ${(err as Error).message}`;
    console.error(err);
  }
}

// ---- ADS script mode ----

async function loadAdsScript(entry: AdsIndexEntry, entryTag: number) {
  const token = ++loadToken;
  stopPlayback();
  hud.textContent = `loading ${entry.name}…`;
  try {
    const { ads, slots } = await loadAds(ANIM_ROOT, entry.dir);
    if (token !== loadToken) return;
    scheduler = new AdsScheduler(ads, slots, renderer, {
      position: (slot, tag) => positionForScene(entry.name, slot, tag),
    });
    scheduler.start(entryTag);
    frames = 0;
    renderer.present();
  } catch (err) {
    if (token === loadToken) hud.textContent = `error: ${(err as Error).message}`;
    console.error(err);
  }
}

// ---- dropdown population ----

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

function fillAdsTags(entry: AdsIndexEntry, preferred?: number) {
  adsTagSelect.innerHTML = "";
  for (const t of entry.tags) {
    const opt = document.createElement("option");
    opt.value = String(t);
    opt.textContent = String(t);
    adsTagSelect.append(opt);
  }
  const tag = preferred ?? entry.tags[0];
  adsTagSelect.value = String(tag);
  return tag;
}

async function main() {
  const index: AnimIndex = await loadIndex(ANIM_ROOT);
  if (!index.ttms.length) throw new Error("no animations — run `npm run extract -- -all`");

  for (const t of index.ttms) {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.textContent = `${t.name}  (${t.tags.length} tags)`;
    ttmSelect.append(opt);
  }
  for (const a of index.ads ?? []) {
    const opt = document.createElement("option");
    opt.value = a.name;
    opt.textContent = a.name;
    adsSelect.append(opt);
  }

  const params = new URLSearchParams(location.search);
  const ttmEntry = () => index.ttms.find((t) => t.name === ttmSelect.value) ?? index.ttms[0];
  const adsEntry = () => (index.ads ?? []).find((a) => a.name === adsSelect.value) ?? index.ads?.[0];

  // Deep links: ?ads=MARY.ADS[&tag=N] or ?anim=MJJOG.TTM[&tag=N]
  const wantAds = params.get("ads");
  const wantAnim = params.get("anim");
  const wantTag = params.get("tag") != null ? Number(params.get("tag")) : undefined;

  function applyMode(mode: string) {
    const ads = mode === "ads";
    adsControls.hidden = !ads;
    ttmControls.hidden = ads;
  }

  function reloadCurrent() {
    if (modeSelect.value === "ads") {
      const e = adsEntry();
      if (e) void loadAdsScript(e, Number(adsTagSelect.value));
    } else {
      void loadTtmScene(ttmEntry(), Number(tagSelect.value));
    }
  }

  if (wantAds && (index.ads ?? []).some((a) => a.name === wantAds.toUpperCase())) {
    modeSelect.value = "ads";
    adsSelect.value = wantAds.toUpperCase();
  } else if (wantAnim && index.ttms.some((t) => t.name === wantAnim.toUpperCase())) {
    ttmSelect.value = wantAnim.toUpperCase();
  }
  applyMode(modeSelect.value);

  // Initialize both dropdowns.
  fillTags(ttmEntry(), modeSelect.value === "ttm" ? wantTag : undefined);
  if (index.ads?.length) fillAdsTags(adsEntry()!, modeSelect.value === "ads" ? wantTag : undefined);
  reloadCurrent();

  modeSelect.addEventListener("change", () => {
    applyMode(modeSelect.value);
    reloadCurrent();
  });
  ttmSelect.addEventListener("change", () => {
    fillTags(ttmEntry());
    void loadTtmScene(ttmEntry(), Number(tagSelect.value));
  });
  tagSelect.addEventListener("change", () => void loadTtmScene(ttmEntry(), Number(tagSelect.value)));
  adsSelect.addEventListener("change", () => {
    const e = adsEntry();
    if (e) {
      fillAdsTags(e);
      void loadAdsScript(e, Number(adsTagSelect.value));
    }
  });
  adsTagSelect.addEventListener("change", () => {
    const e = adsEntry();
    if (e) void loadAdsScript(e, Number(adsTagSelect.value));
  });
  restartBtn.addEventListener("click", reloadCurrent);

  // Shared render loop.
  let acc = 0;
  let last = performance.now();
  function loop(now: number) {
    acc += now - last;
    last = now;
    let changed = false;
    let budget = 10;
    while (acc >= TICK_MS && budget-- > 0) {
      acc -= TICK_MS;
      if (thread) {
        if (thread.tick()) changed = true;
      } else if (scheduler) {
        if (scheduler.tick()) changed = true;
      } else {
        acc = 0;
      }
    }
    if (changed) {
      renderer.present();
      frames++;
      if (thread) {
        hud.textContent = `${ttmSelect.value} — tag ${tagSelect.value} — frame ${frames}${thread.isDone ? " (done)" : ""}`;
      } else if (scheduler) {
        hud.textContent = `${adsSelect.value} — ${scheduler.runningCount} scene(s) — frame ${frames}${scheduler.isStopped ? " (stopped)" : ""}`;
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  hud.textContent = `error: ${err.message ?? err}`;
});
