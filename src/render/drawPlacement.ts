import type { Camera } from "@/render/Camera";
import type { PlacementGhost } from "@/placement/PlacementController";
import type { BuildingKind } from "@/game/components";
import { gridToWorld } from "@/math/iso";

/**
 * Placement ghost overlay — drawn LAST, on top of the depth-sorted world, so the
 * player always sees where a building will land while in placement mode.
 *
 * Two layers:
 *  1) Each footprint tile, tinted GREEN (valid) or RED (invalid).
 *  2) A translucent isometric silhouette of the building body, so the player
 *     can read the kind/size, not just the floor area.
 *
 * Pure rendering: reads only the ghost + camera, mutates nothing, brackets every
 * style change in save/restore. Screen projection goes grid -> world -> screen
 * via the same gridToWorld + camera.worldToScreen used by drawWorld, so the
 * ghost lines up exactly with the terrain diamonds and real buildings.
 *
 * CONTRACT (provided by @/placement/PlacementController — verified to match):
 *   interface PlacementGhost {
 *     kind: BuildingKind;       // which building silhouette to draw
 *     tx: number; ty: number;   // footprint origin tile (top/north tile)
 *     w: number; h: number;     // footprint size in tiles
 *     valid: boolean;           // true => green, false => red
 *   }
 * Tint is validity-driven (green/red), not owner-tinted: a ghost is always the
 * local player's pending placement.
 */

/** Wall (body) height in world units at zoom 1, before the per-kind multiplier. */
const BASE_WALL_HEIGHT = 26;
/** Roof rise above the wall top, in world units at zoom 1. */
const BASE_ROOF_HEIGHT = 22;

interface ScreenPt {
  readonly sx: number;
  readonly sy: number;
}

/** Validity colours: a calm green for OK, a warning red for blocked. */
const VALID = { tile: "rgba(86,220,110,0.32)", body: "rgba(86,220,110,0.45)", line: "#3fbf5f" };
const INVALID = { tile: "rgba(228,75,75,0.34)", body: "rgba(228,75,75,0.5)", line: "#cf3b3b" };

export function drawPlacementGhost(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  ghost: PlacementGhost | null,
): void {
  if (ghost === null) return;

  const { kind, tx, ty, w, h, valid } = ghost;
  const palette = valid ? VALID : INVALID;
  const z = camera.zoom;

  // 1) Per-tile floor tint: one diamond per footprint cell.
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = Math.max(1, 1.2 * z);
  for (let gy = ty; gy < ty + h; gy++) {
    for (let gx = tx; gx < tx + w; gx++) {
      const top = projectGrid(camera, gx, gy);
      const right = projectGrid(camera, gx + 1, gy);
      const bottom = projectGrid(camera, gx + 1, gy + 1);
      const left = projectGrid(camera, gx, gy + 1);
      ctx.beginPath();
      ctx.moveTo(top.sx, top.sy);
      ctx.lineTo(right.sx, right.sy);
      ctx.lineTo(bottom.sx, bottom.sy);
      ctx.lineTo(left.sx, left.sy);
      ctx.closePath();
      ctx.fillStyle = palette.tile;
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();

  // 2) Translucent building silhouette over the whole footprint.
  drawGhostBody(ctx, camera, kind, tx, ty, w, h, palette.body, palette.line, z);
}

/**
 * A simplified, translucent version of the real building body: two wall faces,
 * the wall top, and a pyramid roof. No flag/details — it's a preview, kept light
 * so the underlying terrain and validity tint stay readable.
 */
function drawGhostBody(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  kind: BuildingKind,
  tx: number,
  ty: number,
  w: number,
  h: number,
  bodyFill: string,
  lineColor: string,
  z: number,
): void {
  const grand = kindScale(kind);
  const wallH = BASE_WALL_HEIGHT * grand * z;
  const roofH = BASE_ROOF_HEIGHT * grand * z;

  const top = projectGrid(camera, tx, ty);
  const right = projectGrid(camera, tx + w, ty);
  const bottom = projectGrid(camera, tx + w, ty + h);
  const left = projectGrid(camera, tx, ty + h);

  const topT = lift(top, wallH);
  const rightT = lift(right, wallH);
  const bottomT = lift(bottom, wallH);
  const leftT = lift(left, wallH);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, 1.2 * z);
  ctx.strokeStyle = lineColor;
  ctx.fillStyle = bodyFill;

  // Left + right wall faces.
  fillQuad(ctx, left, bottom, bottomT, leftT);
  fillQuad(ctx, right, bottom, bottomT, rightT);

  // Wall top diamond.
  ctx.beginPath();
  ctx.moveTo(topT.sx, topT.sy);
  ctx.lineTo(rightT.sx, rightT.sy);
  ctx.lineTo(bottomT.sx, bottomT.sy);
  ctx.lineTo(leftT.sx, leftT.sy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Pyramid roof.
  const apex: ScreenPt = {
    sx: (topT.sx + bottomT.sx) / 2,
    sy: (topT.sy + bottomT.sy) / 2 - roofH,
  };
  fillTri(ctx, leftT, bottomT, apex);
  fillTri(ctx, rightT, bottomT, apex);
  fillTri(ctx, leftT, topT, apex);
  fillTri(ctx, rightT, topT, apex);

  ctx.restore();
}

/** Mirror of drawWorld's per-kind height so the preview matches the real body. */
function kindScale(kind: BuildingKind): number {
  switch (kind) {
    case "town_center":
      return 1.35;
    case "barracks":
    case "archery_range":
      return 1.3;
    case "house":
    case "lumber_camp":
    case "mining_camp":
    case "mill":
      return 1.0;
    default:
      return 1;
  }
}

function projectGrid(camera: Camera, gx: number, gy: number): ScreenPt {
  const w = gridToWorld(gx, gy);
  return camera.worldToScreen(w.x, w.y);
}

function lift(p: ScreenPt, dy: number): ScreenPt {
  return { sx: p.sx, sy: p.sy - dy };
}

function fillQuad(
  ctx: CanvasRenderingContext2D,
  a: ScreenPt,
  b: ScreenPt,
  c: ScreenPt,
  d: ScreenPt,
): void {
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
  ctx.lineTo(c.sx, c.sy);
  ctx.lineTo(d.sx, d.sy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function fillTri(
  ctx: CanvasRenderingContext2D,
  a: ScreenPt,
  b: ScreenPt,
  c: ScreenPt,
): void {
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
  ctx.lineTo(c.sx, c.sy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
