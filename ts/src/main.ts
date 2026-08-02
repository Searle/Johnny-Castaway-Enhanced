import { loadIndex, loadAnimation, type AnimIndex, type IndexEntry, type AdsIndexEntry } from "./manifest";
import { Canvas2DRenderer } from "./render/canvas2d";
import { TtmThread, setTraceSink, setSoundSink, rngSeeds } from "./ttm/interpreter";
import { SoundPlayer } from "./sound";
import {
  AdsScheduler,
  loadAds,
  setSchedSink,
  setDigestSink,
  setDigestIsland,
  type DigestIslandState,
} from "./ads/scheduler";
import { positionForScene, sceneHasIsland } from "./ads/positioning";
import { Story, STORY_DAYS } from "./story/story";
import { Island, ISLAND_DIR, type IslandAssets } from "./story/island";
import { Walk } from "./story/walk";
import { SceneFlag, STORY_SCENES, type StoryScene } from "./story/data";

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
// Handles for tools/oracle-diff/cloudorder.py, the only check that can see
// compositor SLOT ORDER (the frame digest reports scene threads; clouds are a
// fixed slot and never appear there). Exposed unconditionally rather than under
// ?dump because the probe drives real story-mode playback, which dump mode
// disables.
(window as unknown as { __renderer: unknown }).__renderer = renderer;
(window as unknown as { __island: unknown }).__island = () => story?.island ?? null;

// Exactly one of these drives playback at a time.
let thread: TtmThread | null = null;
let scheduler: AdsScheduler | null = null;
let frames = 0;
let loadToken = 0;

// Screensaver mode: non-null while the story driver owns playback.
//
// Sequencing does NOT live here — it lives in storyPlay's statement order, the
// way story.go expresses it. What remains is the state the engine itself keeps:
// the story driver, the current beat (for the HUD), the episode's island, and
// the two island metronomes.
let story: {
  driver: Story;
  // The beat now playing. Read by the HUD; the coroutine owns the sequence.
  current: StoryScene | null;
  // The island for the CURRENT episode. Rebuilt per episode
  // (adsReleaseIsland → adsInitIsland); the island/clouds/holiday SURFACES are
  // fixed compositor slots (Step 1), not stored here.
  island: Island | null;
  // Wave/cloud metronomes. Both run on an 8-tick delay in the engine, and they
  // are what quantizes the scheduler — see the metronome note in the scheduler.
  waveTimer: number;
  cloudTimer: number;
} | null = null;
// Engine time consumed by the walk frame just drawn, so the pump can charge the
// island metronomes the same way a scheduler tick charges `mini`.
let walkCost = 1;
// The scene a walk is heading to, for the HUD only. Non-null exactly while
// playWalk is running.
let walkTarget: StoryScene | null = null;
// The running driver. One coroutine, parked at exactly one statement.
let storyCo: AsyncGenerator<StoryStep, void, void> | null = null;
// Set while a `yield "load"` is being awaited, so the pump does not re-enter.
let storyPumping = false;
// Module-level copy of the ADS index so story mode can resolve scene names
// outside main()'s scope. Set once, at startup.
let adsIndex: AdsIndexEntry[] = [];

// stopPlayback tears playback down completely: every mode switch and every
// fresh load starts here. There is no `keepStory` variant any more — the story
// coroutine scopes its own teardown between beats (playScene/playWalk drop the
// scene layers themselves), so nothing needs to ask this function to spare it.
function stopPlayback() {
  thread = null;
  scheduler = null;
  story = null;
  storyCo = null;
  walkTarget = null;
  // Drops the SCENE layers only. The island, clouds and holiday are fixed
  // compositor slots (Step 1); they are released explicitly below.
  renderer.resetLayers();
  // Saved zones are PER-SCENE. Within a scene only LOAD_SCREEN / RESTORE_ZONE
  // release them (the interpreter does that), but a new scene starts with none:
  // in the engine islandInit's grLoadScreen calls grReleaseSavedLayer, and the
  // -traceserver reaches every scene through it. Without this the slot survived
  // a window.__load switch, so a scene swept after one that baked scenery began
  // with zones=1 where a cold reload gives zones=0 — the frame digest reported
  // it on line 1. Found by diffing a warm against a cold run of the SAME scene:
  // the schedlogs were byte-identical (889 = 889 lines), so it was never
  // scheduler state, which is why a state fingerprint could not see it.
  renderer.clearSlot("savedZones");
  releaseIsland();
  // Leaving story mode hands the backdrop back to the TTM interpreter.
  TtmThread.keepBackground = false;
  // Clear the frame-budget statics too — this is the harness's per-scene reset,
  // the equivalent of the Go server's traceResetForScene(). They were only ever
  // cleared at the START of runForFrames, so a scene loaded via window.__load
  // ran its constructor (fast-forward, LOAD_SCREEN) and its start() with
  // `traceReachedBudget` still true from the PREVIOUS scene — and
  // scheduler.tick() bails early on that flag. Found with
  // tools/oracle-diff/leakcheck.py, which fingerprints every carry-over
  // candidate at scene start and diffs a warm sweep against a cold one:
  // traceFrameNo=60/traceReachedBudget=true warm vs 0/false cold.
  TtmThread.traceFrameNo = 0;
  TtmThread.traceMaxFrame = 0;
  TtmThread.traceReachedBudget = false;
  // Cleared here (start of every load) so the harness never observes a stale
  // ready flag from a previous scene while the new one is still loading.
  (window as unknown as { __ready?: boolean }).__ready = false;
}

// releaseIsland is adsReleaseIsland: the end of an episode takes the island,
// clouds and holiday down. Within an episode they outlive every scene and walk.
function releaseIsland() {
  renderer.setBackground(null);
  renderer.clearSlot("island");
  renderer.clearSlot("clouds");
  renderer.clearSlot("holiday");
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

  renderer.clearSlot("island");
  renderer.clearSlot("clouds");
  renderer.setBackground(island.backdropFor(st));
  island.build(st, renderer.slot("island"));
  island.initClouds();

  story.island = island;
  // From here on the island owns the backdrop; scene LOAD_SCREENs must not
  // paint the baked ISLETEMP stand-in over it.
  TtmThread.keepBackground = true;
  // Holiday decorations go in the holiday slot: the engine runs them as their
  // own thread composited after every scene thread, so the Christmas tree is
  // never hidden behind Johnny.
  renderer.clearSlot("holiday");
  island.drawHoliday(st, renderer.slot("holiday"));
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
    story.island.animateWaves(st, renderer.slot("island"));
    changed = true;
  }

  story.cloudTimer -= cost;
  if (story.cloudTimer <= 0) {
    story.cloudTimer = ISLAND_TICK;
    story.island.animateClouds(renderer.slot("clouds"));
    changed = true;
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

// storyPlay is the screensaver driver, expressed the way story.go expresses it:
// a LOOP whose sequencing is statement order. Compare story.go:134-272 — build
// an episode, walk to each scene, play it, carry the spot forward, release the
// island at the end, repeat.
//
// It is an async GENERATOR rather than a plain async function, and that is the
// load-bearing detail. A plain `await` would tie playback to promise
// scheduling, and the frame-dump harness (?dump) drives the engine
// SYNCHRONOUSLY, one displayed frame at a time. Yielding instead lets one
// pump() call advance the coroutine by exactly one engine step, so the same
// code serves both the rAF loop and the harness.
//
// What each yield means:
//   yield "load"  — an asset load is in flight; the pump awaits it and resumes.
//   yield "tick"  — one engine step is due (a scene tick or a walk frame). The
//                   pump charges the engine clock and returns.
//
// The flags this deletes are the point: `advancing` (no re-entrancy — the
// coroutine is parked at one statement), `keepStory` (teardown is scoped to
// playScene's lifetime), `walk` as a mode selector (a walk is just what the
// coroutine is currently doing), and the isDrained branch in the render loop
// (it becomes playScene's exit condition).
type StoryStep = "load" | "tick";

async function* storyPlay(): AsyncGenerator<StoryStep, void, void> {
  for (;;) {
    // A fresh episode re-rolls the island (tide, position, raft, holiday), so
    // it is rebuilt here — adsInitIsland at the top, adsReleaseIsland at the
    // bottom, exactly bracketing storyPlay's outer loop body.
    const episode = story!.driver.buildEpisode();
    applyIslandOverrides();
    const islandLoad = buildIsland();
    yield "load";
    await islandLoad;
    if (!story) return;

    // story.go:168 — reset ONCE per episode, never per scene. The island may
    // have moved, so there is no continuity with wherever the last episode
    // left Johnny standing.
    let prevSpot: number | null = null;
    let prevHdg = 0;

    for (const scene of episode) {
      if (!story) return;

      // story.go:207 — ttmDx is set to the DESTINATION scene's offset BEFORE
      // the walk to it, so a walk crossing between the island's LEFT_ISLAND and
      // non-LEFT_ISLAND halves renders at the right half's X.
      if (prevSpot !== null) {
        yield* playWalk(prevSpot, prevHdg, scene);
        if (!story) return;
      }
      // Set AFTER the walk: `current` is what the HUD names, and naming the
      // destination while still walking to it made the HUD read
      // "tag 7 -> walking -> tag 7", which looks like a scene change with no
      // walk. playWalk takes its destination as an argument, so it never needed
      // this to be set early.
      story.current = scene;

      // The story-beat sting that marks a day-specific event.
      if (scene.dayNo !== 0) soundPlayer.play(17);

      yield* playScene(scene);
      if (!story) return;

      // story.go:227 — UNCONDITIONAL, including after the FINAL scene. Clearing
      // it on FINAL (an easy-looking "the episode is over" optimisation)
      // silently deletes the walk into the next episode's first scene, and
      // reads on screen as Johnny teleporting across the island.
      prevSpot = scene.spotEnd;
      prevHdg = scene.hdgEnd;
    }

    releaseIsland();
  }
}

// playWalk runs one walk transition to `to`, resolving when walkAnimate has no
// frame left. Mirrors adsPlayWalk: it blocks the caller for the walk's whole
// duration, which is why the coroutine can simply carry on afterwards.
async function* playWalk(
  from: number,
  fromHdg: number,
  to: StoryScene,
): AsyncGenerator<StoryStep, void, void> {
  const sheetLoad = ensureWalkSheet();
  yield "load";
  const sheet = await sheetLoad;
  if (!sheet || !story) return;
  // Same spot AND heading: nothing to walk, exactly as storyPlay skips
  // adsPlayWalk when there is no distance to cover.
  if (from === to.spotStart && fromHdg === to.hdgStart) return;

  // Drop the finished scene's layers; the island slots survive (Step 1).
  scheduler = null;
  renderer.resetLayers();
  const layer = renderer.newLayer();
  if (story.island) {
    const st = story.driver.island;
    const xOffset = (to.flags & SceneFlag.LEFT_ISLAND) !== 0 ? 272 : 0;
    layer.setOrigin(st.xPos + xOffset, st.yPos);
  }
  const w = new Walk(from, fromHdg, to.spotStart, to.hdgStart, Math.random);
  frames = 0;
  walkTarget = to;
  markReady();

  try {
    for (;;) {
      const f = w.step();
      if (!f) return; // walkAnimate returned delay 0 — the walk is over
      layer.clear();
      const img = sheet.frames[f.spriteNo];
      if (img) layer.drawSprite(img, f.x, f.y, f.flip);
      // Walking behind the palm: redraw trunk + leaves ON TOP of Johnny, as
      // walkAnimate does.
      if (f.behindTree && story?.island) story.island.drawPalmOver(layer);
      frames++;
      walkCost = Math.max(1, f.delay);
      yield "tick";
      if (!story) return;
    }
  } finally {
    // Cleared on EVERY exit — normal end, story teardown, or an abandoned
    // coroutine — so the HUD can never be left announcing a walk that is over.
    walkTarget = null;
  }
}

// playScene plays one story beat, resolving when its ADS script DRAINS. That
// drain is adsPlay returning — the engine's own `for numThreads != 0` exit —
// so the coroutine resumes at exactly the point storyPlay would.
async function* playScene(scene: StoryScene): AsyncGenerator<StoryStep, void, void> {
  const entry = (adsIndex ?? []).find((a) => a.name === scene.adsName);
  if (!entry) {
    hud.textContent = `story: missing ${scene.adsName}`;
    return;
  }
  // Load FIRST, and only tear the old scene down once the replacement is in
  // hand. Wiping the layers before the await left the stage empty for the whole
  // asset load, and the pump presents every iteration — so the end of every walk
  // showed two blank composites before the next scene drew. The engine has no
  // such gap: adsPlayWalk returns and adsPlay begins with nothing presented in
  // between. Measured at every walk->scene edge: [.., 529, 508, 0, 0, 529, ..].
  const load = loadAds(ANIM_ROOT, entry.dir);
  yield "load";
  const { ads, slots } = await load;
  if (!story) return;
  scheduler = null;
  renderer.resetLayers();

  const sched = new AdsScheduler(ads, slots, renderer, {
    // With a REAL island we honour the engine's positioning:
    // ttmDx = islandState.xPos + (LEFT_ISLAND ? 272 : 0).
    position: () => {
      if (!story?.island) return positionForScene(entry.name, 0, 0);
      const st = story.driver.island;
      const xOffset = (scene.flags & SceneFlag.LEFT_ISLAND) !== 0 ? 272 : 0;
      return { dx: st.xPos + xOffset, dy: st.yPos };
    },
    island: sceneHasIsland(entry.name, scene.adsTag),
    adsName: entry.name,
  });
  sched.onPresent = () => {
    renderer.present();
    frames++;
  };
  sched.start(scene.adsTag);
  scheduler = sched;
  frames = 0;
  // Deliberately NO present() here. start() calls resetLayers(), so compositing
  // at this point shows an empty stage — the scene has not run a frame yet. The
  // engine's adsPlay only ever calls grUpdateDisplay INSIDE its main loop,
  // after the threads have run, so it never displays that moment. Presenting
  // here put one blank composite at the start of every beat, which reads as
  // Johnny disappearing for a frame at the scene change.
  markReady();

  // Tick until the script drains. A beat that ends via END is just as finished
  // as one that runs dry, and both simply return here.
  while (scheduler === sched && !sched.isDrained) {
    yield "tick";
    if (!story) return;
  }
}

function markReady(): void {
  (window as unknown as { __ready?: boolean }).__ready = true;
}

function startStory(): void {
  stopPlayback(); // clears the island/clouds/holiday slots too
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
  story = { driver, current: null, island: null, waveTimer: 0, cloudTimer: 0 };
  storyCo = storyPlay();
  storyPumping = false;
}

// pumpStory advances the driver by ONE step and returns the engine time that
// step consumed, so the caller can charge the clock. This is the only thing the
// render loop has to know about the screensaver.
//
// A "load" yield parks the coroutine on a promise; nothing is charged and the
// pump re-enters when it resolves. A "tick" yield means one engine step is due:
// a scene tick (charged `mini`) or a walk frame (charged its own delay).
function pumpStory(): number {
  if (!storyCo || storyPumping) return 0;
  // A live scheduler means the coroutine is parked in playScene's tick loop.
  // Run the engine step HERE, then resume the coroutine so it can re-test
  // isDrained — ads.go's own `for numThreads != 0` exit condition.
  let cost = 1;
  if (scheduler) {
    scheduler.tick(); // presents via onPresent, at the grUpdateDisplay point
    cost = scheduler.lastTickCost;
  } else {
    cost = walkCost;
  }
  // The island's threads run alongside whatever is playing, so the shore and
  // clouds keep moving through walks and through the long PURGE-loop holds that
  // dominate idle scenes.
  const islandChanged = animateIsland(cost);
  // ads.go calls grUpdateDisplay EVERY iteration, not only when a thread drew.
  // The scheduler already presented if a scene drew; present here for the
  // island-only case and for walks (which own their own layer). Never after a
  // REAP: onPresent has already shown that scene's final frame, and
  // re-compositing the same iteration with the layer freed is the one-frame
  // blank that reads as Johnny vanishing at a scene change.
  if (!scheduler) {
    renderer.present();
  } else if (islandChanged && !scheduler.lastTickPresented && !scheduler.lastTickReaped) {
    renderer.present();
  }

  storyPumping = true;
  void storyCo.next().then((r) => {
    storyPumping = false;
    if (r.done) storyCo = null;
  });
  return cost;
}

function dayOfYearNow(): number {
  const d = new Date();
  const start = Date.UTC(d.getFullYear(), 0, 0);
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((now - start) / 86_400_000);
}

// digestIslandForScene mirrors the Go engine's setupSceneForTrace (main.go),
// which is the path -framedigest takes: the digest oracle runs scenes through
// the ADS viewer, not story mode, so the island state it reports is derived the
// same way there.
//
// It runs the REAL storyCalculateIslandFromScene rather than a reimplementation,
// so the island RNG stream is consumed in exactly the same order and count as
// the Go engine's — which is the whole reason those fields can be compared at
// all. A hand-rolled copy would drift the moment either branch changed.
//
// night / holiday stay zero: storyCalculateIslandFromDateAndTime is called ONLY
// from storyPlay (story.go:152), never from setupSceneForTrace, so islandState
// keeps the zeros adsInit left. Verified across every sampled scene.
function digestIslandForScene(adsName: string, tag: number): DigestIslandState {
  const name = adsName.toUpperCase();
  const scene = STORY_SCENES.find((s) => s.adsName.toUpperCase() === name && s.adsTag === tag);
  if (!scene) return { raft: 0, night: false, holiday: 0, lowTide: false, xPos: 0, yPos: 0 };
  // setupSceneForTrace: a dated scene pins storyCurrentDay, otherwise it is
  // activeConfig.CurrentDay (1 for the freshly-built binary the harness runs).
  const driver = new Story({ now: () => new Date(), loadProgress: () => null });
  driver.currentDay = scene.dayNo !== 0 ? scene.dayNo : 1;
  driver.calculateIslandFromScene(scene);
  const st = driver.island;
  return {
    raft: st.raft,
    night: false,
    holiday: 0,
    lowTide: st.lowTide,
    xPos: st.xPos,
    yPos: st.yPos,
  };
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
    if (!story || !scheduler) return;
    // Skipping is now just "end this beat": the coroutine is parked in
    // playScene's `while (!isDrained)` loop, so stopping every thread makes it
    // fall through and carry on with the walk to the next scene. prevSpot
    // carries over by itself — it is a local in storyPlay, advanced after
    // playScene returns, exactly as story.go:227 does it. (The old flag-based
    // driver needed three statements here and got the carry-over wrong.)
    scheduler.stopAll();
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
    // Interpreter statics + RNG seeds, for tools/oracle-diff/leakcheck.py:
    // everything that survives a scene switch but not a page reload.
    (window as unknown as { __ttmStatics: () => unknown }).__ttmStatics = () => ({
      keepBackground: TtmThread.keepBackground,
      traceFrameNo: TtmThread.traceFrameNo,
      traceMaxFrame: TtmThread.traceMaxFrame,
      traceReachedBudget: TtmThread.traceReachedBudget,
      rng: rngSeeds(),
    });

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
      //
      // start(), NOT restart(): this is the harness's FRESH-SCENE point, the
      // equivalent of the Go server's adsInit() + setupSceneForTrace() before
      // its `for !traceReachedBudget { adsPlay(...) }` loop, so the island
      // metronomes are re-initialised here. restart() deliberately does not do
      // that (it is adsPlay re-entry within one scene), and using it here let
      // metronome phase leak from one swept scene into the next via the
      // in-page __load path — 18 scenes passed on COLD_RELOAD=1 and failed in
      // the normal sweep, which is exactly the "__load must stay equivalent to
      // a cold reload" invariant in INSIGHTS.md.
      if (scheduler) scheduler.start(scheduler.currentEntryTag);
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

    // __digest(n): the FRAME-DIGEST oracle. Same frame-counted run as __trace,
    // but returns one line per DISPLAYED COMPOSITE describing the composite
    // STRUCTURE (which layers, in what order, plus island/cloud/zone/holiday
    // state) instead of draw calls. This is what covers the compositor blind
    // spot: z-order, layer lifetime and presentation timing, none of which the
    // draw-call oracle can see. Driven by runForFrames, never the rAF loop, so
    // it steps by frame and is unaffected by wall-clock pacing.
    (window as unknown as { __digest: (n: number) => string }).__digest = (n: number) => {
      const lines: string[] = [];
      setTraceSink(() => {}); // arms the deterministic RNG (trace text discarded)
      setDigestSink((l) => lines.push(l));
      setDigestIsland(digestIslandForScene(adsSelect.value, Number(adsTagSelect.value)));
      runForFrames(n);
      setDigestSink(null);
      setTraceSink(null);
      return lines.join("\n");
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

  // Shared render loop. Its only job now is: pump whatever is playing, advance
  // the clock by what that step cost, and repaint the HUD. Sequencing lives in
  // storyPlay (screensaver) or in the scheduler (ADS viewer) — not here.
  let acc = 0;
  let last = performance.now();
  // The ADS viewer composites at the scheduler's grUpdateDisplay point (inside
  // tick, BEFORE the reap frees a finished scene's layer); presenting after
  // tick() returns loses each scene's final frame. Story mode attaches its own
  // in playScene.
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
      if (thread) {
        acc -= TICK_MS;
        if (thread.tick()) changed = true;
      } else if (storyCo) {
        // One engine step of the screensaver, charged at its real cost: a
        // scheduler tick advances the clock by `mini` time-units (ads.go then
        // sleeps mini * 20ms), a walk frame by its own delay. Charging 1 here
        // instead runs playback `mini` times too fast — with clouds running
        // mini is usually 8, i.e. ~8x speed — and no text oracle can see it.
        const cost = pumpStory();
        if (cost === 0) break; // a load is in flight; resume when it lands
        acc -= TICK_MS * cost;
      } else if (scheduler) {
        scheduler.tick(); // presents via onPresent
        acc -= TICK_MS * scheduler.lastTickCost;
        // The script ran dry: re-enter the entry tag, exactly as the engine's
        // `for !shouldExitApp { adsPlay(...) }` does (main.go). Some tags
        // legitimately run dry (VISITOR:4, STAND:14); without this the
        // scheduler ticks a dead thread list forever and it reads as a hang.
        // Guard against a tag that emits NOTHING per pass, which would restart
        // every iteration and spin — the same check the trace path uses.
        if (scheduler.isDrained) {
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
      const what = walkTarget
        ? `walking → ${walkTarget.adsName}`
        : s
          ? `${s.adsName} tag ${s.adsTag}`
          : "starting…";
      hud.textContent = `screensaver — day ${day} — ${what} — frame ${frames}`;
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
