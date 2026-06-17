/**
 * Procedural sound effects via the WebAudio API (Phase 6, audio slice).
 *
 * Every sound is SYNTHESISED at runtime from oscillators + filtered noise — there
 * are no sampled asset files, so everything here is original / CC0 (see
 * ASSETS.md) and trivially swappable for real samples behind this same `play`
 * interface. This is strictly a view-layer concern: nothing here touches the
 * simulation, and the WebAudio clock (`ctx.currentTime`) is never read by sim
 * code, so determinism is unaffected.
 *
 * Browsers block audio until a user gesture, so the AudioContext is created
 * lazily and `resume()` is called from the first click / keypress.
 */

export type SoundName =
  // View (player actions / UI)
  | "select"
  | "command"
  | "attack"
  | "place"
  | "ui"
  // Sim events
  | "fire"
  | "hit"
  | "death"
  | "collapse"
  | "trained"
  | "built"
  // Match end
  | "victory"
  | "defeat";

/** A single enveloped oscillator voice. */
interface BlipOpts {
  freq: number;
  /** Optional exponential glide to this frequency over `dur`. */
  freqEnd?: number;
  type: OscillatorType;
  dur: number;
  gain: number;
}

/** A filtered noise burst (impacts, footsteps, rubble). */
interface NoiseOpts {
  dur: number;
  gain: number;
  cutoff: number;
  type: BiquadFilterType;
  /** Optional exponential filter sweep to this frequency over `dur`. */
  sweepTo?: number;
}

/** webkit-prefixed AudioContext fallback without resorting to `any`. */
interface WebkitWindow {
  webkitAudioContext?: typeof AudioContext;
}

export class SoundBank {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted: boolean;
  private readonly volume = 0.32;
  /** Last play time (audio clock seconds) per sound, for spam throttling. */
  private readonly lastAt: Partial<Record<SoundName, number>> = {};

  /**
   * Minimum gap (seconds) between two plays of the same sound. Without this a
   * pitched battle — many melee hits / arrows in one drained frame — would stack
   * into a wall of identical clicks. Sounds not listed here are never throttled.
   */
  private static readonly MIN_GAP: Partial<Record<SoundName, number>> = {
    fire: 0.05,
    hit: 0.05,
    death: 0.07,
    collapse: 0.2,
    select: 0.04,
    command: 0.04,
  };

  constructor(muted = false) {
    this.muted = muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Lazily build the context (it only actually runs after a user gesture). */
  private ensure(): AudioContext | null {
    if (this.ctx === null) {
      const Ctor = window.AudioContext ?? (window as unknown as WebkitWindow).webkitAudioContext;
      if (Ctor === undefined) return null; // no WebAudio support — silently no-op
      this.ctx = new Ctor();
      const master = this.ctx.createGain();
      master.gain.value = this.muted ? 0 : this.volume;
      master.connect(this.ctx.destination);
      this.master = master;
    }
    return this.ctx;
  }

  /** Resume the context after a user gesture (call from the first interaction). */
  resume(): void {
    const ctx = this.ensure();
    if (ctx !== null && ctx.state === "suspended") void ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx !== null && this.master !== null) {
      this.master.gain.setValueAtTime(muted ? 0 : this.volume, this.ctx.currentTime);
    }
  }

  /** Flip mute and return the new state. */
  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Play a sound, subject to mute, context readiness, and per-sound throttling. */
  play(name: SoundName): void {
    if (this.muted) return;
    const ctx = this.ensure();
    if (ctx === null || ctx.state !== "running") return; // not yet unlocked by a gesture
    const master = this.master;
    if (master === null) return;

    const now = ctx.currentTime;
    const gap = SoundBank.MIN_GAP[name];
    if (gap !== undefined) {
      const last = this.lastAt[name];
      if (last !== undefined && now - last < gap) return;
    }
    this.lastAt[name] = now;
    this.render(name, ctx, master, now);
  }

  // --- synthesis -----------------------------------------------------------

  private blip(ctx: AudioContext, master: GainNode, t0: number, o: BlipOpts): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t0 + o.dur);
    }
    // Percussive envelope: a few-ms attack, then an exponential decay to silence.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.02);
  }

  private noise(ctx: AudioContext, master: GainNode, t0: number, o: NoiseOpts): void {
    const frames = Math.max(1, Math.floor(ctx.sampleRate * o.dur));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Deterministic pseudo-noise (a tiny LCG, kept exact with Math.imul so the
    // multiply stays in 32-bit space). View-only, but staying RNG-free sidesteps
    // any "no Math.random" reflex and sounds identical each time — exactly what
    // we want for an SFX. 0x40000000 divisor keeps samples in [-1, 1).
    let s = 0x2545f4 + frames;
    for (let i = 0; i < frames; i++) {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      data[i] = (s / 0x40000000) - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = o.type;
    filt.frequency.setValueAtTime(o.cutoff, t0);
    if (o.sweepTo !== undefined) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(1, o.sweepTo), t0 + o.dur);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(o.gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + o.dur + 0.02);
  }

  private render(name: SoundName, ctx: AudioContext, master: GainNode, t0: number): void {
    switch (name) {
      case "select":
        this.blip(ctx, master, t0, { freq: 880, freqEnd: 1320, type: "triangle", dur: 0.07, gain: 0.25 });
        break;
      case "command":
        this.blip(ctx, master, t0, { freq: 520, freqEnd: 360, type: "triangle", dur: 0.08, gain: 0.22 });
        break;
      case "attack":
        this.blip(ctx, master, t0, { freq: 300, freqEnd: 150, type: "sawtooth", dur: 0.1, gain: 0.22 });
        break;
      case "place":
        this.noise(ctx, master, t0, { dur: 0.12, gain: 0.3, cutoff: 900, type: "lowpass" });
        this.blip(ctx, master, t0, { freq: 160, freqEnd: 90, type: "square", dur: 0.1, gain: 0.12 });
        break;
      case "ui":
        this.blip(ctx, master, t0, { freq: 660, type: "square", dur: 0.04, gain: 0.14 });
        break;
      case "fire": // bow twang: a filtered noise pluck plus a quick pitch drop
        this.noise(ctx, master, t0, { dur: 0.09, gain: 0.18, cutoff: 2600, type: "bandpass", sweepTo: 800 });
        this.blip(ctx, master, t0, { freq: 520, freqEnd: 240, type: "sawtooth", dur: 0.08, gain: 0.07 });
        break;
      case "hit": // melee thwack: a short low noise burst
        this.noise(ctx, master, t0, { dur: 0.07, gain: 0.28, cutoff: 1500, type: "lowpass", sweepTo: 400 });
        break;
      case "death": // a falling tone plus a body thud
        this.blip(ctx, master, t0, { freq: 300, freqEnd: 80, type: "sawtooth", dur: 0.22, gain: 0.2 });
        this.noise(ctx, master, t0, { dur: 0.18, gain: 0.12, cutoff: 800, type: "lowpass" });
        break;
      case "collapse": // building crumble: a long descending noise rumble
        this.noise(ctx, master, t0, { dur: 0.5, gain: 0.32, cutoff: 1200, type: "lowpass", sweepTo: 120 });
        this.blip(ctx, master, t0, { freq: 140, freqEnd: 50, type: "square", dur: 0.45, gain: 0.1 });
        break;
      case "trained": // soft two-note rising chime
        this.blip(ctx, master, t0, { freq: 660, type: "sine", dur: 0.1, gain: 0.16 });
        this.blip(ctx, master, t0 + 0.09, { freq: 990, type: "sine", dur: 0.12, gain: 0.16 });
        break;
      case "built": // three-note ascending arpeggio
        this.blip(ctx, master, t0, { freq: 523, type: "sine", dur: 0.1, gain: 0.16 });
        this.blip(ctx, master, t0 + 0.1, { freq: 659, type: "sine", dur: 0.1, gain: 0.16 });
        this.blip(ctx, master, t0 + 0.2, { freq: 784, type: "sine", dur: 0.16, gain: 0.18 });
        break;
      case "victory": // major fanfare
        [523, 659, 784, 1046].forEach((f, i) =>
          this.blip(ctx, master, t0 + i * 0.14, { freq: f, type: "triangle", dur: 0.22, gain: 0.2 }),
        );
        break;
      case "defeat": // descending minor tones
        [392, 330, 262, 196].forEach((f, i) =>
          this.blip(ctx, master, t0 + i * 0.16, { freq: f, type: "sawtooth", dur: 0.28, gain: 0.18 }),
        );
        break;
      default:
        break;
    }
  }
}
