import type { Camera } from "@/render/Camera";
import type { GameMap } from "@/map/GameMap";
import { tileCorners, worldToGrid } from "@/math/iso";
import { TERRAIN_COLORS, GRID_LINE } from "@/render/colors";

/**
 * Draws the visible portion of the terrain grid. Only tiles whose grid
 * coordinates fall inside the camera's viewport (plus a one-tile margin) are
 * considered, so cost scales with what's on screen, not the whole map.
 */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  map: GameMap,
  showGrid: boolean,
): void {
  // Find the grid-space bounding box of the four screen corners.
  const corners = [
    camera.screenToWorld(0, 0),
    camera.screenToWorld(camera.viewW, 0),
    camera.screenToWorld(0, camera.viewH),
    camera.screenToWorld(camera.viewW, camera.viewH),
  ].map((w) => worldToGrid(w.wx, w.wy));

  let minGx = Infinity;
  let minGy = Infinity;
  let maxGx = -Infinity;
  let maxGy = -Infinity;
  for (const c of corners) {
    if (c.gx < minGx) minGx = c.gx;
    if (c.gy < minGy) minGy = c.gy;
    if (c.gx > maxGx) maxGx = c.gx;
    if (c.gy > maxGy) maxGy = c.gy;
  }

  const tx0 = Math.max(0, Math.floor(minGx) - 1);
  const ty0 = Math.max(0, Math.floor(minGy) - 1);
  const tx1 = Math.min(map.width - 1, Math.ceil(maxGx) + 1);
  const ty1 = Math.min(map.height - 1, Math.ceil(maxGy) + 1);

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const terrain = map.get(tx, ty);
      if (terrain === undefined) continue;

      const [a, b, c, d] = tileCorners(tx, ty);
      const sa = camera.worldToScreen(a.x, a.y);
      const sb = camera.worldToScreen(b.x, b.y);
      const sc = camera.worldToScreen(c.x, c.y);
      const sd = camera.worldToScreen(d.x, d.y);

      ctx.beginPath();
      ctx.moveTo(sa.sx, sa.sy);
      ctx.lineTo(sb.sx, sb.sy);
      ctx.lineTo(sc.sx, sc.sy);
      ctx.lineTo(sd.sx, sd.sy);
      ctx.closePath();

      const col = TERRAIN_COLORS[terrain];
      ctx.fillStyle = col.top;
      // Stroke with the fill colour to hide hairline anti-aliasing seams
      // between adjacent diamonds.
      ctx.strokeStyle = col.top;
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    }
  }

  if (showGrid) {
    // Build every diamond into ONE path and stroke once. Adjacent tiles share
    // edges; stroking per-tile would lay a translucent line twice over interior
    // edges (darker than the boundary). A single stroke renders the union once.
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!map.inBounds(tx, ty)) continue;
        const [a, b, c, d] = tileCorners(tx, ty);
        const sa = camera.worldToScreen(a.x, a.y);
        const sb = camera.worldToScreen(b.x, b.y);
        const sc = camera.worldToScreen(c.x, c.y);
        const sd = camera.worldToScreen(d.x, d.y);
        ctx.moveTo(sa.sx, sa.sy);
        ctx.lineTo(sb.sx, sb.sy);
        ctx.lineTo(sc.sx, sc.sy);
        ctx.lineTo(sd.sx, sd.sy);
        ctx.closePath();
      }
    }
    ctx.stroke();
  }
}
