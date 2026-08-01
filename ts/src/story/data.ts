// Story scene table — a mechanical port of story_data.go's `storyScenes`.
// Generated from the Go source; do not hand-edit. Each row is one playable
// story beat: which ADS entry tag to run, where Johnny stands when it starts
// and ends (for walk transitions), which story day it belongs to (0 = any),
// and the flag mask storyPickScene() filters on.

export const SceneFlag = {
  FINAL: 0x01,
  FIRST: 0x02,
  ISLAND: 0x04,
  LEFT_ISLAND: 0x08,
  VARPOS_OK: 0x10,
  LOWTIDE_OK: 0x20,
  NORAFT: 0x40,
  HOLIDAY_NOK: 0x80,
} as const;

// Spots A-F are the six standing positions on the island; headings are the
// eight compass directions Johnny can face (S, SW, W, NW, N, NE, E, SE).
export const Spot = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 } as const;
export const Hdg = { S: 0, SW: 1, W: 2, NW: 3, N: 4, NE: 5, E: 6, SE: 7 } as const;

export interface StoryScene {
  adsName: string;
  adsTag: number;
  spotStart: number;
  hdgStart: number;
  spotEnd: number;
  hdgEnd: number;
  dayNo: number; // 0 = valid on any day of the 11-day arc
  flags: number;
}

const F = SceneFlag;

export const STORY_SCENES: readonly StoryScene[] = [
  { adsName: "ACTIVITY.ADS", adsTag: 1, spotStart: Spot.E, hdgStart: Hdg.SE, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 12, spotStart: Spot.D, hdgStart: Hdg.SW, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 11, spotStart: 0, hdgStart: 0, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.FIRST | F.VARPOS_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 10, spotStart: Spot.D, hdgStart: Hdg.SW, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 4, spotStart: Spot.E, hdgStart: Hdg.SE, spotEnd: Spot.E, hdgEnd: Hdg.SE, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 5, spotStart: Spot.E, hdgStart: Hdg.SW, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 6, spotStart: Spot.D, hdgStart: Hdg.SW, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 7, spotStart: Spot.D, hdgStart: Hdg.SW, spotEnd: Spot.F, hdgEnd: Hdg.SW, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 8, spotStart: 0, hdgStart: 0, spotEnd: Spot.D, hdgEnd: Hdg.SE, dayNo: 0, flags: F.ISLAND | F.FIRST | F.VARPOS_OK },
  { adsName: "ACTIVITY.ADS", adsTag: 9, spotStart: Spot.E, hdgStart: Hdg.E, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.LOWTIDE_OK },
  { adsName: "BUILDING.ADS", adsTag: 1, spotStart: Spot.F, hdgStart: Hdg.W, spotEnd: Spot.A, hdgEnd: Hdg.W, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "BUILDING.ADS", adsTag: 4, spotStart: Spot.A, hdgStart: Hdg.E, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "BUILDING.ADS", adsTag: 3, spotStart: Spot.A, hdgStart: Hdg.E, spotEnd: Spot.C, hdgEnd: Hdg.SE, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "BUILDING.ADS", adsTag: 2, spotStart: Spot.F, hdgStart: Hdg.W, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "BUILDING.ADS", adsTag: 5, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: Spot.D, hdgEnd: Hdg.E, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "BUILDING.ADS", adsTag: 7, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: Spot.D, hdgEnd: Hdg.E, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "BUILDING.ADS", adsTag: 6, spotStart: Spot.A, hdgStart: Hdg.E, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "FISHING.ADS", adsTag: 1, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: Spot.D, hdgEnd: Hdg.E, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "FISHING.ADS", adsTag: 2, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: Spot.D, hdgEnd: Hdg.E, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "FISHING.ADS", adsTag: 3, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "FISHING.ADS", adsTag: 4, spotStart: Spot.E, hdgStart: Hdg.E, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.LEFT_ISLAND | F.LOWTIDE_OK },
  { adsName: "FISHING.ADS", adsTag: 5, spotStart: Spot.E, hdgStart: Hdg.E, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "FISHING.ADS", adsTag: 6, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.LOWTIDE_OK },
  { adsName: "FISHING.ADS", adsTag: 7, spotStart: Spot.E, hdgStart: Hdg.E, spotEnd: Spot.E, hdgEnd: Hdg.W, dayNo: 0, flags: F.ISLAND | F.LEFT_ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "FISHING.ADS", adsTag: 8, spotStart: Spot.E, hdgStart: Hdg.E, spotEnd: Spot.E, hdgEnd: Hdg.W, dayNo: 0, flags: F.ISLAND | F.LEFT_ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "JOHNNY.ADS", adsTag: 1, spotStart: 0, hdgStart: 0, spotEnd: 0, hdgEnd: 0, dayNo: 11, flags: F.FINAL | F.FIRST },
  { adsName: "JOHNNY.ADS", adsTag: 2, spotStart: Spot.E, hdgStart: Hdg.SW, spotEnd: Spot.F, hdgEnd: 0, dayNo: 2, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "JOHNNY.ADS", adsTag: 3, spotStart: Spot.E, hdgStart: Hdg.SW, spotEnd: Spot.F, hdgEnd: Hdg.NE, dayNo: 6, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "JOHNNY.ADS", adsTag: 4, spotStart: Spot.E, hdgStart: Hdg.SW, spotEnd: Spot.F, hdgEnd: Hdg.NE, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK },
  { adsName: "JOHNNY.ADS", adsTag: 5, spotStart: Spot.E, hdgStart: Hdg.SW, spotEnd: Spot.F, hdgEnd: Hdg.NE, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK },
  { adsName: "JOHNNY.ADS", adsTag: 6, spotStart: 0, hdgStart: 0, spotEnd: 0, hdgEnd: 0, dayNo: 10, flags: F.FINAL | F.FIRST },
  { adsName: "MARY.ADS", adsTag: 1, spotStart: Spot.E, hdgStart: Hdg.SW, spotEnd: 0, hdgEnd: 0, dayNo: 5, flags: F.ISLAND | F.FINAL | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "MARY.ADS", adsTag: 3, spotStart: Spot.F, hdgStart: Hdg.SW, spotEnd: 0, hdgEnd: 0, dayNo: 4, flags: F.ISLAND | F.FINAL | F.FIRST | F.VARPOS_OK },
  { adsName: "MARY.ADS", adsTag: 2, spotStart: Spot.E, hdgStart: Hdg.E, spotEnd: 0, hdgEnd: 0, dayNo: 1, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "MARY.ADS", adsTag: 4, spotStart: Spot.E, hdgStart: Hdg.E, spotEnd: 0, hdgEnd: 0, dayNo: 7, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "MARY.ADS", adsTag: 5, spotStart: Spot.E, hdgStart: Hdg.NW, spotEnd: 0, hdgEnd: 0, dayNo: 8, flags: F.ISLAND | F.LEFT_ISLAND | F.FINAL | F.FIRST | F.NORAFT | F.VARPOS_OK },
  { adsName: "MISCGAG.ADS", adsTag: 1, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "MISCGAG.ADS", adsTag: 2, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.VARPOS_OK },
  { adsName: "STAND.ADS", adsTag: 1, spotStart: Spot.A, hdgStart: Hdg.SW, spotEnd: Spot.A, hdgEnd: Hdg.SW, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 2, spotStart: Spot.A, hdgStart: Hdg.W, spotEnd: Spot.A, hdgEnd: Hdg.W, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 3, spotStart: Spot.A, hdgStart: Hdg.NW, spotEnd: Spot.A, hdgEnd: Hdg.NW, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 4, spotStart: Spot.B, hdgStart: Hdg.SW, spotEnd: Spot.B, hdgEnd: Hdg.SW, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 5, spotStart: Spot.B, hdgStart: Hdg.S, spotEnd: Spot.B, hdgEnd: Hdg.S, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 6, spotStart: Spot.B, hdgStart: Hdg.SE, spotEnd: Spot.B, hdgEnd: Hdg.SE, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 7, spotStart: Spot.C, hdgStart: Hdg.NE, spotEnd: Spot.C, hdgEnd: Hdg.NE, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 8, spotStart: Spot.C, hdgStart: Hdg.E, spotEnd: Spot.C, hdgEnd: Hdg.E, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 9, spotStart: Spot.D, hdgStart: Hdg.NW, spotEnd: Spot.D, hdgEnd: Hdg.NW, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 10, spotStart: Spot.D, hdgStart: Hdg.NE, spotEnd: Spot.D, hdgEnd: Hdg.NE, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 11, spotStart: Spot.E, hdgStart: Hdg.NW, spotEnd: Spot.E, hdgEnd: Hdg.NW, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 12, spotStart: Spot.F, hdgStart: Hdg.S, spotEnd: Spot.F, hdgEnd: Hdg.S, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 15, spotStart: Spot.A, hdgStart: Hdg.S, spotEnd: Spot.A, hdgEnd: Hdg.S, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "STAND.ADS", adsTag: 16, spotStart: Spot.C, hdgStart: Hdg.S, spotEnd: Spot.C, hdgEnd: Hdg.S, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "SUZY.ADS", adsTag: 1, spotStart: 0, hdgStart: 0, spotEnd: 0, hdgEnd: 0, dayNo: 3, flags: F.FINAL | F.FIRST },
  { adsName: "SUZY.ADS", adsTag: 2, spotStart: 0, hdgStart: 0, spotEnd: 0, hdgEnd: 0, dayNo: 9, flags: F.FINAL | F.FIRST },
  { adsName: "VISITOR.ADS", adsTag: 1, spotStart: Spot.A, hdgStart: Hdg.S, spotEnd: Spot.A, hdgEnd: Hdg.S, dayNo: 0, flags: F.ISLAND | F.LOWTIDE_OK },
  { adsName: "VISITOR.ADS", adsTag: 3, spotStart: Spot.B, hdgStart: Hdg.NW, spotEnd: Spot.D, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.HOLIDAY_NOK },
  { adsName: "VISITOR.ADS", adsTag: 4, spotStart: Spot.D, hdgStart: Hdg.S, spotEnd: Spot.D, hdgEnd: Hdg.W, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "VISITOR.ADS", adsTag: 6, spotStart: Spot.D, hdgStart: Hdg.S, spotEnd: Spot.D, hdgEnd: Hdg.SW, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "VISITOR.ADS", adsTag: 7, spotStart: Spot.D, hdgStart: Hdg.S, spotEnd: Spot.D, hdgEnd: Hdg.SW, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "VISITOR.ADS", adsTag: 5, spotStart: Spot.E, hdgStart: Hdg.SW, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.LEFT_ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
  { adsName: "WALKSTUF.ADS", adsTag: 1, spotStart: Spot.A, hdgStart: Hdg.NE, spotEnd: 0, hdgEnd: 0, dayNo: 0, flags: F.ISLAND | F.FINAL | F.LOWTIDE_OK },
  { adsName: "WALKSTUF.ADS", adsTag: 2, spotStart: Spot.E, hdgStart: Hdg.E, spotEnd: Spot.D, hdgEnd: Hdg.SE, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK },
  { adsName: "WALKSTUF.ADS", adsTag: 3, spotStart: Spot.D, hdgStart: Hdg.W, spotEnd: Spot.E, hdgEnd: Hdg.W, dayNo: 0, flags: F.ISLAND | F.VARPOS_OK | F.LOWTIDE_OK },
];
