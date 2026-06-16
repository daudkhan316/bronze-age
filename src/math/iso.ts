import { HALF_TILE_W, HALF_TILE_H } from "@/config";
import type { Vec2 } from "@/math/Vec2";

/**
 * Isometric projection helpers.
 *
 * Two coordinate spaces:
 *  - GRID space:  integer (or fractional) tile coordinates (gx, gy).
 *  - WORLD space: the projected 2D plane the camera looks at, in pixels at zoom 1.
 *
 * Camera/screen space is handled separately in render/Camera.ts. Keeping the
 * iso projection independent of the camera means tile picking and rendering
 * share exactly one source of truth for the diamond geometry.
 */

/** Grid tile coordinate (may be fractional during picking). */
export interface Grid {
  gx: number;
  gy: number;
}

/** An integer tile coordinate (a cell in the map grid). */
export interface GridPoint {
  tx: number;
  ty: number;
}

/** Project a grid coordinate to a point in world space (tile centre at .5,.5). */
export const gridToWorld = (gx: number, gy: number): Vec2 => ({
  x: (gx - gy) * HALF_TILE_W,
  y: (gx + gy) * HALF_TILE_H,
});

/** Inverse projection: world-space point -> fractional grid coordinate. */
export const worldToGrid = (wx: number, wy: number): Grid => {
  const a = wx / HALF_TILE_W;
  const b = wy / HALF_TILE_H;
  return {
    gx: (a + b) / 2,
    gy: (b - a) / 2,
  };
};

/** Tile index under a world-space point (floored fractional grid coord). */
export const worldToTile = (wx: number, wy: number): GridPoint => {
  const g = worldToGrid(wx, wy);
  return { tx: Math.floor(g.gx), ty: Math.floor(g.gy) };
};

/** World-space position of the centre of tile (tx, ty). */
export const tileCenterWorld = (tx: number, ty: number): Vec2 => gridToWorld(tx + 0.5, ty + 0.5);

/**
 * The four world-space corners of tile (tx, ty), clockwise from the top vertex.
 * Used to draw the diamond and to cull tiles against the viewport.
 */
export const tileCorners = (tx: number, ty: number): [Vec2, Vec2, Vec2, Vec2] => {
  const top = gridToWorld(tx, ty);
  const right = gridToWorld(tx + 1, ty);
  const bottom = gridToWorld(tx + 1, ty + 1);
  const left = gridToWorld(tx, ty + 1);
  return [top, right, bottom, left];
};
