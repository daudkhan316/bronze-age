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

// ---------------------------------------------------------------------------
// Phase 2 — Economy
// ---------------------------------------------------------------------------

/** The four gatherable resources. */
export type ResourceKind = "food" | "wood" | "gold" | "stone";
export const RESOURCE_KINDS: readonly ResourceKind[] = ["food", "wood", "gold", "stone"];

/**
 * A harvestable resource node (tree, berry bush, gold/stone mine). Occupies one
 * tile; gatherers stand on an adjacent tile to harvest. Removed when depleted.
 */
export interface ResourceNode {
  kind: ResourceKind;
  /** Remaining harvestable amount. */
  amount: number;
  /** Tile this node sits on. */
  tx: number;
  ty: number;
}

export type BuildingKind = "town_center" | "house";

/**
 * A placed building. Occupies a `w`×`h` block of tiles with origin (tx,ty).
 * Town Centers are resource drop-off points and train villagers; Houses add
 * population headroom.
 */
export interface Building {
  kind: BuildingKind;
  owner: number;
  /** Footprint origin tile (top tile in grid space). */
  tx: number;
  ty: number;
  w: number;
  h: number;
}

/** Villager economy task + carry state (driven by GatherSystem). */
export type GatherState = "toNode" | "gathering" | "toDrop" | "depositing";
export interface Gather {
  /** Assigned resource node entity (may deplete; then a new one is sought). */
  node: number | null;
  /** Resource being gathered, so we can find a replacement node when one runs out. */
  resourceKind: ResourceKind | null;
  /** Amount currently carried (0..CARRY_CAPACITY). */
  carrying: number;
  state: GatherState;
}

/** Per-player economy state, stored on a dedicated player entity. */
export interface PlayerState {
  id: number;
  food: number;
  wood: number;
  gold: number;
  stone: number;
  /** Population currently used (units owned) and the current cap. */
  popUsed: number;
  popCap: number;
}

/** Training queue on a building (Town Center). Trains villagers one at a time. */
export interface TrainQueue {
  /** Number of villagers queued (including the one in progress). */
  queued: number;
  /** Ticks elapsed on the in-progress villager. */
  progress: number;
}

export const CResourceNode = defineComponent<ResourceNode>("ResourceNode");
export const CBuilding = defineComponent<Building>("Building");
export const CGather = defineComponent<Gather>("Gather");
export const CPlayer = defineComponent<PlayerState>("Player");
export const CTrainQueue = defineComponent<TrainQueue>("TrainQueue");

/** How much a gatherer can carry before returning to a drop-off. */
export const CARRY_CAPACITY = 10;
/** Harvest rate in resource units per second (uniform for now; tuned for a snappy loop). */
export const GATHER_RATE = 6;
/** A gatherer harvests/deposits when within this Chebyshev tile distance of the target. */
export const INTERACT_RANGE = 1;

/** Starting amount per node kind. */
export const NODE_AMOUNT: Record<ResourceKind, number> = {
  food: 100,
  wood: 60,
  gold: 200,
  stone: 150,
};

/** When a node depletes, a gatherer looks this many tiles out for another of its kind. */
export const NODE_SEARCH_RADIUS = 8;

export const BUILDING_SIZE: Record<BuildingKind, { w: number; h: number }> = {
  town_center: { w: 3, h: 3 },
  house: { w: 2, h: 2 },
};

/** Population headroom each building contributes. */
export const POP_PROVIDED: Record<BuildingKind, number> = {
  town_center: 5,
  house: 5,
};

/** Cost to train a villager (food only, AoE-style). */
export const VILLAGER_COST: Partial<Record<ResourceKind, number>> = { food: 50 };
/** Ticks to train one villager (≈2s @20Hz). */
export const VILLAGER_TRAIN_TICKS = 40;
/** Hard population ceiling regardless of houses. */
export const MAX_POP = 200;
