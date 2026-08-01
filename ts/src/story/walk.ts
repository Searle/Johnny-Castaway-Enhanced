// Walk transitions between story scenes — a port of walk.go + calcpath.go.
//
// Between two story beats Johnny WALKS from the previous scene's end spot to
// the next scene's start spot, turning on the way. Without this the screensaver
// cuts between poses; with it the beats join up into continuous motion.
//
// The engine drives this with a moving C pointer into a flat table
// (`data += 1`, `data += 9`). Here `dataIdx` is that pointer as an index into
// WALK_DATA — the arithmetic is deliberately kept identical, including the
// magic +9, rather than "cleaned up" into something more idiomatic.

import {
  WALK_DATA,
  WALK_BOOKMARKS,
  WALK_BOOKMARKS_TURNS,
  WALK_START_HEADINGS,
  WALK_END_HEADINGS,
  WALK_MATRIX,
  NUM_NODES,
  UNDEF_NODE,
} from "./walk-data";

const MAX_PATH_LEN = 7;

// calcPath: enumerate every legal simple path from->to and pick one at random.
// The legality of a step depends on the two preceding nodes, not just the
// current one, which is why walkMatrix is indexed [prev][cur][next].
export function calcPath(fromNode: number, toNode: number, rnd: () => number): number[] {
  const paths: number[][] = [];
  const marked = new Array<boolean>(NUM_NODES).fill(false);
  const fromNodeOf = new Array<number>(NUM_NODES).fill(0);

  function recurse(prevNode: number, curNode: number, pathLen: number): void {
    if (curNode === toNode) {
      const path = new Array<number>(pathLen);
      let n = curNode;
      for (let i = pathLen - 1; i >= 0; i--) {
        path[i] = n;
        n = fromNodeOf[n];
      }
      paths.push(path);
      return;
    }
    if (pathLen >= MAX_PATH_LEN) return; // the Go original bounds paths at 7 nodes
    for (let next = 0; next < NUM_NODES; next++) {
      if (WALK_MATRIX[prevNode][curNode][next] !== 0 && !marked[next]) {
        marked[next] = true;
        fromNodeOf[next] = curNode;
        recurse(curNode, next, pathLen + 1);
        marked[next] = false;
      }
    }
  }

  marked[fromNode] = true;
  fromNodeOf[fromNode] = UNDEF_NODE;
  recurse(UNDEF_NODE, fromNode, 1);

  // calcPath indexes rand()%numPaths with no empty guard; if the graph ever
  // yields no route, say so rather than dereferencing undefined mid-animation.
  if (paths.length === 0) throw new Error(`no walk path from ${fromNode} to ${toNode}`);
  return paths[Math.floor(rnd() * paths.length)];
}

/** One rendered walk frame: which sprite to draw where, and for how long. */
export interface WalkFrame {
  x: number;
  y: number;
  spriteNo: number;
  flip: boolean;
  /** Engine ticks to hold this frame. 0 means the walk is over. */
  delay: number;
  /** True while Johnny passes behind the palm — the trunk redraws over him. */
  behindTree: boolean;
}

export class Walk {
  private path: number[] = [];
  private pathIdx = 0;
  private currentSpot = 0;
  private currentHdg = 0;
  private nextSpot = -1;
  private nextHdg = 0;
  private finalSpot = 0;
  private finalHdg = 0;
  private increment = 0;
  private lastTurn = false;
  private hasArrived = false;
  private behindTree = false;
  private dataIdx = 0;

  // fixedPath is a test seam: the walk oracle (tools/walk-check.ts) pins the
  // route so TS and Go frame streams can be compared without matching RNGs.
  constructor(
    fromSpot: number,
    fromHdg: number,
    toSpot: number,
    toHdg: number,
    rnd: () => number,
    fixedPath?: number[],
  ) {
    this.path = fixedPath ?? calcPath(fromSpot, toSpot, rnd);
    this.pathIdx = 0;
    this.currentSpot = fromSpot;
    this.currentHdg = fromHdg;
    this.finalSpot = toSpot;
    this.finalHdg = toHdg;

    if (fromSpot === toSpot) {
      // Already there: the whole "walk" is a turn in place.
      this.nextSpot = -1;
      this.nextHdg = toHdg;
      this.lastTurn = true;
    } else {
      this.pathIdx++;
      this.nextSpot = this.path[this.pathIdx];
      this.nextHdg = WALK_START_HEADINGS[this.currentSpot][this.nextSpot];
      this.lastTurn = false;
    }
    this.increment = this.turnDirection(this.nextHdg, this.currentHdg);
  }

  // Which way round the 8-point compass to turn: +1, -1, or 0 if already facing.
  private turnDirection(toHdg: number, fromHdg: number): number {
    const d = (toHdg - fromHdg) & 0x07;
    if (d === 0) return 0;
    return d < 4 ? 1 : -1;
  }

  get done(): boolean {
    return this.finished;
  }
  private finished = false;

  // step advances one animation frame, mirroring walkAnimate(). Returns null
  // once the walk is over (walkAnimate's delay == 0 case).
  step(): WalkFrame | null {
    if (this.finished) return null;
    if (this.hasArrived) {
      this.finished = true;
      return null;
    }

    if (this.nextHdg !== -1) {
      // Turning. `% 7` makes a full 7-step turn compare as 0, so the engine
      // treats "7 steps away" as already-there rather than turning the long way.
      if (((this.nextHdg - this.currentHdg) & 0x07) % 7 > 1) {
        this.currentHdg = (this.currentHdg + this.increment) & 7;
        this.dataIdx = WALK_BOOKMARKS_TURNS[this.currentSpot] + this.currentHdg;
        if (this.lastTurn) this.dataIdx += 9; // +9 selects the hands-in-pockets pose
      } else if (this.currentSpot !== this.finalSpot) {
        // Turn finished and there is further to go: start the walk run.
        this.nextHdg = -1;
        this.behindTree =
          (this.currentSpot === 3 && this.nextSpot === 4) ||
          (this.currentSpot === 4 && this.nextSpot === 3);
        this.dataIdx = WALK_BOOKMARKS[this.currentSpot][this.nextSpot];
      } else {
        // Turn finished at the destination.
        this.dataIdx = WALK_BOOKMARKS_TURNS[this.finalSpot] + this.finalHdg + 9;
        this.hasArrived = true;
      }
    } else {
      // Walking forward along a run.
      this.dataIdx++;
      if (WALK_DATA[this.dataIdx][1] === 0) {
        // Sentinel row: we reached the next spot.
        this.currentHdg = WALK_END_HEADINGS[this.currentSpot][this.nextSpot];
        this.currentSpot = this.nextSpot;

        if (this.currentSpot !== this.finalSpot) {
          this.pathIdx++;
          this.nextSpot = this.path[this.pathIdx];
          this.nextHdg = WALK_START_HEADINGS[this.currentSpot][this.nextSpot];
        } else {
          this.nextHdg = this.finalHdg;
          this.lastTurn = true;
        }

        this.increment = this.turnDirection(this.nextHdg, this.currentHdg);
        this.currentHdg = (this.currentHdg + this.increment) & 7;
        this.dataIdx = WALK_BOOKMARKS_TURNS[this.currentSpot] + this.currentHdg;

        if (this.lastTurn) {
          this.dataIdx += 9;
          if (this.currentHdg === this.finalHdg) this.hasArrived = true;
        }
        this.behindTree = false;
      }
    }

    const row = WALK_DATA[this.dataIdx];
    return {
      // Field 1 is x biased by one; the engine draws at data[1]-1.
      x: row[1] - 1,
      y: row[2],
      spriteNo: row[3],
      flip: row[0] !== 0,
      delay: this.hasArrived ? 80 : 6,
      behindTree: this.behindTree,
    };
  }
}
