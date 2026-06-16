import type { GameMap } from "@/map/GameMap";
import type { GridPoint } from "@/math/iso";
import { TERRAIN } from "@/map/Terrain";

/** Anything that can report whether a tile is dynamically blocked (see Occupancy). */
export interface BlockedQuery {
  isBlocked(tx: number, ty: number): boolean;
}

/**
 * Grid walkability + node-id packing helpers shared by the A* search.
 *
 * Kept separate from astar.ts so the cheap "can a unit stand here?" predicate
 * can be imported on its own (e.g. by movement/selection code) without pulling
 * in the search machinery.
 */

/**
 * A tile is walkable iff it is on the map AND its terrain is flagged walkable.
 * `GameMap.get` returns `undefined` for out-of-bounds tiles, which we treat as
 * blocked — the edge of the world is an impassable wall.
 */
export function isWalkable(map: GameMap, tx: number, ty: number): boolean {
  const terrain = map.get(tx, ty);
  if (terrain === undefined) return false;
  return TERRAIN[terrain].walkable;
}

/**
 * A unit can stand on a tile iff the terrain is walkable AND it isn't blocked by
 * a placed object (building footprint). `occ` is optional so pure-terrain
 * callers (and Phase 1 code) keep working unchanged.
 */
export function canStand(map: GameMap, tx: number, ty: number, occ?: BlockedQuery): boolean {
  if (!isWalkable(map, tx, ty)) return false;
  return occ === undefined || !occ.isBlocked(tx, ty);
}

/**
 * Nearest standable tile to (tx, ty) via an outward ring scan (deterministic
 * order), or null within `maxRadius`. Used to find an approach tile beside a
 * resource node / building, or a spawn tile next to a Town Center.
 */
export function standableTileNear(
  map: GameMap,
  tx: number,
  ty: number,
  occ?: BlockedQuery,
  maxRadius = 16,
): GridPoint | null {
  if (canStand(map, tx, ty, occ)) return { tx, ty };
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // current ring only
        if (canStand(map, tx + dx, ty + dy, occ)) return { tx: tx + dx, ty: ty + dy };
      }
    }
  }
  return null;
}

/**
 * Pack (tx, ty) into a single non-negative integer id usable as a Map key /
 * typed-array index. Tiles are non-negative and bounded by the map, so a simple
 * row-major fold `ty * width + tx` is collision-free and order-stable, which we
 * also rely on for deterministic heap tie-breaking.
 */
export function packId(tx: number, ty: number, width: number): number {
  return ty * width + tx;
}
