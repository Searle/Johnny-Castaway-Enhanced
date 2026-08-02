// The screensaver's story driver — a port of story.go's storyPlay() loop.
//
// The scene viewer plays ONE ads entry tag. The screensaver instead assembles
// an EPISODE: pick a FINAL scene, play 6..19 ordinary scenes leading up to it,
// then play the final one and fade out. That structure — not any individual
// animation — is what makes it read as a story rather than a demo reel.
//
// This module is deliberately pure: it decides WHAT to play next and owns the
// story-day/island state, but performs no rendering and touches no DOM. The
// caller drives it. That keeps it testable headlessly (tools/story-check.ts),
// which matters because none of the oracles cover this layer — both of them
// drive a single ADS tag directly and never exercise scene selection.
//
// NOT yet ported (see the screensaver notes in INSIGHTS.md): walk transitions
// between scenes (walk.go/calcpath.go), the procedurally drawn island
// (island.go) and therefore real VARPOS positioning, the intro, and fades.

import { STORY_SCENES, SceneFlag as F, type StoryScene } from "./data";
import { randIsland, traceSink } from "../ttm/interpreter";

export interface IslandState {
  night: boolean;
  holiday: Holiday;
  lowTide: boolean;
  raft: number; // 0 = none, else build stage 1..5
  xPos: number;
  yPos: number;
}

export const enum Holiday {
  None = 0,
  Halloween = 1,
  StPatrick = 2,
  Christmas = 3,
  NewYear = 4,
}

// The story arc is 11 days long and advances by one whenever the real-world
// date changes between runs (storyUpdateCurrentDay). Day gates which dayNo
// scenes are eligible and how much of the raft has been built.
export const STORY_DAYS = 11;

export interface StoryDeps {
  /** [0,1) — injectable so tests are deterministic. Defaults to Math.random. */
  random?: () => number;
  /** Current wall-clock time; injectable for testing holidays/night. */
  now?: () => Date;
  /** Persisted story day + the date it was last advanced on. */
  loadProgress?: () => { day: number; dayOfYear: number } | null;
  saveProgress?: (p: { day: number; dayOfYear: number }) => void;
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getFullYear(), 0, 0);
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((now - start) / 86_400_000);
}

export class Story {
  private rnd: () => number;
  private now: () => Date;
  private save: (p: { day: number; dayOfYear: number }) => void;

  currentDay = 1;
  island: IslandState = {
    night: false,
    holiday: Holiday.None,
    lowTide: false,
    raft: 0,
    xPos: 0,
    yPos: 0,
  };

  constructor(deps: StoryDeps = {}) {
    this.rnd = deps.random ?? Math.random;
    this.now = deps.now ?? (() => new Date());
    this.save = deps.saveProgress ?? (() => {});
    const saved = deps.loadProgress?.() ?? null;
    this.currentDay = saved?.day ?? 1;
    this.lastDayOfYear = saved?.dayOfYear ?? -1;
  }

  private lastDayOfYear: number;

  private randInt(n: number): number {
    return Math.floor(this.rnd() * n);
  }

  // islandRandInt draws from the seeded ISLAND stream under trace/digest (the
  // Go engine's islandRand), keeping island state comparable without letting it
  // shift scene selection, which keeps using `rnd` above.
  private islandRandInt(n: number): number {
    if (traceSink) return randIsland(n);
    return Math.floor(this.rnd() * n);
  }

  // storyUpdateCurrentDay: advance the arc if the calendar date changed since
  // the last run, wrapping back to day 1 past the end.
  updateCurrentDay(): void {
    const today = dayOfYear(this.now());
    let changed = false;
    if (today !== this.lastDayOfYear) {
      this.lastDayOfYear = today;
      this.currentDay += 1;
      changed = true;
    }
    if (this.currentDay < 1 || this.currentDay > STORY_DAYS) {
      this.currentDay = 1;
      changed = true;
    }
    if (changed) this.save({ day: this.currentDay, dayOfYear: this.lastDayOfYear });
  }

  // storyCalculateIslandFromDateAndTime: night and holiday come from the real
  // clock, exactly as the original does.
  calculateIslandFromDateAndTime(): void {
    const d = this.now();
    const hour = d.getHours();
    this.island.night = hour < 6 || hour >= 18;

    const month = d.getMonth() + 1;
    const day = d.getDate();
    let holiday = Holiday.None;
    if (month === 10 && day >= 29 && day <= 31) holiday = Holiday.Halloween;
    else if (month === 3 && day >= 15 && day <= 17) holiday = Holiday.StPatrick;
    else if (month === 12 && day >= 23 && day <= 25) holiday = Holiday.Christmas;
    else if ((month === 12 && day >= 29) || (month === 1 && day === 1)) holiday = Holiday.NewYear;
    this.island.holiday = holiday;
  }

  // storyPickScene: every scene whose flags satisfy the wanted/unwanted masks
  // and whose dayNo matches (or is 0 = any day), picked uniformly.
  pickScene(wanted: number, unwanted: number): StoryScene {
    const eligible = STORY_SCENES.filter(
      (s) =>
        (s.flags & wanted) === wanted &&
        (s.flags & unwanted) === 0 &&
        (s.dayNo === 0 || s.dayNo === this.currentDay),
    );
    // The Go original indexes rand.Intn(numScenes) with no empty guard; a mask
    // combination that matches nothing would panic there. Surface it clearly
    // rather than throwing an index error deep in a frame callback.
    if (eligible.length === 0) {
      throw new Error(`no story scene matches wanted=0x${wanted.toString(16)} unwanted=0x${unwanted.toString(16)} day=${this.currentDay}`);
    }
    return eligible[this.randInt(eligible.length)];
  }

  // storyCalculateIslandFromScene: per-episode island state derived from the
  // FINAL scene's flags. Note this runs against the FINAL scene, so the whole
  // episode shares one tide/position/raft configuration.
  calculateIslandFromScene(scene: StoryScene): void {
    // These are ISLAND state, so they draw from the island stream (islandRand
    // in the Go engine), not the scene-selection stream. Note Go's `&&`
    // short-circuits: with no LOWTIDE_OK flag there is NO draw at all, and the
    // port must match that or the stream desyncs from this point on.
    this.island.lowTide = (scene.flags & F.LOWTIDE_OK) !== 0 && this.islandRandInt(2) !== 0;

    if (scene.flags & F.VARPOS_OK) {
      // Three overlapping placement boxes, chosen by successive coin flips —
      // reproduced exactly (including the nested bias) from story.go. The draw
      // COUNT varies with the branch taken (1-3 flips plus 2 range draws), so
      // both engines must take the same branch to stay in step.
      if (this.islandRandInt(2) !== 0) {
        this.island.xPos = -222 + this.islandRandInt(109);
        this.island.yPos = -44 + this.islandRandInt(128);
      } else if (this.islandRandInt(2) !== 0) {
        this.island.xPos = -114 + this.islandRandInt(134);
        this.island.yPos = -14 + this.islandRandInt(99);
      } else {
        this.island.xPos = -114 + this.islandRandInt(119);
        this.island.yPos = -73 + this.islandRandInt(60);
      }
    } else if (scene.flags & F.LEFT_ISLAND) {
      this.island.xPos = -272;
      this.island.yPos = 0;
    } else {
      this.island.xPos = 0;
      this.island.yPos = 0;
    }

    // How much of the raft Johnny has managed to build by this point.
    if (scene.flags & F.NORAFT) {
      this.island.raft = 0;
    } else if (this.currentDay <= 2) {
      this.island.raft = 1;
    } else if (this.currentDay <= 5) {
      this.island.raft = this.currentDay - 1;
    } else {
      this.island.raft = 5;
    }

    // VISITOR.ADS#3 (cargo) must never show holiday items: the hull fills the
    // screen at the end and they would draw on top of it.
    if (scene.flags & F.HOLIDAY_NOK) this.island.holiday = Holiday.None;
  }

  // buildEpisode assembles one full cycle of storyPlay()'s outer loop: the
  // ordered list of scenes to play, ending with the FINAL one.
  //
  // storyPlay() interleaves playback with selection (it picks each scene, walks
  // to it, then plays it). Selection is pure and playback is not, so this
  // returns the whole list up front; with walks unported there is no behavioural
  // difference, and it keeps the async playback loop trivial.
  buildEpisode(): StoryScene[] {
    this.updateCurrentDay();
    this.calculateIslandFromDateAndTime();

    const finalScene = this.pickScene(F.FINAL, 0);
    this.calculateIslandFromScene(finalScene);

    const episode: StoryScene[] = [];
    if ((finalScene.flags & F.FIRST) === 0) {
      let wanted = 0;
      let unwanted = F.FINAL;

      if (this.island.lowTide) wanted |= F.LOWTIDE_OK;
      if (this.island.xPos !== 0 || this.island.yPos !== 0) wanted |= F.VARPOS_OK;
      // Don't cross to the island's other half mid-episode.
      if ((finalScene.flags & F.LEFT_ISLAND) === 0) unwanted |= F.LEFT_ISLAND;

      const count = 6 + this.randInt(14);
      for (let i = 0; i < count; i++) {
        episode.push(this.pickScene(wanted, unwanted));
        // Only the opening scene may be a FIRST scene.
        unwanted |= F.FIRST;
      }
    }

    episode.push(finalScene);
    return episode;
  }
}
