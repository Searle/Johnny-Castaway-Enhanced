// Per-scene grDx/grDy positioning (the story layer's island offset).
//
// How the real engine positions a scene (main.go + story.go):
//   storyCalculateIslandFromScene() sets islandState.xPos/yPos, then
//   ttmDx = islandState.xPos + (LEFT_ISLAND ? 272 : 0).
//   - VARPOS_OK scenes: xPos is a NEGATIVE random (~ -114..-222); the island
//     backdrop AND the scene sprites both get this same grDx, so they shift
//     together and stay aligned.
//   - LEFT_ISLAND (non-VARPOS) scenes: xPos = -272, xOffset = +272 → net
//     ttmDx = 0.
//   - plain scenes: xPos = 0 → ttmDx = 0.
//
// The key fact: the sprite offset (grDx) and the island backdrop offset are
// ALWAYS the same value, so Johnny stays on the island regardless of where it
// is. The randomization only moves the whole tableau around the screen.
//
// This port uses a STATIC pre-baked island backdrop (ISLETEMP.SCR) that cannot
// be re-positioned. So the only offset that keeps sprites aligned with that
// fixed backdrop is grDx = 0 — which is exactly the LEFT_ISLAND and plain-scene
// case, and the VARPOS baseline. We therefore apply NO offset. (An earlier stub
// added +272 for MARY.ADS, which was wrong on two counts: MARY's date scene is
// VARPOS not LEFT_ISLAND, and even LEFT_ISLAND nets to 0.)
//
// Fully correct VARPOS positioning would require porting the story calendar
// (story.go/story_data.go) AND redrawing the island backdrop at the chosen
// xPos each scene instead of using the baked ISLETEMP — out of scope here.

export function positionForScene(_adsName: string, _slot: number, _tag: number): { dx: number; dy: number } {
  return { dx: 0, dy: 0 };
}
