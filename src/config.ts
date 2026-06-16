/**
 * Global tuning constants. Pure data — no logic, no imports.
 * Anything that affects the deterministic simulation lives here so balance
 * passes in later phases happen in one place.
 */

/** Simulation runs at a fixed rate, decoupled from the render framerate. */
export const TICKS_PER_SECOND = 20;
export const TICK_MS = 1000 / TICKS_PER_SECOND;
/** Fixed delta handed to the sim each tick, in seconds. */
export const TICK_DT = 1 / TICKS_PER_SECOND;

/**
 * Upper bound on sim ticks processed per rendered frame — a genuine work cap
 * for when a single tick (heavy pathfinding/combat in later phases) can't keep
 * up with real time. Excess accumulated time beyond this is dropped (and
 * counted) rather than spiralling.
 */
export const MAX_TICKS_PER_FRAME = 5;

/**
 * Largest real frame delta the loop will honour before clamping. Deliberately
 * larger than MAX_TICKS_PER_FRAME * TICK_DT so the work cap above can actually
 * engage (and report) instead of being masked by this clamp.
 */
export const MAX_FRAME_DT = 0.5;

/** Isometric tile footprint in world units (2:1 diamond). */
export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_TILE_W = TILE_W / 2;
export const HALF_TILE_H = TILE_H / 2;

/** Default map dimensions (in tiles) for Phase 0. */
export const DEFAULT_MAP_W = 64;
export const DEFAULT_MAP_H = 64;

/** Camera zoom limits and behaviour. */
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 1.1;
/**
 * Reference wheel travel for one zoom step. Input normalizes every wheel event
 * to pixels (handling Firefox line-mode / page-mode) so this constant holds
 * across browsers.
 */
export const WHEEL_NOTCH_PX = 100;
/** Assumed pixel height of one wheel "line" when deltaMode === DOM_DELTA_LINE. */
export const WHEEL_LINE_PX = 16;

/** Camera pan speed in world units per second (at zoom = 1). */
export const PAN_SPEED = 900;
/** Distance from the window edge (px) that triggers edge-scroll. */
export const EDGE_SCROLL_MARGIN = 24;

/** Deterministic world seed for Phase 0. Match-setup will override later. */
export const DEFAULT_SEED = 1337;

/**
 * Offset mixed into the seed to derive the simulation RNG from the map-gen RNG,
 * so the two streams are independent (see Game). Golden-ratio constant.
 */
export const SIM_SEED_OFFSET = 0x9e3779b9;
