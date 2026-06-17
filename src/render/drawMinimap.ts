import type { World } from "@/ecs/World";
import type { GameMap } from "@/map/GameMap";
import type { Fog } from "@/map/Fog";
import type { Camera } from "@/render/Camera";
import { CBuilding, CUnit, CTransform, PLAYER_ID } from "@/game/components";
import { TERRAIN_COLORS } from "@/render/colors";
import { worldToGrid, worldToTile, gridToWorld } from "@/math/iso";

/**
 * Renders the minimap into its own (top-down, axis-aligned) canvas — a corner
 * overview keyed to the human's fog of war: unexplored stays black, explored-
 * but-not-visible terrain is dimmed (remembered), and currently-visible tiles
 * are full-bright. Owned buildings/units always show; enemy buildings show once
 * explored, enemy units only while visible. A white quad marks the camera's
 * viewport (a trapezoid, since the world is isometric but the minimap is not).
 *
 * Pure view: reads the map, world and fog and draws — no sim state, no mutation.
 * `mmW`×`mmH` is the canvas's drawing size in px; tiles scale to fill it.
 */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  mmW: number,
  mmH: number,
  map: GameMap,
  world: World,
  fog: Fog,
  camera: Camera,
): void {
  const sx = mmW / map.width;
  const sy = mmH / map.height;

  ctx.fillStyle = "#05070a";
  ctx.fillRect(0, 0, mmW, mmH);

  // Terrain, fog-gated. +0.6 padding avoids seams between cells.
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      if (!fog.isExplored(tx, ty)) continue; // unexplored — leave black
      const terr = map.get(tx, ty);
      if (terr === undefined) continue;
      ctx.fillStyle = TERRAIN_COLORS[terr].top;
      ctx.fillRect(tx * sx, ty * sy, sx + 0.6, sy + 0.6);
      if (!fog.isVisible(tx, ty)) {
        ctx.fillStyle = "rgba(0,0,0,0.45)"; // remembered but not currently seen
        ctx.fillRect(tx * sx, ty * sy, sx + 0.6, sy + 0.6);
      }
    }
  }

  // Building blips: own always; enemy once its footprint is explored.
  for (const [, b] of world.query(CBuilding)) {
    const own = b.owner === PLAYER_ID;
    if (!own && !fog.isExplored(b.tx, b.ty)) continue;
    ctx.fillStyle = own ? "#7fb2e6" : "#e06a6a";
    ctx.fillRect(b.tx * sx, b.ty * sy, Math.max(2, b.w * sx), Math.max(2, b.h * sy));
  }

  // Unit blips: own always; enemy only while currently visible.
  for (const [e, u] of world.query(CUnit)) {
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;
    const t = worldToTile(tr.x, tr.y);
    const own = u.owner === PLAYER_ID;
    if (!own && !fog.isVisible(t.tx, t.ty)) continue;
    ctx.fillStyle = own ? "#dceaff" : "#ffb0b0";
    ctx.fillRect(t.tx * sx, t.ty * sy, Math.max(2, sx * 0.9), Math.max(2, sy * 0.9));
  }

  // Camera viewport outline: project the four screen corners back to grid space.
  const corners: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [camera.viewW, 0],
    [camera.viewW, camera.viewH],
    [0, camera.viewH],
  ];
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    if (c === undefined) continue;
    const w = camera.screenToWorld(c[0], c[1]);
    const g = worldToGrid(w.wx, w.wy);
    const px = g.gx * sx;
    const py = g.gy * sy;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
}

/**
 * Convert a click at minimap pixel (mx, my) to the world-space point the camera
 * should centre on. Inverse of the tile→pixel scaling above.
 */
export function minimapToWorld(
  mx: number,
  my: number,
  mmW: number,
  mmH: number,
  map: GameMap,
): { x: number; y: number } {
  const gx = (mx / mmW) * map.width;
  const gy = (my / mmH) * map.height;
  return gridToWorld(gx, gy);
}
