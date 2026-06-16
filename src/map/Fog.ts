/**
 * Fog of war for ONE viewing player (the human in Phase 4). Per tile:
 *  - explored: ever seen (sticky — remembers terrain + static buildings).
 *  - visible: currently within sight of one of the player's units/buildings
 *    (recomputed every tick).
 *
 * Derived state, rebuilt from entity positions each tick — NOT serialized.
 * (Explored history resets on load, which is acceptable for now.)
 */
export class Fog {
  readonly width: number;
  readonly height: number;
  private readonly explored: Uint8Array;
  private readonly visible: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.explored = new Uint8Array(width * height);
    this.visible = new Uint8Array(width * height);
  }

  private inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  /** Clear the currently-visible set (call before re-revealing each tick). */
  clearVisible(): void {
    this.visible.fill(0);
  }

  /** Mark a tile visible (and explored). */
  reveal(tx: number, ty: number): void {
    if (!this.inBounds(tx, ty)) return;
    const i = ty * this.width + tx;
    this.visible[i] = 1;
    this.explored[i] = 1;
  }

  isVisible(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return false;
    return this.visible[ty * this.width + tx] === 1;
  }

  isExplored(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return false;
    return this.explored[ty * this.width + tx] === 1;
  }
}
