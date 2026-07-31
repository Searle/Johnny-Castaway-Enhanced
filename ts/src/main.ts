import { loadIndex, loadAnimation, type AnimIndex, type IndexEntry, type AdsIndexEntry } from "./manifest";
import { Canvas2DRenderer } from "./render/canvas2d";
import { TtmThread, setTraceSink } from "./ttm/interpreter";
import { AdsScheduler, loadAds, setSchedSink } from "./ads/scheduler";
import { positionForScene, sceneHasIsland } from "./ads/positioning";

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

  // Frame-dump mode (?dump): expose a stepper that advances the scheduler until
  // the next DISPLAYED frame and returns the canvas + scene state, so a harness
  // can save every frame regardless of its delay. Bypasses the rAF loop.
  if (params.has("dump")) {
    // Expose the live scheduler for harness/debug introspection.
    Object.defineProperty(window, "__sched", { get: () => scheduler });
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

  // Shared render loop.
  let acc = 0;
  let last = performance.now();
  let presented = false;
  // Composite at the scheduler's grUpdateDisplay point (inside tick, before the
  // reap frees a finished scene's layer) rather than after the tick returns —
  // otherwise a scene's final frame is lost (BUILDING.ADS tag 1). This also
  // means each tick in the catch-up loop below presents its own frame instead
  // of only the last one surviving.
  const attachPresent = () => {
    if (scheduler && !scheduler.onPresent) {
      scheduler.onPresent = () => {
        renderer.present();
        presented = true;
        frames++;
      };
    }
  };
  function loop(now: number) {
    acc += now - last;
    last = now;
    attachPresent();
    presented = false;
    let changed = false;
    let budget = 10;
    while (acc >= TICK_MS && budget-- > 0) {
      if (thread) {
        acc -= TICK_MS;
        if (thread.tick()) changed = true;
      } else if (scheduler) {
        scheduler.tick(); // presents via onPresent
        // One scheduler tick advances the engine clock by `mini` time-units
        // (ads.go then sleeps mini * 20ms), NOT by one. Charge the real cost or
        // playback runs `mini`× too fast — with clouds running, mini is usually
        // 8, i.e. ~8× speed. The trace harness is unaffected: it steps by frame.
        acc -= TICK_MS * scheduler.lastTickCost;
      } else {
        acc = 0;
      }
    }
    if (changed || presented) {
      if (changed) {
        renderer.present(); // single-TTM mode: no scheduler to present for us
        frames++;
      }
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
