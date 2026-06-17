/**
 * One-way sim → view event channel (Phase 6, audio slice).
 *
 * Mirrors `CommandBuffer`, but flows the OTHER way. A `Command` is an intent the
 * VIEW feeds INTO the sim; a `GameEvent` is a transient "something happened"
 * notification the SIM emits OUT to the view (an arrow loosed, a unit died, a
 * building finished). The view drains the buffer each rendered frame and turns
 * the events into feedback — currently sound.
 *
 * Determinism: this buffer is deliberately NOT part of the save snapshot and is
 * NEVER read back by simulation code. Emitting is a pure push — it draws no RNG
 * and writes no sim state — so it cannot perturb the deterministic tick. The
 * save/load byte-identical replay test must remain green with events wired in.
 */

export type GameEventType =
  | "projectile_fired" // a ranged unit / tower loosed an arrow
  | "melee_hit" // a melee attack connected
  | "unit_died" // a unit reached 0 hp and was reaped
  | "building_destroyed" // a building reached 0 hp and was reaped
  | "unit_trained" // a training building produced a unit
  | "building_completed"; // a foundation finished construction

export interface GameEvent {
  type: GameEventType;
  /** Owner (player id) of the acting/affected entity, or -1 if not meaningful. */
  owner: number;
  /** World position where it happened — used to fog-gate audio. 0,0 if unused. */
  x: number;
  y: number;
}

/**
 * Defensive cap. In practice the loop drains the buffer every frame it ticks the
 * sim (both run in the same rAF callback), so it never grows unbounded — but a
 * hard ceiling keeps a pathological stall from ballooning memory.
 */
const MAX_EVENTS = 4096;

/** A simple append/drain queue of view-facing simulation events. */
export class EventBuffer {
  private events: GameEvent[] = [];

  /** Append an event. Cheap and side-effect-free on the simulation. */
  emit(type: GameEventType, owner: number, x: number, y: number): void {
    if (this.events.length >= MAX_EVENTS) return; // drop under a pathological backlog
    this.events.push({ type, owner, x, y });
  }

  /** Take and clear every queued event (called by the view once per frame). */
  drain(): GameEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Discard everything (e.g. on match teardown). */
  clear(): void {
    this.events.length = 0;
  }
}
