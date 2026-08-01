// Walk oracle: emit the walk animation's frame stream in the same format as the
// Go reference (scratch harness re-hosting walk.go's state machine), so the two
// can be diffed exactly.
//
// The walk is pointer arithmetic over a flat table, including a magic `+9`; it
// is precisely the sort of port that looks right and is off by one somewhere.
// Neither the draw-call nor the pixel oracle covers it — they drive a single ADS
// tag and the walk is not an ADS script at all.
//
// Usage: npx tsx tools/walk-check.ts > ts-walk.txt && diff go-walk.txt ts-walk.txt

import { Walk } from "../src/story/walk";
import { WALK_MATRIX, NUM_NODES, UNDEF_NODE } from "../src/story/walk-data";

for (let from = 0; from < NUM_NODES; from++) {
  for (let to = 0; to < NUM_NODES; to++) {
    for (let fh = 0; fh < 8; fh++) {
      for (let th = 0; th < 8; th++) {
        let path: number[];
        if (from === to) path = [from];
        else if (WALK_MATRIX[UNDEF_NODE][from][to] !== 0) path = [from, to];
        else continue;

        const w = new Walk(from, fh, to, th, Math.random, path);
        const parts: string[] = [];
        for (let i = 0; i < 400; i++) {
          const f = w.step();
          if (!f) break;
          parts.push(`${f.x}/${f.y}/${f.spriteNo}/${f.flip ? 1 : 0}/${f.delay}`);
        }
        console.log(`W ${from},${fh}->${to},${th}:` + (parts.length ? " " + parts.join(" ") : ""));
      }
    }
  }
}
