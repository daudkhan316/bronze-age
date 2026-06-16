import { defineComponent } from "@/ecs/types";
import type { GridPoint } from "@/math/iso";
import type { Difficulty } from "@/game/match";

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

export type UnitKind = "villager" | "spearman" | "archer";

/** Marks an entity as a unit (selectable, commandable, collidable). */
export interface Unit {
  kind: UnitKind;
  /** Player id: 0 = human player, 1+ = AI/other (Phase 5). */
  owner: number;
  /** Collision/selection radius in world units. */
  radius: number;
  /** Current / max hit points (combat lands in Phase 4; HP shown now). */
  hp: number;
  maxHp: number;
}

export const CTransform = defineComponent<Transform>("Transform");
export const CMovement = defineComponent<Movement>("Movement");
export const CUnit = defineComponent<Unit>("Unit");

/** The human player's id. Only owner-0 units are player-selectable. */
export const PLAYER_ID = 0;
/** The (single) AI opponent's id in a 1v1 match (Phase 5). */
export const AI_ID = 1;

/**
 * Per-unit-kind definition: movement, HP, (Phase 4) combat stats, and training
 * cost. `trainedAt` ties a unit to the building kind that produces it.
 */
export interface UnitDef {
  speed: number;
  radius: number;
  hp: number;
  attack: number;
  armor: number;
  pierceArmor: number;
  /** Attack range in tiles; 0 = melee. */
  range: number;
  /** Seconds between attacks. */
  attackCooldown: number;
  /** Vision radius in tiles (fog of war). */
  sight: number;
  cost: Partial<Record<ResourceKind, number>>;
  trainTicks: number;
  trainedAt: BuildingKind;
}

export const UNIT_STATS: Record<UnitKind, UnitDef> = {
  villager: {
    speed: 55, radius: 11, hp: 25,
    attack: 3, armor: 0, pierceArmor: 0, range: 0, attackCooldown: 2, sight: 4,
    cost: { food: 50 }, trainTicks: 40, trainedAt: "town_center",
  },
  spearman: {
    speed: 50, radius: 11, hp: 45,
    attack: 6, armor: 1, pierceArmor: 0, range: 0, attackCooldown: 2, sight: 5,
    cost: { food: 35, wood: 25 }, trainTicks: 55, trainedAt: "barracks",
  },
  archer: {
    speed: 48, radius: 11, hp: 35,
    attack: 4, armor: 0, pierceArmor: 0, range: 5, attackCooldown: 2.5, sight: 6,
    cost: { wood: 25, gold: 45 }, trainTicks: 50, trainedAt: "archery_range",
  },
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

export type BuildingKind =
  | "town_center"
  | "house"
  | "barracks"
  | "archery_range"
  | "lumber_camp"
  | "mining_camp"
  | "mill"
  | "blacksmith"
  | "watch_tower";

/**
 * A placed building, occupying a `w`×`h` block of tiles with origin (tx,ty).
 * While `complete` is false it's a foundation under construction — it does NOT
 * provide population, train units, or accept drop-offs until built.
 */
export interface Building {
  kind: BuildingKind;
  owner: number;
  /** Footprint origin tile (top tile in grid space). */
  tx: number;
  ty: number;
  w: number;
  h: number;
  complete: boolean;
  hp: number;
  maxHp: number;
}

/** Construction progress on a foundation (driven by BuildSystem). */
export interface Construction {
  /** Build points accumulated. */
  progress: number;
  /** Build points required to finish (= the kind's buildTicks). */
  required: number;
}

/** Villager construction task (driven by BuildSystem). */
export type BuildState = "toSite" | "building";
export interface Build {
  /** Target foundation entity. */
  target: number;
  state: BuildState;
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
  /** True for a computer-controlled player (Phase 5). */
  isAI: boolean;
  /** AI difficulty (null for the human). */
  difficulty: Difficulty | null;
  /** Set once all this player's buildings are destroyed (lost the match). */
  defeated: boolean;
  /** Current age (Phase 6): 1 = Stone, 2 = Bronze, 3 = Iron. */
  age: number;
  /** Researched upgrade ids (Phase 6). Plain string[] so it stays JSON-safe. */
  techs: string[];
}

/**
 * Bookkeeping for one AI player, stored on its player entity (so it serializes
 * and stays deterministic across save/load — a stateless system can't hold a
 * counter without breaking determinism on reload). `AiSystem` owns the schema of
 * `stage`; everything here is plain JSON-safe data.
 */
export interface AiMemory {
  owner: number;
  /** Increments every AI update; the think cadence derives from this. */
  ticks: number;
  /** Build-order stage label (AiSystem-defined). */
  stage: string;
  /** True while committed to an attack push (army marching / fighting). */
  attacking: boolean;
  /** Remembered rally / attack target tile (enemy direction). -1 = none yet. */
  rallyTx: number;
  rallyTy: number;
}

/**
 * Singleton match-outcome state (one entity per game). Latches once decided so
 * the result is stable. Deterministic + serialized so a loaded game knows it's
 * already over. `winner` is the surviving player's id, or null for a draw.
 */
export interface MatchState {
  over: boolean;
  winner: number | null;
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
export const CConstruction = defineComponent<Construction>("Construction");
export const CBuild = defineComponent<Build>("Build");
export const CGather = defineComponent<Gather>("Gather");
export const CPlayer = defineComponent<PlayerState>("Player");
export const CTrainQueue = defineComponent<TrainQueue>("TrainQueue");
export const CAiMemory = defineComponent<AiMemory>("AiMemory");
export const CMatch = defineComponent<MatchState>("Match");

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

/**
 * Per-building-kind definition: footprint, cost, build time, hit points, the
 * population it provides (when complete), the resources it accepts as a
 * drop-off, and the unit it trains (if any).
 */
export interface BuildingDef {
  w: number;
  h: number;
  cost: Partial<Record<ResourceKind, number>>;
  /** Build points to construct (one builder adds 1 per tick). 0 = pre-built. */
  buildTicks: number;
  maxHp: number;
  /** Population headroom provided when complete. */
  pop: number;
  /** Resource kinds accepted as a drop-off when complete. */
  accepts: readonly ResourceKind[];
  /** Unit kind this building trains when complete, or null. */
  trains: UnitKind | null;
  /** Vision radius in tiles (fog of war). */
  sight: number;
  /** Minimum age required to build this (Phase 6); 1 = available from the start. */
  ageRequired: number;
  label: string;
  /**
   * Defensive attack (watch_tower only): when present, the building fires at
   * enemies in range (handled by TowerSystem). Absent for non-combat buildings.
   */
  attack?: number;
  /** Attack range in tiles (towers). */
  range?: number;
  /** Seconds between shots (towers). */
  attackCooldown?: number;
}

export const BUILDING_DEFS: Record<BuildingKind, BuildingDef> = {
  town_center: { w: 3, h: 3, cost: {}, buildTicks: 0, maxHp: 600, pop: 5, accepts: ["food", "wood", "gold", "stone"], trains: "villager", sight: 7, ageRequired: 1, label: "Town Center" },
  house: { w: 2, h: 2, cost: { wood: 30 }, buildTicks: 50, maxHp: 200, pop: 5, accepts: [], trains: null, sight: 4, ageRequired: 1, label: "House" },
  barracks: { w: 3, h: 3, cost: { wood: 120 }, buildTicks: 120, maxHp: 500, pop: 0, accepts: [], trains: "spearman", sight: 5, ageRequired: 1, label: "Barracks" },
  archery_range: { w: 3, h: 3, cost: { wood: 175 }, buildTicks: 120, maxHp: 500, pop: 0, accepts: [], trains: "archer", sight: 5, ageRequired: 1, label: "Archery Range" },
  lumber_camp: { w: 2, h: 2, cost: { wood: 80 }, buildTicks: 35, maxHp: 300, pop: 0, accepts: ["wood"], trains: null, sight: 4, ageRequired: 1, label: "Lumber Camp" },
  mining_camp: { w: 2, h: 2, cost: { wood: 80 }, buildTicks: 35, maxHp: 300, pop: 0, accepts: ["gold", "stone"], trains: null, sight: 4, ageRequired: 1, label: "Mining Camp" },
  mill: { w: 2, h: 2, cost: { wood: 80 }, buildTicks: 35, maxHp: 300, pop: 0, accepts: ["food"], trains: null, sight: 4, ageRequired: 1, label: "Mill" },
  blacksmith: { w: 3, h: 3, cost: { wood: 150 }, buildTicks: 100, maxHp: 500, pop: 0, accepts: [], trains: null, sight: 4, ageRequired: 2, label: "Blacksmith" },
  watch_tower: { w: 2, h: 2, cost: { wood: 50, stone: 100 }, buildTicks: 80, maxHp: 400, pop: 0, accepts: [], trains: null, sight: 8, ageRequired: 2, label: "Watch Tower", attack: 5, range: 6, attackCooldown: 1.5 },
};

/** Build points one builder contributes per second (× dt per tick). */
export const BUILD_RATE = 20;
/**
 * Building kinds the player can place (the Town Center is the pre-placed start).
 * The Build menu further filters these by the player's current age
 * (`ageRequired`), so age-2 buildings only appear once you've advanced.
 */
export const BUILDABLE_KINDS: readonly BuildingKind[] = [
  "house",
  "barracks",
  "archery_range",
  "blacksmith",
  "watch_tower",
  "lumber_camp",
  "mining_camp",
  "mill",
];
/** Hard population ceiling regardless of houses. */
export const MAX_POP = 200;

// ---------------------------------------------------------------------------
// Phase 4 — Combat
// ---------------------------------------------------------------------------

/**
 * Per-unit combat state. Every unit carries one. `target` is the entity being
 * attacked (a unit or building of another owner); `ordered` distinguishes an
 * explicit attack order (chase it down) from an auto-acquired target (dropped
 * once out of aggro range). `attackMove` is the destination for an attack-move
 * order — walk toward it, but engage enemies met en route.
 */
export interface Combat {
  /** Seconds until this unit may attack again. */
  cooldown: number;
  target: number | null;
  ordered: boolean;
  attackMove: GridPoint | null;
}

/**
 * Who fired an attack, for the counter-bonus lookup. A `"tower"` (a building
 * attacker, Phase 6) has no unit kind and gets no counter bonus.
 */
export type AttackerKind = UnitKind | "tower";

/**
 * An in-flight projectile (arrow). Has its own Transform for the current world
 * position; this component carries flight + payload data. Homes on `target`'s
 * live position, falling back to the snapshot point (gx, gy) if it dies.
 */
export interface Projectile {
  target: number | null;
  /** Fallback impact world point (target position at fire time). */
  gx: number;
  gy: number;
  /** World units per second. */
  speed: number;
  /** Attacker's attack value and kind (for the counter-bonus at impact). */
  attack: number;
  attackerKind: AttackerKind;
  owner: number;
}

export const CCombat = defineComponent<Combat>("Combat");
export const CProjectile = defineComponent<Projectile>("Projectile");

/** Idle units auto-acquire enemies within this many tiles (Chebyshev). */
export const AGGRO_RANGE = 5;
/** Arrow flight speed (world units/sec). */
export const PROJECTILE_SPEED = 320;
/** How close (world units) a projectile must get to its target to impact. */
export const PROJECTILE_HIT_DIST = 12;

/**
 * Counter bonus damage: attacker kind -> defender kind -> extra damage applied
 * on top of the base (attack − armor) calc. Small but extensible (Phase 6 adds
 * cavalry, etc.). Spearmen punch up against archers in melee; archers harry
 * villagers.
 */
export const DAMAGE_BONUS: Partial<Record<AttackerKind, Partial<Record<UnitKind, number>>>> = {
  spearman: { archer: 3 },
  archer: { villager: 2 },
};

// ---------------------------------------------------------------------------
// Phase 6 — Tech tree & ages
// ---------------------------------------------------------------------------

/** Ages: 1 = Stone, 2 = Bronze, 3 = Iron. The match starts in age 1. */
export const MAX_AGE = 3;
export const AGE_NAMES: Record<number, string> = { 1: "Stone Age", 2: "Bronze Age", 3: "Iron Age" };

export type UpgradeId =
  | "advance_bronze"
  | "advance_iron"
  | "forging"
  | "scale_armor"
  | "fletching"
  | "wheelbarrow"
  | "iron_casting";

export type UpgradeStat = "attack" | "armor" | "pierceArmor" | "gatherRate";
/** Which units/buildings an upgrade applies to. */
export type UpgradeScope =
  | "all"
  | "military"
  | "melee"
  | "ranged"
  | "villager"
  | "tower"
  | "gather";

/**
 * One stat effect of a researched upgrade. `add` is a flat addend, except for
 * `gatherRate` where it's a fractional multiplier (0.25 = +25%).
 */
export interface UpgradeEffect {
  stat: UpgradeStat;
  scope: UpgradeScope;
  add: number;
}

export interface UpgradeDef {
  id: UpgradeId;
  label: string;
  /** The building kind it's researched at. */
  building: BuildingKind;
  /** Minimum age to research it. */
  ageRequired: number;
  cost: Partial<Record<ResourceKind, number>>;
  /** Research time in ticks. */
  researchTicks: number;
  /** Prerequisite upgrade that must be researched first, or null. */
  requires: UpgradeId | null;
  /** Stat effects applied on completion (empty for a pure age advance). */
  effects: readonly UpgradeEffect[];
  /** If set, completing this advances the player to this age. */
  setsAge?: number;
}

/**
 * The full tech tree (Phase 6). Two age advances (at the Town Center) plus a
 * focused upgrade set at the Blacksmith + Town Center. Data-driven: adding a tech
 * is a table edit. `requires` chains stacking lines (forging → iron_casting).
 */
export const UPGRADE_DEFS: Record<UpgradeId, UpgradeDef> = {
  advance_bronze: { id: "advance_bronze", label: "Advance to Bronze Age", building: "town_center", ageRequired: 1, cost: { food: 400 }, researchTicks: 200, requires: null, effects: [], setsAge: 2 },
  advance_iron: { id: "advance_iron", label: "Advance to Iron Age", building: "town_center", ageRequired: 2, cost: { food: 600, gold: 300 }, researchTicks: 300, requires: "advance_bronze", effects: [], setsAge: 3 },
  forging: { id: "forging", label: "Forging (+1 melee atk)", building: "blacksmith", ageRequired: 2, cost: { food: 150 }, researchTicks: 120, requires: null, effects: [{ stat: "attack", scope: "melee", add: 1 }] },
  scale_armor: { id: "scale_armor", label: "Scale Armor (+1 armor)", building: "blacksmith", ageRequired: 2, cost: { food: 100, gold: 50 }, researchTicks: 120, requires: null, effects: [{ stat: "armor", scope: "military", add: 1 }, { stat: "pierceArmor", scope: "military", add: 1 }] },
  fletching: { id: "fletching", label: "Fletching (+1 ranged atk)", building: "blacksmith", ageRequired: 2, cost: { wood: 120, gold: 50 }, researchTicks: 120, requires: null, effects: [{ stat: "attack", scope: "ranged", add: 1 }] },
  wheelbarrow: { id: "wheelbarrow", label: "Wheelbarrow (+25% gather)", building: "town_center", ageRequired: 2, cost: { food: 175, wood: 50 }, researchTicks: 150, requires: null, effects: [{ stat: "gatherRate", scope: "gather", add: 0.25 }] },
  iron_casting: { id: "iron_casting", label: "Iron Casting (+1 melee atk)", building: "blacksmith", ageRequired: 3, cost: { food: 220, gold: 120 }, researchTicks: 150, requires: "forging", effects: [{ stat: "attack", scope: "melee", add: 1 }] },
};

/** A research in progress at a building (one at a time, like a train queue). */
export interface Research {
  id: UpgradeId;
  progress: number;
  required: number;
}

/** Watch-tower attack cooldown state (the building-attacker analogue of Combat). */
export interface Tower {
  cooldown: number;
}

export const CResearch = defineComponent<Research>("Research");
export const CTower = defineComponent<Tower>("Tower");
