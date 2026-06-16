import type { GameMap } from "@/map/GameMap";
import { TERRAIN } from "@/map/Terrain";

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
 * Pack (tx, ty) into a single non-negative integer id usable as a Map key /
 * typed-array index. Tiles are non-negative and bounded by the map, so a simple
 * row-major fold `ty * width + tx` is collision-free and order-stable, which we
 * also rely on for deterministic heap tie-breaking.
 */
export function packId(tx: number, ty: number, width: number): number {
  return ty * width + tx;
}
