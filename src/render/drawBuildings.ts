import type { Camera } from "@/render/Camera";
import type { World } from "@/ecs/World";
import type { Building, BuildingKind } from "@/game/components";
import { CBuilding, CTransform } from "@/game/components";
import { gridToWorld } from "@/math/iso";

/**
 * Draws every placed building as an isometric block sitting on its w×h tile
 * footprint. The footprint diamond is projected from grid space (so it lines up
 * exactly with the terrain tiles), then a simple extruded body and roof are
 * stacked above it, tinted by owner. Town Centers are taller and grander than
 * Houses. Pure rendering: reads the world, mutates no simulation state, and
 * brackets every style change in save/restore.
 */

/** Cull margin in world units — a building body can rise ~2 tiles above its base. */
const CULL_MARGIN_WORLD = 160;

/** Wall (body) height in world units at zoom 1, before the per-kind multiplier. */
const BASE_WALL_HEIGHT = 26;

/** Roof rise above the wall top, in world units at zoom 1. */
const BASE_ROOF_HEIGHT = 22;

interface ScreenPt {
  readonly sx: number;
  readonly sy: number;
}

/** Owner body fill: owner 0 is a friendly blue-grey, everything else neutral tan. */
function bodyFill(owner: number): string {
  return owner === 0 ? "#7d93a8" : "#b9a888";
}

/** Slightly darker shade of the body fill, used for the shaded/right wall face. */
function bodyShade(owner: number): string {
  return owner === 0 ? "#5f7387" : "#998a6c";
}

/** Roof fill, a warmer accent that contrasts with the walls. */
function roofFill(owner: number): string {
  return owner === 0 ? "#3f566b" : "#7a5b3a";
}

/** Outline colour for crisp silhouettes against terrain. */
const OUTLINE = "#1b232b";

export function drawBuildings(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  world: World,
): void {
  const z = camera.zoom;
  const marginPx = CULL_MARGIN_WORLD * z;

  for (const [e, b] of world.query(CBuilding)) {
    // CTransform is the footprint centre; use it purely for the cull test, the
    // geometry itself is derived from the grid footprint so it stays tile-exact.
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;

    const centre = camera.worldToScreen(tr.x, tr.y);
    if (
      centre.sx < -marginPx ||
      centre.sx > camera.viewW + marginPx ||
      centre.sy < -marginPx ||
      centre.sy > camera.viewH + marginPx
    ) {
      continue;
    }

    drawBuilding(ctx, camera, b, z);
  }
}

/**
 * Draws one building: footprint diamond, two extruded wall faces, the wall top,
 * and a pitched roof, plus a small flag accent on the apex.
 */
function drawBuilding(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  b: Building,
  z: number,
): void {
  const grand = kindScale(b.kind);
  const wallH = BASE_WALL_HEIGHT * grand * z;
  const roofH = BASE_ROOF_HEIGHT * grand * z;

  // Footprint corners in grid space, clockwise from the top (north) vertex:
  // top, right, bottom, left. gridToWorld -> worldToScreen keeps them aligned
  // with the terrain diamonds drawn by drawMap.
  const top = projectGrid(camera, b.tx, b.ty);
  const right = projectGrid(camera, b.tx + b.w, b.ty);
  const bottom = projectGrid(camera, b.tx + b.w, b.ty + b.h);
  const left = projectGrid(camera, b.tx, b.ty + b.h);

  const fill = bodyFill(b.owner);
  const shade = bodyShade(b.owner);
  const lineW = Math.max(1, 1.4 * z);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = lineW;
  ctx.strokeStyle = OUTLINE;

  // 1) Ground footprint diamond (a faint base so the building reads as planted).
  ctx.beginPath();
  ctx.moveTo(top.sx, top.sy);
  ctx.lineTo(right.sx, right.sy);
  ctx.lineTo(bottom.sx, bottom.sy);
  ctx.lineTo(left.sx, left.sy);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.fill();

  // Raised wall-top corners (footprint corners lifted by wallH on screen Y).
  const topT = lift(top, wallH);
  const rightT = lift(right, wallH);
  const bottomT = lift(bottom, wallH);
  const leftT = lift(left, wallH);

  // 2) Left wall face (left edge of footprint: left -> bottom), the shaded side.
  ctx.beginPath();
  ctx.moveTo(left.sx, left.sy);
  ctx.lineTo(bottom.sx, bottom.sy);
  ctx.lineTo(bottomT.sx, bottomT.sy);
  ctx.lineTo(leftT.sx, leftT.sy);
  ctx.closePath();
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.stroke();

  // 3) Right wall face (right edge: right -> bottom), the lit side.
  ctx.beginPath();
  ctx.moveTo(right.sx, right.sy);
  ctx.lineTo(bottom.sx, bottom.sy);
  ctx.lineTo(bottomT.sx, bottomT.sy);
  ctx.lineTo(rightT.sx, rightT.sy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();

  // 4) Wall top diamond (the roof base footprint, lifted).
  ctx.beginPath();
  ctx.moveTo(topT.sx, topT.sy);
  ctx.lineTo(rightT.sx, rightT.sy);
  ctx.lineTo(bottomT.sx, bottomT.sy);
  ctx.lineTo(leftT.sx, leftT.sy);
  ctx.closePath();
  ctx.fillStyle = lighten(fill);
  ctx.fill();
  ctx.stroke();

  // 5) Roof: a pyramid apex above the wall-top centre.
  const apexX = (topT.sx + bottomT.sx) / 2;
  const apexY = (topT.sy + bottomT.sy) / 2 - roofH;
  const apex: ScreenPt = { sx: apexX, sy: apexY };

  const roof = roofFill(b.owner);
  // Front-left roof slope (leftT -> bottomT -> apex), shaded.
  fillTri(ctx, leftT, bottomT, apex, darken(roof));
  // Front-right roof slope (rightT -> bottomT -> apex), lit.
  fillTri(ctx, rightT, bottomT, apex, roof);
  // Back slopes, drawn so the silhouette closes cleanly.
  fillTri(ctx, leftT, topT, apex, darken(roof));
  fillTri(ctx, rightT, topT, apex, roof);

  // 6) Flag accent on the apex (a tiny pole + pennant tinted by owner).
  drawFlag(ctx, apex, roofH, b.owner, z);

  ctx.restore();
}

/** Town Centers are noticeably bigger/taller than houses. */
function kindScale(kind: BuildingKind): number {
  switch (kind) {
    case "town_center":
      return 1.35;
    case "house":
      return 1.0;
    default:
      return assertNever(kind);
  }
}

/** Project a grid corner to screen space (grid -> world -> screen). */
function projectGrid(camera: Camera, gx: number, gy: number): ScreenPt {
  const w = gridToWorld(gx, gy);
  return camera.worldToScreen(w.x, w.y);
}

/** Lift a screen point straight up by `h` pixels (extrusion is screen-vertical). */
function lift(p: ScreenPt, h: number): ScreenPt {
  return { sx: p.sx, sy: p.sy - h };
}

/** Fill an outlined triangle from three screen points. */
function fillTri(
  ctx: CanvasRenderingContext2D,
  a: ScreenPt,
  b: ScreenPt,
  c: ScreenPt,
  fill: string,
): void {
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
  ctx.lineTo(c.sx, c.sy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

/** A small pole-and-pennant flag rising from the roof apex. */
function drawFlag(
  ctx: CanvasRenderingContext2D,
  apex: ScreenPt,
  roofH: number,
  owner: number,
  z: number,
): void {
  const poleH = Math.max(4, roofH * 0.5);
  const poleTopY = apex.sy - poleH;

  ctx.save();
  ctx.lineWidth = Math.max(1, 1.2 * z);
  ctx.strokeStyle = OUTLINE;

  // Pole.
  ctx.beginPath();
  ctx.moveTo(apex.sx, apex.sy);
  ctx.lineTo(apex.sx, poleTopY);
  ctx.stroke();

  // Pennant: a small triangle off the top of the pole, tinted by owner.
  const flagW = Math.max(4, 6 * z);
  const flagH = Math.max(3, 4 * z);
  ctx.beginPath();
  ctx.moveTo(apex.sx, poleTopY);
  ctx.lineTo(apex.sx + flagW, poleTopY + flagH * 0.5);
  ctx.lineTo(apex.sx, poleTopY + flagH);
  ctx.closePath();
  ctx.fillStyle = owner === 0 ? "#3fb6e6" : "#e34b4b";
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Lighten a #rrggbb hex toward white by a fixed amount (for the lit wall top). */
function lighten(hex: string): string {
  return mix(hex, 255, 0.18);
}

/** Darken a #rrggbb hex toward black by a fixed amount (for shaded roof slopes). */
function darken(hex: string): string {
  return mix(hex, 0, 0.22);
}

/** Blend each channel of a #rrggbb hex toward `target` (0..255) by `t` (0..1). */
function mix(hex: string, target: number, t: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const bch = parseInt(hex.slice(5, 7), 16);
  const blend = (c: number): number => Math.round(c + (target - c) * t);
  const to2 = (c: number): string => clampByte(c).toString(16).padStart(2, "0");
  return `#${to2(blend(r))}${to2(blend(g))}${to2(blend(bch))}`;
}

function clampByte(c: number): number {
  if (c < 0) return 0;
  if (c > 255) return 255;
  return c;
}

/** Compile-time exhaustiveness guard for the building-kind switch. */
function assertNever(_x: never): number {
  return 1;
}
