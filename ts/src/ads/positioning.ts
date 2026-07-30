// Per-scene grDx/grDy positioning (the story layer's island offset).
//
// In the real engine main.go computes ttmDx/ttmDy from the story's island
// state: `ttmDx = islandState.xPos + xOffset` where xOffset = 272 for
// LEFT_ISLAND scenes (the "date island" the Mary romance plays on). Most scenes
// are authored at grDx=0 (the centered island), so they need no offset; a
// handful of positioned "story" scenes assume the shift and otherwise draw over
// open water (e.g. SMDATE.TTM via MARY.ADS).
//
// Without the full story calendar we don't know islandState.xPos, so this
// applies just the known constant offsets for the positioned scenes. Returns
// {dx,dy} for a given ADS script + (slot, tag).

// LEFT_ISLAND horizontal offset from main.go.
const LEFT_ISLAND_DX = 272;

// ADS scripts whose scenes are authored for the LEFT_ISLAND (date) position.
// MARY.ADS is the romance arc (SMDATE/SASKDATE/SBREAKUP/…). Confirmed by the
// "on water" symptom + the LEFT_ISLAND flag on these story scenes.
const LEFT_ISLAND_SCRIPTS = new Set<string>(["MARY.ADS"]);

export function positionForScene(adsName: string, _slot: number, _tag: number): { dx: number; dy: number } {
  if (LEFT_ISLAND_SCRIPTS.has(adsName.toUpperCase())) {
    return { dx: LEFT_ISLAND_DX, dy: 0 };
  }
  return { dx: 0, dy: 0 };
}
