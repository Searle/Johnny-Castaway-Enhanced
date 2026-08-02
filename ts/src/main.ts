import { loadIndex, loadAnimation, type AnimIndex, type IndexEntry, type AdsIndexEntry } from "./manifest";
import { Canvas2DRenderer } from "./render/canvas2d";
import { TtmThread, setTraceSink, setSoundSink } from "./ttm/interpreter";
import { SoundPlayer } from "./sound";
import { AdsScheduler, loadAds, setSchedSink } from "./ads/scheduler";
import { positionForScene, sceneHasIsland } from "./ads/positioning";
import { Story, STORY_DAYS } from "./story/story";
import { Island, ISLAND_DIR, type IslandAssets } from "./story/island";
import { Walk } from "./story/walk";
import { SceneFlag, type StoryScene } from "./story/data";
import type { Layer } from "./render/renderer";
import type { LoadedSheet } from "./manifest";

// One TTM "tick" is ~33ms in the original (the ADS loop's per-tick sleep).
const TICK_MS = 20; // one engine time-unit = 20ms (grUpdateDisplay: delay * 0.02s)
// The background(waves) and clouds threads both run on an 8-tick delay
// (islandInit sets 8, overriding the 40 above it; clouds are 8).
const ISLAND_TICK = 8;
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
const storyControls = $("storyControls") as HTMLElement;
const storyDaySelect = $("storyDay") as HTMLSelectElement;
const storyTideSelect = $("storyTide") as HTMLSelectElement;
const storySkySelect = $("storySky") as HTMLSelectElement;
const storyHolidaySelect = $("storyHoliday") as HTMLSelectElement;
const storyPosSelect = $("storyPos") as HTMLSelectElement;
const storyNextBtn = $("storyNext") as HTMLButtonElement;
const soundToggle = $("soundToggle") as HTMLInputElement;

const renderer = new Canvas2DRenderer(canvas);
const soundPlayer = new SoundPlayer(`${ANIM_ROOT}/_SOUND`);

// Exactly one of these drives playback at a time.
let thread: TtmThread | null = null;
let scheduler: AdsScheduler | null = null;
let frames = 0;
let loadToken = 0;

// Screensaver mode: non-null while the story driver owns playback. It queues
// scenes and advances when the running one drains; see advanceStory().
let story: {
  driver: Story;
  queue: StoryScene[];
  current: StoryScene | null;
  // Where Johnny stands after the scene that just finished, so the next walk
  // knows where to start. null before the first scene (nothing to walk from).
  prevSpot: number | null;
  prevHdg: number;
  // Non-null while a walk transition is playing instead of a scene.
  walk: { w: Walk; layer: Layer } | null;
  // Set synchronously by advanceStory and cleared once the next beat is live.
  // Advancing involves awaits (sheet decode, ADS load), during which the old
  // scheduler is still attached and still drained — without this the render
  // loop would call advanceStory again on the very next frame and eat a scene.
  advancing: boolean;
  // The island for the CURRENT episode, plus its animation layers. Rebuilt when
  // a FINAL scene ends the episode (adsReleaseIsland → adsInitIsland).
  island: Island | null;
  cloudLayer: Layer | null;
  // (holiday lives on the renderer overlay, not a story-owned layer)
  // Wave/cloud metronomes. Both run on an 8-tick delay in the engine, and they
  // are what quantizes the scheduler — see the metronome note in the scheduler.
  waveTimer: number;
  cloudTimer: number;
} | null = null;
// Module-level copy of the ADS index so story mode can resolve scene names
// outside main()'s scope. Set once, at startup.
let adsIndex: AdsIndexEntry[] = [];

// keepStory: story mode calls this between its own beats, where the story
// driver must survive even though the scheduler is being torn down. Every other
// caller is switching away from playback entirely and wants it cleared.
//
// It also KEEPS THE BACKDROP. In the engine the island is drawn once per
// episode (adsInitIsland) and survives every scene change and walk within it;
// only adsReleaseIsland at the end of an episode takes it down. Clearing it
// between beats left walks playing against black, since a walk runs no TTM and
// so never issues the LOAD_SCREEN that would restore it.
function stopPlayback(keepStory = false) {
  thread = null;
  scheduler = null;
  if (!keepStory) story = null;
  renderer.resetLayers();
  if (keepStory && story) {
    // resetLayers() just dropped the island's cloud/holiday layers along with
    // the scene's. Recreate them first, so they sit UNDER the scene layers the
    // next beat is about to add (newLayer stacks on top).
    story.cloudLayer = story.island && story.island.cloudCount > 0 ? renderer.newLayer() : null;
  }
  if (!keepStory) {
    renderer.setBackground(null);
    renderer.clearBackgroundLayer();
    renderer.clearOverlayLayer();
    // Leaving story mode hands the backdrop back to the TTM interpreter.
    TtmThread.keepBackground = false;
  }
  // Cleared here (start of every load) so the harness never observes a stale
  // ready flag from a previous scene while the new one is still loading.
  (window as unknown as { __ready?: boolean }).__ready = false;
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
    // Standalone scene viewing: no ADS scheduler owns a duration timer, so loop
    // on PURGE instead of ending, keeping the animation on screen.
    thread.loopForever = true;
    frames = 0;
    renderer.present();
    (window as unknown as { __ready?: boolean }).__ready = true;
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
      island: sceneHasIsland(entry.name, entryTag),
      adsName: entry.name,
    });
    scheduler.start(entryTag);
    frames = 0;
    renderer.present();
    // Signal to the oracle harness that assets are decoded and playback is
    // live, so it can poll instead of guessing with a fixed sleep.
    (window as unknown as { __ready?: boolean }).__ready = true;
  } catch (err) {
    if (token === loadToken) hud.textContent = `error: ${(err as Error).message}`;
    console.error(err);
  }
}

// ---- screensaver (story) mode ----

const STORY_KEY = "jc.story.progress";

// Play one story scene. Unlike the ADS viewer this does NOT loop on drain —
// draining is precisely the signal that the beat is over and the next one
// should start (advanceStory below).
async function loadStoryScene(scene: StoryScene): Promise<void> {
  const token = ++loadToken;
  const entry = (adsIndex ?? []).find((a) => a.name === scene.adsName);
  if (!entry) {
    hud.textContent = `story: missing ${scene.adsName}`;
    return;
  }
  stopPlayback(true); // tear down the previous scene, keep the story driver
  // storyPlay() plays sound 17 before any dated scene — the story-beat sting
  // that marks a day-specific event (MARY's visit, SUZY, the rescue).
  if (scene.dayNo !== 0) soundPlayer.play(17);
  try {
    const { ads, slots } = await loadAds(ANIM_ROOT, entry.dir);
    if (token !== loadToken) return;
    scheduler = new AdsScheduler(ads, slots, renderer, {
      // With a REAL island we can finally honour the engine's positioning:
      // ttmDx = islandState.xPos + (LEFT_ISLAND ? 272 : 0), the same offset the
      // island itself was drawn at, so sprites stay on it wherever it landed.
      // (The old static-backdrop port had to pin this to 0 — see positioning.ts.)
      position: () => {
        if (!story?.island) return positionForScene(entry.name, 0, 0);
        const st = story.driver.island;
        const xOffset = (scene.flags & SceneFlag.LEFT_ISLAND) !== 0 ? 272 : 0;
        return { dx: st.xPos + xOffset, dy: st.yPos };
      },
      island: sceneHasIsland(entry.name, scene.adsTag),
      adsName: entry.name,
    });
    scheduler.start(scene.adsTag);
    frames = 0;
    renderer.present();
    (window as unknown as { __ready?: boolean }).__ready = true;
  } catch (err) {
    if (token === loadToken) hud.textContent = `error: ${(err as Error).message}`;
    console.error(err);
  }
}

// ---- island ----

// Test overrides from the story controls. The island's real state comes from
// the calendar and the scene's flags, which makes tide/night/holiday/position
// hard to see on demand — Christmas is three days a year. These pin a value so
// each configuration can actually be looked at. "auto" leaves the engine's own
// choice alone; nothing here changes scene SELECTION, only how the island
// renders, so the story logic under test stays the real one.
const storyOverrides: {
  day: number | null;
  tide: "auto" | "high" | "low";
  sky: "auto" | "day" | "night";
  holiday: number | null;
  centered: boolean;
} = { day: null, tide: "auto", sky: "auto", holiday: null, centered: false };

// Apply the overrides to the island state the driver just computed.
function applyIslandOverrides(): void {
  if (!story) return;
  const st = story.driver.island;
  if (storyOverrides.tide !== "auto") st.lowTide = storyOverrides.tide === "low";
  if (storyOverrides.sky !== "auto") st.night = storyOverrides.sky === "night";
  if (storyOverrides.holiday !== null) st.holiday = storyOverrides.holiday;
  if (storyOverrides.centered) {
    st.xPos = 0;
    st.yPos = 0;
  }
}

let islandAssets: IslandAssets | null = null;

async function ensureIslandAssets(): Promise<IslandAssets | null> {
  if (islandAssets) return islandAssets;
  try {
    const { manifest, sheets } = await loadAnimation(`${ANIM_ROOT}/${ISLAND_DIR}`);
    const backgrnd = sheets.get("BACKGRND.BMP");
    const raft = sheets.get("MRAFT.BMP");
    const holiday = sheets.get("HOLIDAY.BMP");
    if (!backgrnd || !raft || !holiday) throw new Error("island sheets missing");
    // Screens come back in the same map, keyed by SCR name.
    const screens = new Map<string, ImageBitmap>();
    for (const s of manifest.screens ?? []) {
      const img = sheets.get(s.name)?.frames[0];
      if (img) screens.set(s.name, img);
    }
    islandAssets = { backgrnd, raft, holiday, screens };
  } catch (err) {
    console.error("island assets unavailable — falling back to the baked backdrop", err);
    islandAssets = null;
  }
  return islandAssets;
}

// Build the island for a new episode: pick the backdrop, paint the island onto
// the background surface, and seed the clouds. Mirrors adsInitIsland().
async function buildIsland(): Promise<void> {
  if (!story) return;
  const assets = await ensureIslandAssets();
  if (!assets) return;
  const island = new Island(assets, Math.random);
  const st = story.driver.island;

  renderer.clearBackgroundLayer();
  renderer.setBackground(island.backdropFor(st));
  island.build(st, renderer.backgroundLayer());
  island.initClouds();

  story.island = island;
  // From here on the island owns the backdrop; scene LOAD_SCREENs must not
  // paint the baked ISLETEMP stand-in over it.
  TtmThread.keepBackground = true;
  // Create the cloud layer NOW, while no scene layer exists. newLayer() stacks
  // above everything present, so a lazily-created cloud layer would end up
  // drawing OVER Johnny. Clouds belong between the island and the scene, which
  // is exactly what creating it first gives us. (The engine gets this from its
  // fixed thread order: background, clouds, then scene threads.)
  story.cloudLayer = island.cloudCount > 0 ? renderer.newLayer() : null;
  // Holiday decorations go on the always-on-top overlay: the engine runs them
  // as their own thread composited after every scene thread, so the Christmas
  // tree is never hidden behind Johnny.
  renderer.clearOverlayLayer();
  island.drawHoliday(st, renderer.overlayLayer());
  story.waveTimer = 0;
  story.cloudTimer = 0;
}

// Tick the island's own animation threads. They run independently of whatever
// scene or walk is playing, which is why the shore keeps moving during a hold.
// Returns true if anything on the island changed, so the caller knows the
// screen needs recompositing even when no scene thread drew.
function animateIsland(cost: number): boolean {
  if (!story?.island) return false;
  const st = story.driver.island;
  let changed = false;

  story.waveTimer -= cost;
  if (story.waveTimer <= 0) {
    story.waveTimer = ISLAND_TICK;
    story.island.animateWaves(st, renderer.backgroundLayer());
    changed = true;
  }

  story.cloudTimer -= cost;
  if (story.cloudTimer <= 0) {
    story.cloudTimer = ISLAND_TICK;
    if (story.cloudLayer) {
      story.island.animateClouds(story.cloudLayer);
      changed = true;
    }
  }
  return changed;
}

// JOHNWALK.BMP holds the walk/turn sprites. It isn't part of any ADS script, so
// it's loaded on its own from the TTM that ships it (adsPlayWalk grLoadBmp's it
// into slot 0 of a bare scene).
const WALK_SHEET_TTM = "MJJOG.TTM";
const WALK_SHEET = "JOHNWALK.BMP";
let walkSheet: LoadedSheet | null = null;

async function ensureWalkSheet(): Promise<LoadedSheet | null> {
  if (walkSheet) return walkSheet;
  try {
    const { sheets } = await loadAnimation(`${ANIM_ROOT}/${WALK_SHEET_TTM}`);
    walkSheet = sheets.get(WALK_SHEET) ?? null;
  } catch (err) {
    console.error("walk sheet load failed", err);
    walkSheet = null;
  }
  return walkSheet;
}

// Start a walk from the previous scene's end spot to the next scene's start
// spot. Returns false if no walk applies (first scene of a run, same spot and
// heading, or the sheet is unavailable) — the caller then goes straight to the
// scene, exactly as storyPlay() skips adsPlayWalk when prevSpot is -1.
async function startWalk(to: StoryScene): Promise<boolean> {
  if (!story || story.prevSpot === null) return false;
  const sheet = await ensureWalkSheet();
  if (!sheet) return false;
  const from = story.prevSpot;
  const fromHdg = story.prevHdg;
  if (from === to.spotStart && fromHdg === to.hdgStart) return false;

  stopPlayback(true); // drop the finished scene's layer, keep the story driver
  const layer = renderer.newLayer();
  // adsPlayWalk sets grDx/grDy to the DESTINATION scene's offset before walking,
  // so a walk toward a LEFT_ISLAND scene renders on the right half of the island.
  if (story.island) {
    const st = story.driver.island;
    const xOffset = (to.flags & SceneFlag.LEFT_ISLAND) !== 0 ? 272 : 0;
    layer.setOrigin(st.xPos + xOffset, st.yPos);
  }
  story.walk = { w: new Walk(from, fromHdg, to.spotStart, to.hdgStart, Math.random), layer };
  frames = 0;
  (window as unknown as { __ready?: boolean }).__ready = true;
  return true;
}

// Advance the running walk by one engine tick. Returns the tick cost, or null
// once the walk is finished (which hands control back to scene playback).
function stepWalk(): number | null {
  if (!story?.walk || !walkSheet) return null;
  const { w, layer } = story.walk;
  const f = w.step();
  if (!f) return null;

  layer.clear();
  const img = walkSheet.frames[f.spriteNo];
  if (img) layer.drawSprite(img, f.x, f.y, f.flip);
  // Walking behind the palm: redraw trunk + leaves ON TOP of Johnny, exactly as
  // walkAnimate does. Now possible because the island owns the real sprites.
  if (f.behindTree && story.island) story.island.drawPalmOver(layer);
  // The caller presents (after ticking the island), so the shore and clouds
  // animate during walks too.
  frames++;
  return f.delay;
}

// Pull the next scene, building a fresh episode when the current one is spent.
// Walks first (if there is somewhere to walk from), then plays the scene.
function advanceStory(): void {
  if (!story || story.advancing) return;
  // A fresh episode re-rolls the island (tide, raft, position, holiday), so it
  // has to be rebuilt — adsReleaseIsland + adsInitIsland around storyPlay's loop.
  const newEpisode = story.queue.length === 0;
  if (newEpisode) {
    story.queue = story.driver.buildEpisode();
    applyIslandOverrides();
  }
  const next = story.queue.shift() ?? null;
  story.current = next;
  if (!next) return;
  story.advancing = true;
  void (async () => {
    try {
      if (newEpisode) await buildIsland();
      // A walk, if there is one, hands off to the scene when it finishes.
      if (await startWalk(next)) return;
      await loadStoryScene(next);
    } finally {
      if (story) story.advancing = false;
    }
  })();
}

// Called when a walk finishes: play the scene it was heading to.
function finishWalk(): void {
  if (!story) return;
  story.walk = null;
  const next = story.current;
  if (!next) return;
  // Same in-flight guard as advanceStory: the load awaits, and until it lands
  // there is no walk and no live scheduler for the loop to see.
  story.advancing = true;
  void loadStoryScene(next).finally(() => {
    if (story) story.advancing = false;
  });
}

function startStory(): void {
  stopPlayback();
  renderer.clearOverlayLayer();
  const driver = new Story({
    loadProgress: () => {
      // A pinned day short-circuits persistence: report it as already-current
      // so updateCurrentDay() doesn't advance past it on the next episode.
      if (storyOverrides.day !== null) {
        return { day: storyOverrides.day, dayOfYear: dayOfYearNow() };
      }
      try {
        const raw = localStorage.getItem(STORY_KEY);
        return raw ? (JSON.parse(raw) as { day: number; dayOfYear: number }) : null;
      } catch {
        return null; // private mode / disabled storage: just start at day 1
      }
    },
    saveProgress: (p) => {
      if (storyOverrides.day !== null) return; // don't persist a test pin
      try {
        localStorage.setItem(STORY_KEY, JSON.stringify(p));
      } catch {
        /* non-fatal */
      }
    },
  });
  story = {
    driver,
    queue: [],
    current: null,
    prevSpot: null,
    prevHdg: 0,
    walk: null,
    advancing: false,
    island: null,
    cloudLayer: null,
    waveTimer: 0,
    cloudTimer: 0,
  };
  advanceStory();
}

function dayOfYearNow(): number {
  const d = new Date();
  const start = Date.UTC(d.getFullYear(), 0, 0);
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((now - start) / 86_400_000);
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
  adsIndex = index.ads ?? [];

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
    // Story mode picks its own scenes, so neither picker applies.
    adsControls.hidden = mode !== "ads";
    ttmControls.hidden = mode !== "ttm";
    storyControls.hidden = mode !== "story";
  }

  // Story day picker: 1..11, plus "auto" for the persisted calendar day.
  {
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "auto";
    storyDaySelect.append(auto);
    for (let d = 1; d <= STORY_DAYS; d++) {
      const o = document.createElement("option");
      o.value = String(d);
      o.textContent = String(d);
      storyDaySelect.append(o);
    }
  }

  // Changing any override restarts the story so a fresh episode picks it up —
  // island state is decided once per episode, not per scene.
  const restartStory = () => {
    if (modeSelect.value === "story") startStory();
  };
  storyDaySelect.addEventListener("change", () => {
    storyOverrides.day = storyDaySelect.value === "auto" ? null : Number(storyDaySelect.value);
    restartStory();
  });
  storyTideSelect.addEventListener("change", () => {
    storyOverrides.tide = storyTideSelect.value as "auto" | "high" | "low";
    restartStory();
  });
  storySkySelect.addEventListener("change", () => {
    storyOverrides.sky = storySkySelect.value as "auto" | "day" | "night";
    restartStory();
  });
  storyHolidaySelect.addEventListener("change", () => {
    storyOverrides.holiday =
      storyHolidaySelect.value === "auto" ? null : Number(storyHolidaySelect.value);
    restartStory();
  });
  storyPosSelect.addEventListener("change", () => {
    storyOverrides.centered = storyPosSelect.value === "0";
    restartStory();
  });
  // Skip the current beat without waiting out its PURGE-loop timer — idle
  // STAND poses legitimately hold for tens of seconds, which makes eyeballing
  // a sequence of scenes painful.
  storyNextBtn.addEventListener("click", () => {
    if (!story) return;
    story.walk = null;
    story.advancing = false;
    advanceStory();
  });

  function reloadCurrent() {
    if (modeSelect.value === "story") {
      startStory();
    } else if (modeSelect.value === "ads") {
      const e = adsEntry();
      if (e) void loadAdsScript(e, Number(adsTagSelect.value));
    } else {
      void loadTtmScene(ttmEntry(), Number(tagSelect.value));
    }
  }

  if (params.get("story") != null) {
    modeSelect.value = "story";
  } else if (wantAds && (index.ads ?? []).some((a) => a.name === wantAds.toUpperCase())) {
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

  // Frame-dump mode (?dump): expose a stepper that advances the scheduler until
  // the next DISPLAYED frame and returns the canvas + scene state, so a harness
  // can save every frame regardless of its delay. Bypasses the rAF loop.
  if (params.has("dump")) {
    // Expose the live scheduler for harness/debug introspection.
    Object.defineProperty(window, "__sched", { get: () => scheduler });

    // __load(ads, tag): switch scenes IN-PAGE, so a sweep doesn't reload the
    // document per scene. A reload re-parses the app, re-fetches and re-decodes
    // every sprite sheet and waits on networkidle — ~1.34s/scene, which was
    // ~95% of the whole sweep's wall clock. Switching in-page keeps the decoded
    // sheets in loadAnimation's cache and costs ~0.1s.
    (window as unknown as { __load: (a: string, t: number) => Promise<boolean> }).__load = async (
      adsName: string,
      tag: number,
    ) => {
      const e = (index.ads ?? []).find((a) => a.name === adsName.toUpperCase());
      if (!e) return false;
      adsSelect.value = e.name;
      fillAdsTags(e, tag);
      await loadAdsScript(e, tag);
      return true;
    };
    (window as unknown as { __dumpStep: () => unknown }).__dumpStep = () => {
      // Advance ticks until one produces a new displayed frame (or the script
      // stops). This captures each frame once, ignoring wall-clock delay.
      //
      // The snapshot is taken from INSIDE the tick, at the scheduler's
      // grUpdateDisplay point (onPresent) — not after tick() returns. The reap
      // step at the end of a tick frees a finished scene's layer, so grabbing
      // the canvas afterwards can miss that scene's final frame entirely
      // (BUILDING.ADS tag 1: Johnny's last walking sprite).
      let png: string | null = null;
      let sceneSnapshot: { slot: number; tag: number; delay: number }[] = [];
      if (scheduler) {
        scheduler.onPresent = () => {
          renderer.present();
          png = canvas.toDataURL("image/png");
          sceneSnapshot = scheduler!.debugScenes();
        };
      }
      try {
        let guard = 100000;
        while (guard-- > 0) {
          const changed = thread ? thread.tick() : scheduler ? scheduler.tick() : false;
          if (changed) {
            if (!scheduler) renderer.present(); // single-TTM mode has no scheduler
            frames++;
            const stopped = thread ? thread.isDone : scheduler ? scheduler.isStopped : true;
            return {
              frame: frames,
              stopped,
              scenes: scheduler ? sceneSnapshot : [],
              png: png ?? canvas.toDataURL("image/png"),
            };
          }
          const dead = thread ? thread.isDone : scheduler ? scheduler.isStopped : true;
          if (dead) return { frame: frames, stopped: true, scenes: [], png: canvas.toDataURL("image/png") };
        }
        return { frame: frames, stopped: true, scenes: [], png: canvas.toDataURL("image/png") };
      } finally {
        if (scheduler) scheduler.onPresent = null;
      }
    };

    // __trace(n): run n displayed frames capturing the canonical draw-call trace
    // (same format as the Go engine's -trace) and return it as text, for the
    // oracle diff. Deterministic: steps by displayed frame, not wall clock.
    // runForFrames drives the engine until it has EMITTED n frames, mirroring the
    // Go engine's traceMaxFrame / traceReachedBudget (trace.go): the budget is
    // counted where frames are actually written (TtmThread's ENDFRAME), not by
    // "ticks that changed the display". Those are different — one scheduler tick
    // can run TWO threads and emit two frames — so tick-counting overshot and
    // made otherwise-correct scenes fail on trace length alone.
    const runForFrames = (n: number) => {
      TtmThread.traceFrameNo = 0;
      TtmThread.traceMaxFrame = n;
      TtmThread.traceReachedBudget = false;
      // Re-run from the entry tag with the sink armed, so the ADS RANDOM picks
      // and TIMER draws use the seeded RNG. The initial start() at page load ran
      // before the sink was set (using Math.random) — that made the first trace
      // differ from later ones. (TTM single-scene mode has no ADS RNG to reseed.)
      if (scheduler) scheduler.restart();
      let guard = 1_000_000;
      let framesAtPassStart = 0; // frames emitted before the current adsPlay pass
      while (!TtmThread.traceReachedBudget && guard-- > 0) {
        if (thread) {
          thread.tick();
          if (thread.isDone) break;
          continue;
        }
        if (!scheduler) break;
        scheduler.tick();
        // The script ran dry before the budget was met: re-enter the entry tag,
        // exactly as runTestMode / -traceserver loop `adsPlay` (some tags end
        // their chunk after a frame or two but are simply played again). Bail if
        // a whole pass emits no frames, so a genuinely empty tag can't spin —
        // the same guard the Go trace server uses (`if buf.Len() == before`).
        if (scheduler.isDrained) {
          if (TtmThread.traceFrameNo === framesAtPassStart) break;
          framesAtPassStart = TtmThread.traceFrameNo;
          scheduler.restart();
        }
      }
      TtmThread.traceMaxFrame = 0;
    };

    (window as unknown as { __trace: (n: number) => string }).__trace = (n: number) => {
      const lines: string[] = [];
      setTraceSink((l) => lines.push(l)); // arms the deterministic RNG too
      runForFrames(n);
      setTraceSink(null);
      return lines.join("\n");
    };

    // __shots(n): the PIXEL oracle. Runs n frames and returns each COMPOSITED
    // frame as a PNG data URL — the thread layers only, without the background,
    // so it is directly comparable to the Go engine's `-traceserver` shot mode
    // (which skips the island backdrop and clouds for the same reason: they are
    // engine-side procedural animation this port deliberately doesn't render).
    //
    // This exists because the draw-call trace CANNOT see compositor bugs. Layer
    // z-order, layer lifetime, and WHEN a frame is presented are all invisible
    // to it — every rendering bug found so far (Johnny vanishing in
    // ACTIVITY:12, his last walk frame dropped in BUILDING:1) passed the trace
    // diff untouched while looking obviously wrong on screen.
    (window as unknown as { __shots: (n: number) => string[] }).__shots = (n: number) => {
      const shots: string[] = [];
      setTraceSink(() => {}); // arms the deterministic RNG; trace text discarded
      const prev = scheduler ? scheduler.onPresent : null;
      if (scheduler) {
        scheduler.onPresent = () => {
          renderer.presentLayersOnly();
          shots.push(canvas.toDataURL("image/png"));
        };
      }
      try {
        runForFrames(n);
      } finally {
        if (scheduler) scheduler.onPresent = prev;
        setTraceSink(null);
        renderer.present(); // restore the normal composite on screen
      }
      return shots;
    };

    // __schedlog(n): same run as __trace, but returns the SCHEDULER DECISION
    // sequence (add/stop/reap/random-pick/conditional branch) in the Go engine's
    // JC_SCHED_LOG format, so the two decision sequences diff line-for-line.
    (window as unknown as { __schedlog: (n: number) => string }).__schedlog = (n: number) => {
      const lines: string[] = [];
      setTraceSink(() => {}); // arms the deterministic RNG (trace text discarded)
      setSchedSink((l) => lines.push(l));
      runForFrames(n);
      setSchedSink(null);
      setTraceSink(null);
      return lines.join("\n");
    };
    return; // no rAF loop in dump mode
  }

  // Audio is armed only outside dump mode: the oracle harnesses run headless
  // and must stay silent and side-effect-free.
  setSoundSink(soundPlayer);
  soundPlayer.init();
  soundToggle.addEventListener("change", () => soundPlayer.setEnabled(soundToggle.checked));

  // Shared render loop.
  let acc = 0;
  let last = performance.now();
  // Composite at the scheduler's grUpdateDisplay point (inside tick, before the
  // reap frees a finished scene's layer) rather than after the tick returns —
  // otherwise a scene's final frame is lost (BUILDING.ADS tag 1). This also
  // means each tick in the catch-up loop below presents its own frame instead
  // of only the last one surviving.
  const attachPresent = () => {
    if (scheduler && !scheduler.onPresent) {
      scheduler.onPresent = () => {
        renderer.present();
        frames++;
      };
    }
  };
  let framesAtPassStart = -1; // frames emitted before the current adsPlay pass
  function loop(now: number) {
    acc += now - last;
    last = now;
    attachPresent();
    let changed = false;
    let budget = 10;
    while (acc >= TICK_MS && budget-- > 0) {
      // Engine time consumed by this iteration, charged to the island's wave
      // and cloud metronomes so they keep running through scenes, walks and
      // long holds alike (they are separate threads in the engine).
      let tickCost = 1;
      if (thread) {
        acc -= TICK_MS;
        if (thread.tick()) changed = true;
      } else if (story?.walk) {
        // A walk transition owns playback: no scheduler, no ADS threads, just
        // the walk state machine holding each frame for its own delay. Charge
        // the held time the same way a scheduler tick charges `mini`.
        const cost = stepWalk();
        if (cost === null) {
          finishWalk();
          break;
        }
        tickCost = Math.max(1, cost);
        acc -= TICK_MS * tickCost;
        animateIsland(tickCost);
        // The walk redraws its own layer each frame; present after the island
        // has updated so the shore and clouds move during the walk too.
        renderer.present();
      } else if (scheduler) {
        scheduler.tick(); // presents via onPresent
        // One scheduler tick advances the engine clock by `mini` time-units
        // (ads.go then sleeps mini * 20ms), NOT by one. Charge the real cost or
        // playback runs `mini`× too fast — with clouds running, mini is usually
        // 8, i.e. ~8× speed. The trace harness is unaffected: it steps by frame.
        tickCost = scheduler.lastTickCost;
        acc -= TICK_MS * tickCost;
        // The island's own threads run alongside the scene's. ads.go calls
        // grUpdateDisplay EVERY iteration, not only when a thread drew, so the
        // shore and clouds keep moving through the long PURGE-loop holds that
        // dominate idle scenes. onPresent only fires when a scene thread draws,
        // so an island-only change has to composite itself — otherwise the
        // waves update invisibly on the background layer and the shore appears
        // frozen for the whole hold (STAND's idle poses, which draw once and
        // then sit for tens of seconds).
        //
        // Only when the tick did NOT already composite and did NOT reap. A reap
        // frees the finished thread's layer AFTER onPresent has shown that
        // scene's last frame, so presenting again here re-composites the same
        // moment with the layer gone — a blank or half-empty frame, i.e. Johnny
        // vanishing for one frame at a scene change. Measured: presents with 0
        // layers, and 2→1 layer drops, exactly on transitions.
        const islandChanged = animateIsland(tickCost);
        if (islandChanged && !scheduler.lastTickPresented && !scheduler.lastTickReaped) {
          renderer.present();
        }
        // The script ran dry: re-enter the entry tag, exactly as the engine's
        // `for !shouldExitApp { adsPlay(...) }` does (main.go) — adsPlay returns
        // as soon as no thread is left running, and some tags legitimately run
        // dry (VISITOR:4, STAND:14). Without this the scheduler ticks a dead
        // thread list forever: tick() returns at once, nothing ever presents
        // again, and it reads as a hang. It never reported "(stopped)" either,
        // because a tag that drains without an END leaves `stopped` false.
        //
        // Guard against a tag that emits NOTHING per pass, which would restart
        // every iteration and spin — the same check the trace path uses.
        if (scheduler.isDrained) {
          // Story mode: a drained script means this story beat is over, so move
          // to the next scene rather than replaying this one. `isStopped` is not
          // required here — a beat that ends via END is just as finished as one
          // that runs dry, and both should advance.
          if (story) {
            if (frames === 0) break; // nothing played yet: let it start before advancing
            // Remember where this beat left Johnny so the next walk starts
            // there. Scenes with no end spot (spotEnd/hdgEnd 0 on a FINAL
            // scene) leave it alone — storyPlay only tracks prevSpot for the
            // non-final scenes it chains.
            const done = story.current;
            if (done && (done.flags & SceneFlag.FINAL) === 0) {
              story.prevSpot = done.spotEnd;
              story.prevHdg = done.hdgEnd;
            } else {
              story.prevSpot = null; // a FINAL scene ends the episode: no carry-over
            }
            advanceStory();
            break;
          }
          if (scheduler.isStopped) break;
          if (frames === framesAtPassStart) break;
          framesAtPassStart = frames;
          scheduler.restart();
        }
      } else {
        acc = 0;
      }
    }
    if (changed) {
      renderer.present(); // single-TTM mode: no scheduler to present for us
      frames++;
    }
    // Repaint the HUD every tick, not only when a frame presented. Gating it on
    // `changed || presented` left the text frozen at whatever the last displayed
    // frame said — so a drained script kept advertising the scene count it had
    // when it stopped drawing, which is exactly the state worth seeing.
    if (thread) {
      hud.textContent = `${ttmSelect.value} — tag ${tagSelect.value} — frame ${frames}${thread.isDone ? " (done)" : ""}`;
    } else if (story) {
      const s = story.current;
      const day = story.driver.currentDay;
      const left = story.queue.length;
      const what = story.walk ? `walking → ${s?.adsName ?? "?"}` : s ? `${s.adsName} tag ${s.adsTag}` : "starting…";
      hud.textContent = `screensaver — day ${day} — ${what} — ${left} scene(s) left — frame ${frames}`;
    } else if (scheduler) {
      hud.textContent = `${adsSelect.value} — ${scheduler.runningCount} scene(s) — frame ${frames}${scheduler.isStopped ? " (stopped)" : ""}`;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  hud.textContent = `error: ${err.message ?? err}`;
});
