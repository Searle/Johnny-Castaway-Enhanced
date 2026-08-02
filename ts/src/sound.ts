// Sound effects — a port of sound.go's soundPlay().
//
// The TTM opcode PLAY_SAMPLE (0xC051) carries a sample id; 535 of them occur
// across 32 TTMs, so silence was a large missing piece rather than a detail.
//
// Uses WebAudio rather than <audio> elements: samples are short (1.5-20KB,
// 11kHz 8-bit mono), frequently retriggered, and must be able to overlap —
// an <audio> element can only play one instance of itself at a time, so rapid
// repeats would cut each other off.
//
// Browsers block audio until a user gesture. The context therefore starts
// suspended and is resumed on the first pointer/key event; sounds triggered
// before that are dropped, which is unavoidable and matches how the wasm build
// behaves (see the audio note in INSIGHTS.md).

const SOUND_COUNT = 25;
// sound.go's table marks these "missing": no WAV exists in any known release.
// GJCATCH2.TTM does play id 11 — the engine prints a warning and continues.
const MISSING = new Set([11, 13]);

export class SoundPlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private gain: GainNode | null = null;
  private unlocked = false;
  private loaded = false;
  /** Ids that failed to decode — logged once, then ignored. */
  private broken = new Set<number>();

  constructor(
    private baseUrl: string,
    private enabled = true,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.gain?.gain.setValueAtTime(0, this.ctx?.currentTime ?? 0);
    else this.gain?.gain.setValueAtTime(1, this.ctx?.currentTime ?? 0);
  }

  /** True once the browser has let us start the audio context. */
  get isUnlocked(): boolean {
    return this.unlocked;
  }

  // init wires the unlock listeners. Decoding is deferred to the first unlock
  // so page load doesn't pay for 23 fetches nobody may hear.
  init(): void {
    const unlock = () => {
      void this.resume();
    };
    // `once` on each: any one gesture is enough.
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  private async resume(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.enabled ? 1 : 0;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.unlocked = this.ctx.state === "running";
    if (!this.loaded) {
      this.loaded = true;
      await this.loadAll();
    }
  }

  private async loadAll(): Promise<void> {
    if (!this.ctx) return;
    const jobs: Promise<void>[] = [];
    for (let id = 0; id < SOUND_COUNT; id++) {
      if (MISSING.has(id)) continue;
      jobs.push(
        (async () => {
          try {
            const res = await fetch(`${this.baseUrl}/sound${id}.wav`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = await res.arrayBuffer();
            this.buffers.set(id, await this.ctx!.decodeAudioData(bytes));
          } catch (err) {
            this.broken.add(id);
            console.warn(`sound ${id} unavailable`, err);
          }
        })(),
      );
    }
    await Promise.all(jobs);
  }

  // play triggers a sample, mirroring soundPlay(): out-of-range and known-
  // missing ids are no-ops rather than errors, and nothing plays before the
  // audio context is unlocked.
  play(id: number): void {
    if (!this.enabled || !this.unlocked || !this.ctx || !this.gain) return;
    if (id < 0 || id >= SOUND_COUNT || MISSING.has(id) || this.broken.has(id)) return;
    const buf = this.buffers.get(id);
    if (!buf) return; // still decoding
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start();
  }
}
