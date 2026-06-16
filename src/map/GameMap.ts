import type { Terrain } from "@/map/Terrain";

/**
 * The terrain grid. Stored row-major in a flat array for cache-friendly access.
 * Out-of-bounds reads return `undefined` (strict mode forces callers to handle
 * the edge of the world explicitly).
 */
export class GameMap {
  readonly width: number;
  readonly height: number;
  private readonly tiles: Terrain[];

  constructor(width: number, height: number, tiles: Terrain[]) {
    if (tiles.length !== width * height) {
      throw new Error(`GameMap: expected ${width * height} tiles, got ${tiles.length}`);
    }
    this.width = width;
    this.height = height;
    this.tiles = tiles;
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  get(tx: number, ty: number): Terrain | undefined {
    if (!this.inBounds(tx, ty)) return undefined;
    return this.tiles[ty * this.width + tx];
  }

  set(tx: number, ty: number, terrain: Terrain): void {
    if (!this.inBounds(tx, ty)) return;
    this.tiles[ty * this.width + tx] = terrain;
  }

  /** Flat tile array (read-only view) for serialization. */
  get data(): readonly Terrain[] {
    return this.tiles;
  }
}
