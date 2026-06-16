/**
 * A grid of tiles blocked by placed objects (building footprints), separate
 * from static terrain walkability. Pathfinding and movement consult BOTH this
 * and the terrain: a tile is standable only if the terrain is walkable AND it
 * isn't occupied here.
 *
 * Derived state — rebuildable from the building entities — so it need not be
 * serialized; Game repopulates it on load. In Phase 2 buildings are static
 * (pre-placed), so this is built once at startup.
 */
export class Occupancy {
  readonly width: number;
  readonly height: number;
  private readonly blocked: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.blocked = new Uint8Array(width * height);
  }

  private inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  isBlocked(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return true; // off-map reads as blocked
    return this.blocked[ty * this.width + tx] === 1;
  }

  set(tx: number, ty: number, value: boolean): void {
    if (!this.inBounds(tx, ty)) return;
    this.blocked[ty * this.width + tx] = value ? 1 : 0;
  }

  /** Block (or clear) a `w`×`h` footprint with origin (tx, ty). */
  setRect(tx: number, ty: number, w: number, h: number, value: boolean): void {
    for (let y = ty; y < ty + h; y++) {
      for (let x = tx; x < tx + w; x++) {
        this.set(x, y, value);
      }
    }
  }

  clear(): void {
    this.blocked.fill(0);
  }
}
