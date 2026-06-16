import { GameMap } from "@/map/GameMap";
import type { Terrain } from "@/map/Terrain";
import type { Random } from "@/core/Random";

/**
 * Deterministic placeholder map generator for Phase 0. Lays down grass, then
 * stamps a handful of seeded "blobs" (water, forest, hills) plus scattered
 * stone/gold deposits, so there's varied terrain to pan over and verify the
 * renderer. Same seed -> identical map. This will be replaced by a proper
 * symmetric/resource-balanced generator in a later phase.
 */
export function generateMap(width: number, height: number, rng: Random): GameMap {
  const tiles: Terrain[] = new Array<Terrain>(width * height).fill("grass");

  const idx = (tx: number, ty: number): number => ty * width + tx;
  const inBounds = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < width && ty < height;

  /** Paint a rough filled disc of `terrain`, edges jittered for a natural look. */
  const stampBlob = (cx: number, cy: number, radius: number, terrain: Terrain): void => {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (!inBounds(tx, ty)) continue;
        const d2 = dx * dx + dy * dy;
        // Soft edge: tiles near the rim are only sometimes painted.
        if (d2 <= r2 * 0.7 || (d2 <= r2 && rng.chance(0.55))) {
          tiles[idx(tx, ty)] = terrain;
        }
      }
    }
  };

  // A lake or two.
  const lakes = rng.int(1, 2);
  for (let i = 0; i < lakes; i++) {
    stampBlob(rng.int(8, width - 8), rng.int(8, height - 8), rng.int(4, 7), "water");
  }

  // Forests.
  const forests = rng.int(5, 8);
  for (let i = 0; i < forests; i++) {
    stampBlob(rng.int(4, width - 4), rng.int(4, height - 4), rng.int(2, 5), "forest");
  }

  // Hill ranges.
  const hills = rng.int(3, 5);
  for (let i = 0; i < hills; i++) {
    stampBlob(rng.int(4, width - 4), rng.int(4, height - 4), rng.int(2, 4), "hills");
  }

  // Scattered stone and gold deposits (small clusters).
  const deposits: Array<{ terrain: Terrain; count: number; size: number }> = [
    { terrain: "stone", count: rng.int(3, 5), size: 2 },
    { terrain: "gold", count: rng.int(3, 5), size: 2 },
  ];
  for (const { terrain, count, size } of deposits) {
    for (let i = 0; i < count; i++) {
      stampBlob(rng.int(2, width - 2), rng.int(2, height - 2), size, terrain);
    }
  }

  return new GameMap(width, height, tiles);
}
