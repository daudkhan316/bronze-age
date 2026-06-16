import { TICK_DT, MAX_TICKS_PER_FRAME, MAX_FRAME_DT } from "@/config";

export interface LoopCallbacks {
  /** Advance the deterministic simulation by exactly one fixed tick. */
  fixedUpdate(dt: number): void;
  /**
   * Render a frame. `alpha` in [0,1) is the fraction of a tick elapsed since
   * the last sim step — use it to interpolate moving entities for smooth
   * visuals despite the 20Hz sim. `frameDt` is the real wall-clock delta (s)
   * for view-only concerns like camera panning.
   */
  frame(alpha: number, frameDt: number): void;
}

/**
 * Fixed-timestep game loop. The simulation always advances in discrete TICK_DT
 * steps (determinism, reproducible save/load), while rendering runs as fast as
 * requestAnimationFrame allows. An accumulator bridges the two rates.
 *
 * If the simulation can't keep up (a tick costs more than real time), the work
 * cap (MAX_TICKS_PER_FRAME) stops the spiral of death and the overflow is
 * counted in `droppedTicks` and warned once, rather than silently swallowed —
 * so sim-bound slowdown is observable instead of hidden.
 */
export class Loop {
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private running = false;
  private warnedDrop = false;

  /** When paused, the sim stops but rendering/camera continue. */
  paused = false;

  /** Sim ticks discarded because the loop fell irrecoverably behind. */
  droppedTicks = 0;

  constructor(private readonly cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.onFrame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  private onFrame = (now: number): void => {
    if (!this.running) return;

    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp pathological gaps (tab switch, breakpoint). Larger than the work
    // cap's worth of ticks so the cap below can actually engage.
    if (frameDt > MAX_FRAME_DT) frameDt = MAX_FRAME_DT;

    if (!this.paused) {
      this.accumulator += frameDt;
      let steps = 0;
      while (this.accumulator >= TICK_DT && steps < MAX_TICKS_PER_FRAME) {
        this.cb.fixedUpdate(TICK_DT);
        this.accumulator -= TICK_DT;
        steps++;
      }
      // Hit the cap with time still owed: we're sim-bound. Drop the backlog
      // (don't spiral) but record it so the slowdown is visible.
      if (steps === MAX_TICKS_PER_FRAME && this.accumulator >= TICK_DT) {
        this.droppedTicks += Math.floor(this.accumulator / TICK_DT);
        this.accumulator = 0;
        if (!this.warnedDrop) {
          this.warnedDrop = true;
          console.warn("[Loop] simulation can't keep up; dropping ticks");
        }
      }
    } else {
      // Don't build a backlog while paused.
      this.accumulator = 0;
    }

    const alpha = this.accumulator / TICK_DT;
    this.cb.frame(alpha, frameDt);

    this.rafId = requestAnimationFrame(this.onFrame);
  };
}
