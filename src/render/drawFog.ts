import type { Camera } from "@/render/Camera";
import type { Fog } from "@/map/Fog";
import { tileCorners, worldToGrid } from "@/math/iso";

/**
 * Draws the fog-of-war veil over the viewport, on top of the world but beneath
 * the UI. Per visible tile:
 *   - currently VISIBLE   → nothing (clear): the world shows through.
 *   - EXPLORED, not visible → a semi-transparent dark veil (remembered terrain
 *     and static buildings stay faintly readable).
 *   - never EXPLORED      → near-opaque black (the unknown).
 *
 * Like drawMap, only the tiles whose grid coords fall inside the camera's
 * viewport (plus a one-tile margin) are considered, so cost scales with what's
 * on screen rather than the whole map. Pure rendering — no simulation state is
 * touched.
 */

/** Veil over explored-but-not-currently-visible tiles. */
const EXPLORED_VEIL = "rgba(0,0,0,0.45)";
/** Near-opaque cover over never-explored tiles. */
const UNEXPLORED_COVER = "rgba(0,0,0,0.92)";

export function drawFog(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  fog: Fog,
): void {
  // Grid-space bounding box of the four screen corners (same as drawMap).
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
  const tx1 = Math.min(fog.width - 1, Math.ceil(maxGx) + 1);
  const ty1 = Math.min(fog.height - 1, Math.ceil(maxGy) + 1);

  ctx.save();
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (fog.isVisible(tx, ty)) continue; // clear — draw nothing.

      const fill = fog.isExplored(tx, ty) ? EXPLORED_VEIL : UNEXPLORED_COVER;

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

      ctx.fillStyle = fill;
      // Stroke with the fill colour to hide hairline anti-aliasing seams
      // between adjacent diamonds (same trick as drawMap).
      ctx.strokeStyle = fill;
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
