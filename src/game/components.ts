import { defineComponent } from "@/ecs/types";
import type { GridPoint } from "@/math/iso";

/**
 * Phase 1 components. All are plain, JSON-safe data (see WorldSnapshot's
 * contract). Positions are stored in WORLD space (the iso plane, pixels at
 * zoom 1) — the single source of truth for smooth movement and rendering;
 * the occupied tile is derived via worldToTile when needed (pathfinding).
 */

/** Continuous world-space position of an entity. */
export interface Transform {
  x: number;
  y: number;
}

/**
 * Movement intent + state. `path` is the remaining list of tile waypoints to
 * walk (empty = idle); `goal` is the final destination, retained so a unit can
 * re-path if it gets stuck. Waypoints are tile coords; the mover converts each
 * to a world point via tileCenterWorld.
 */
export interface Movement {
  /** World units per second. */
  speed: number;
  /** Remaining tile waypoints, in order. Empty when idle. */
  path: GridPoint[];
  /** Final destination tile, or null when idle. */
  goal: GridPoint | null;
  /**
   * Consecutive ticks with ~no net progress while still pathing. When it
   * crosses a threshold the unit gives up (clears its path) so a crowd that
   * can't all reach a destination settles instead of jittering forever.
   */
  stuck: number;
}

export type UnitKind = "villager";

/** Marks an entity as a unit (selectable, commandable, collidable). */
export interface Unit {
  kind: UnitKind;
  /** Player id: 0 = human player, 1+ = AI/other (Phase 5). */
  owner: number;
  /** Collision/selection radius in world units. */
  radius: number;
}

export const CTransform = defineComponent<Transform>("Transform");
export const CMovement = defineComponent<Movement>("Movement");
export const CUnit = defineComponent<Unit>("Unit");

/** The human player's id. Only owner-0 units are player-selectable. */
export const PLAYER_ID = 0;

/** Per-unit-kind base stats. Extended heavily in later phases. */
export const UNIT_STATS: Record<UnitKind, { speed: number; radius: number }> = {
  villager: { speed: 55, radius: 11 },
};
