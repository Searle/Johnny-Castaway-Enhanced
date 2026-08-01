// Headless sanity checks for the story driver (src/story/*).
//
// Neither oracle covers scene SELECTION — both drive a single ADS tag directly.
// This is the only automated check that the episode structure and flag
// bookkeeping behave, so it runs without a browser: `npx tsx tools/story-check.ts`.

import { Story, Holiday, STORY_DAYS } from "../src/story/story";
import { STORY_SCENES, SceneFlag as F } from "../src/story/data";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ok   ${name}`);
  }
}

// A deterministic PRNG so failures are reproducible. This is mulberry32, not a
// plain LCG: an LCG's FIRST draw is strongly correlated across nearby seeds
// (1664525/1013904223 yielded only 4 distinct values of 20 over 400 seeds),
// which silently collapses the sweeps below to a handful of cases.
function lcg(seed: number): () => number {
  let s = (seed + 0x6d2b79f5) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// dayOfYear must match `now`'s actual day-of-year, otherwise updateCurrentDay()
// sees a date change and advances the arc — silently testing day+1.
function dayOfYearOf(d: Date): number {
  const start = Date.UTC(d.getFullYear(), 0, 0);
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((now - start) / 86_400_000);
}

const mkStory = (seed: number, now = new Date(2026, 6, 15, 12, 0, 0), day = 1) =>
  new Story({
    random: lcg(seed),
    now: () => now,
    loadProgress: () => ({ day, dayOfYear: dayOfYearOf(now) }), // same date -> no advance
  });

console.log("story data:");
check("63 scenes", STORY_SCENES.length === 63, `got ${STORY_SCENES.length}`);
check(
  "every scene has a FINAL or non-FINAL role",
  STORY_SCENES.every((s) => typeof s.flags === "number"),
);
const finals = STORY_SCENES.filter((s) => s.flags & F.FINAL);
check("has FINAL scenes", finals.length > 0, `${finals.length}`);

console.log("\nepisode structure:");
{
  const st = mkStory(1);
  const ep = st.buildEpisode();
  check("episode is non-empty", ep.length > 0);
  check("last scene is FINAL", (ep[ep.length - 1].flags & F.FINAL) !== 0);
  check(
    "only the last scene is FINAL",
    ep.slice(0, -1).every((s) => (s.flags & F.FINAL) === 0),
  );
  const firsts = ep.slice(0, -1).filter((s) => s.flags & F.FIRST);
  check("at most one FIRST scene, and it leads", firsts.length <= 1 && (firsts.length === 0 || (ep[0].flags & F.FIRST) !== 0), `${firsts.length}`);
}

console.log("\nepisode length (6..19 leading scenes, or 1 if FINAL|FIRST):");
{
  let sawLong = false;
  let sawShort = false;
  for (let seed = 1; seed <= 400; seed++) {
    // Vary the story day too: most FINAL|FIRST scenes are day-gated, so a
    // day-1-only sweep almost never produces a single-scene episode.
    const ep = mkStory(seed, new Date(2026, 6, 15, 12, 0, 0), (seed % STORY_DAYS) + 1).buildEpisode();
    const finalIsFirst = (ep[ep.length - 1].flags & F.FIRST) !== 0;
    if (finalIsFirst) {
      sawShort = true;
      if (ep.length !== 1) check(`seed ${seed} FINAL|FIRST episode is a single scene`, false, `len ${ep.length}`);
    } else {
      sawLong = true;
      if (ep.length < 7 || ep.length > 20) {
        check(`seed ${seed} length in range`, false, `len ${ep.length}`);
      }
    }
  }
  check("saw a multi-scene episode", sawLong);
  check("saw a single-scene (FINAL|FIRST) episode", sawShort);
}

console.log("\nflag constraints hold across many episodes:");
{
  let violations = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const st = mkStory(seed);
    const ep = st.buildEpisode();
    const fin = ep[ep.length - 1];
    const lead = ep.slice(0, -1);
    // LEFT_ISLAND: if the final scene isn't on the left half, no lead scene may be.
    if ((fin.flags & F.LEFT_ISLAND) === 0 && lead.some((s) => s.flags & F.LEFT_ISLAND)) violations++;
    // If the episode runs at low tide, every lead scene must tolerate it.
    if (st.island.lowTide && lead.some((s) => (s.flags & F.LOWTIDE_OK) === 0)) violations++;
    // If the island is displaced, every lead scene must tolerate VARPOS.
    if ((st.island.xPos !== 0 || st.island.yPos !== 0) && lead.some((s) => (s.flags & F.VARPOS_OK) === 0)) violations++;
  }
  check("no flag violations over 400 episodes", violations === 0, `${violations}`);
}

console.log("\nday gating:");
{
  let violations = 0;
  for (let day = 1; day <= STORY_DAYS; day++) {
    for (let seed = 1; seed <= 40; seed++) {
      const st = mkStory(seed, new Date(2026, 6, 15, 12, 0, 0), day);
      for (const s of st.buildEpisode()) {
        if (s.dayNo !== 0 && s.dayNo !== day) violations++;
      }
    }
  }
  check("scenes only appear on their own story day", violations === 0, `${violations}`);
}

console.log("\nraft progression:");
{
  // Drive calculateIslandFromScene directly against a raft-bearing scene, so
  // the day->stage rule is asserted exactly rather than through a NORAFT escape.
  const raftScene = STORY_SCENES.find((s) => (s.flags & F.NORAFT) === 0 && (s.flags & F.VARPOS_OK) === 0)!;
  const expect: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 11: 5 };
  for (const [day, want] of Object.entries(expect)) {
    const st = mkStory(7, new Date(2026, 6, 15, 12, 0, 0), Number(day));
    st.updateCurrentDay();
    st.calculateIslandFromScene(raftScene);
    check(`day ${day} raft`, st.island.raft === want, `got ${st.island.raft}, want ${want}`);
  }
}

console.log("\nnight + holiday from the clock:");
{
  const at = (m: number, d: number, h: number) => {
    const st = new Story({ random: lcg(3), now: () => new Date(2026, m - 1, d, h), loadProgress: () => ({ day: 1, dayOfYear: 999 }) });
    st.calculateIslandFromDateAndTime();
    return st.island;
  };
  check("noon is day", !at(7, 15, 12).night);
  check("22:00 is night", at(7, 15, 22).night);
  check("05:00 is night", at(7, 15, 5).night);
  check("Halloween", at(10, 30, 12).holiday === Holiday.Halloween);
  check("St Patrick", at(3, 16, 12).holiday === Holiday.StPatrick);
  check("Christmas", at(12, 24, 12).holiday === Holiday.Christmas);
  check("New Year (Dec)", at(12, 30, 12).holiday === Holiday.NewYear);
  check("New Year (Jan 1)", at(1, 1, 12).holiday === Holiday.NewYear);
  check("ordinary day", at(7, 15, 12).holiday === Holiday.None);
}

console.log("\nday advance persists:");
{
  let saved: { day: number; dayOfYear: number } | null = null;
  const st = new Story({
    random: lcg(5),
    now: () => new Date(2026, 6, 15, 12),
    loadProgress: () => ({ day: 4, dayOfYear: 100 }), // stale date -> should advance
    saveProgress: (p) => (saved = p),
  });
  st.updateCurrentDay();
  check("advances on a new date", st.currentDay === 5, `day ${st.currentDay}`);
  check("persists the new day", saved !== null && saved!.day === 5);

  const st2 = new Story({
    random: lcg(5),
    now: () => new Date(2026, 6, 15, 12),
    loadProgress: () => ({ day: STORY_DAYS, dayOfYear: 100 }),
  });
  st2.updateCurrentDay();
  check("wraps past the end of the arc", st2.currentDay === 1, `day ${st2.currentDay}`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
