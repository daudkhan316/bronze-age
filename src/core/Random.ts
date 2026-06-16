/**
 * Deterministic PRNG (mulberry32). Small, fast, and — crucially — its entire
 * state is a single uint32, so the simulation's randomness is serializable and
 * reproducible. Never use Math.random() inside the sim; route through this.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    // Force to uint32.
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Chance in [0, 1]. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Serialize the generator's full state. */
  save(): number {
    return this.state >>> 0;
  }

  /** Restore from a previously saved state. */
  static restore(state: number): Random {
    const r = new Random(0);
    r.state = state >>> 0;
    return r;
  }
}
