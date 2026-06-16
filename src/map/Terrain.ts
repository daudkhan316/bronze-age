/**
 * Terrain types. String literals (not a numeric enum) so the map serializes to
 * readable JSON and survives save/load without a lookup table.
 */
export type Terrain = "grass" | "water" | "forest" | "hills" | "stone" | "gold";

export const TERRAIN_TYPES: readonly Terrain[] = [
  "grass",
  "water",
  "forest",
  "hills",
  "stone",
  "gold",
];

export interface TerrainInfo {
  /** Can land units walk across it? (Phase 1+ pathfinding.) */
  readonly walkable: boolean;
  /** Can buildings be placed on it? */
  readonly buildable: boolean;
  /** Resource a gatherer can extract here, if any (Phase 2+). */
  readonly resource: "wood" | "stone" | "gold" | null;
}

export const TERRAIN: Record<Terrain, TerrainInfo> = {
  grass: { walkable: true, buildable: true, resource: null },
  water: { walkable: false, buildable: false, resource: null },
  forest: { walkable: false, buildable: false, resource: "wood" },
  hills: { walkable: true, buildable: true, resource: null },
  stone: { walkable: false, buildable: false, resource: "stone" },
  gold: { walkable: false, buildable: false, resource: "gold" },
};
