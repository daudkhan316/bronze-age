import type { Camera } from "@/render/Camera";
import type { World } from "@/ecs/World";
import { CResourceNode, CTransform, NODE_AMOUNT } from "@/game/components";

/**
 * Draws every harvestable resource node as a small ground sprite, one per kind
 * (berry bush, tree, gold ore, stone), sized in screen space by camera.zoom.
 * Remaining amount is conveyed by an overall scale factor so a near-depleted
 * node reads visibly smaller than a fresh one. Pure rendering: reads the world,
 * mutates no simulation state, and brackets every style change in save/restore.
 *
 * Anchoring follows drawUnits: each node's CTransform is its world-space anchor
 * (the tile centre), projected to screen via camera.worldToScreen.
 */

/**
 * Cull margin in world units. A node sprite extends at most ~1 tile from its
 * transform; a couple of tiles (TILE_W is 64) covers that plus any node
 * straddling the viewport edge.
 */
const CULL_MARGIN_WORLD = 96;

/**
 * Base on-screen size of a node sprite at zoom 1, in pixels. Roughly a tile
 * wide so nodes read clearly without swamping adjacent tiles.
 */
const BASE_SIZE = 22;

/** Smallest amount-driven scale, so a near-empty node never shrinks to nothing. */
const MIN_FULLNESS_SCALE = 0.45;

export function drawResources(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  world: World,
): void {
  const z = camera.zoom;
  const marginPx = CULL_MARGIN_WORLD * z;

  for (const [e, node] of world.query(CResourceNode)) {
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;

    const { sx, sy } = camera.worldToScreen(tr.x, tr.y);
    if (
      sx < -marginPx ||
      sx > camera.viewW + marginPx ||
      sy < -marginPx ||
      sy > camera.viewH + marginPx
    ) {
      continue;
    }

    // Fullness in 0..1, mapped to a gentle scale so depletion is legible but
    // the sprite stays recognisable to the very end.
    const max = NODE_AMOUNT[node.kind];
    const fullness = max > 0 ? clamp01(node.amount / max) : 1;
    const scale = MIN_FULLNESS_SCALE + (1 - MIN_FULLNESS_SCALE) * fullness;
    const s = BASE_SIZE * z * scale;

    switch (node.kind) {
      case "food":
        drawFood(ctx, sx, sy, s, z);
        break;
      case "wood":
        drawWood(ctx, sx, sy, s, z);
        break;
      case "gold":
        drawRocks(ctx, sx, sy, s, z, "#e8b923", "#a8841a");
        break;
      case "stone":
        drawRocks(ctx, sx, sy, s, z, "#b9bdc2", "#7f858a");
        break;
      default:
        // Exhaustive over ResourceKind; keep the switch total for safety.
        assertNever(node.kind);
    }
  }
}

/** Soft elliptical ground shadow shared by every node sprite. */
function drawShadow(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  s: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(sx, sy + s * 0.05, s * 0.65, s * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Berry bush: a green mound dotted with a cluster of small red berries. */
function drawFood(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  s: number,
  z: number,
): void {
  drawShadow(ctx, sx, sy, s);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, s * 0.07);

  // Bush mound.
  ctx.fillStyle = "#3f7a35";
  ctx.strokeStyle = "#27521f";
  ctx.beginPath();
  ctx.ellipse(sx, sy - s * 0.18, s * 0.55, s * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Berry cluster: five small red dots arranged across the mound.
  ctx.fillStyle = "#d23b34";
  ctx.strokeStyle = "#8f2722";
  ctx.lineWidth = Math.max(0.5, s * 0.04);
  const br = Math.max(1, s * 0.13);
  const berries: ReadonlyArray<readonly [number, number]> = [
    [-0.3, -0.28],
    [0.28, -0.32],
    [0.0, -0.1],
    [-0.22, 0.04],
    [0.26, -0.02],
  ];
  for (const [bx, by] of berries) {
    ctx.beginPath();
    ctx.arc(sx + bx * s, sy + by * s, br, 0, Math.PI * 2);
    ctx.fill();
    if (z > 0.6) ctx.stroke();
  }
  ctx.restore();
}

/** Tree: a brown trunk topped by a layered green canopy. */
function drawWood(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  s: number,
  z: number,
): void {
  drawShadow(ctx, sx, sy, s);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, s * 0.06);

  // Trunk: a short rectangle anchored at the ground point.
  const trunkW = s * 0.18;
  const trunkH = s * 0.55;
  ctx.fillStyle = "#6b4a2b";
  ctx.strokeStyle = "#43301c";
  ctx.beginPath();
  ctx.rect(sx - trunkW / 2, sy - trunkH, trunkW, trunkH);
  ctx.fill();
  if (z > 0.6) ctx.stroke();

  // Canopy: two stacked blobs for a little depth.
  ctx.fillStyle = "#2f6d2a";
  ctx.strokeStyle = "#1e481b";
  ctx.beginPath();
  ctx.ellipse(sx, sy - trunkH - s * 0.05, s * 0.5, s * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#3a8a32";
  ctx.beginPath();
  ctx.ellipse(sx, sy - trunkH - s * 0.32, s * 0.34, s * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  if (z > 0.6) ctx.stroke();

  ctx.restore();
}

/**
 * A small cluster of faceted rocks (used for both gold and stone, differing
 * only in colour). Three overlapping diamonds give an ore-pile silhouette.
 */
function drawRocks(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  s: number,
  z: number,
  fill: string,
  stroke: string,
): void {
  drawShadow(ctx, sx, sy, s);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;

  // Three rock lumps at slight offsets/sizes.
  const rocks: ReadonlyArray<readonly [number, number, number]> = [
    [-0.28, -0.02, 0.34],
    [0.26, -0.06, 0.3],
    [0.0, -0.22, 0.36],
  ];
  for (const [rx, ry, rsz] of rocks) {
    rockShape(ctx, sx + rx * s, sy + ry * s, s * rsz);
    ctx.fill();
    if (z > 0.5) ctx.stroke();
  }
  ctx.restore();
}

/** Trace a faceted rock: a squat hexagon, wider than tall to sit on the ground. */
function rockShape(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
): void {
  const w = r;
  const h = r * 0.7;
  ctx.beginPath();
  ctx.moveTo(cx - w, cy);
  ctx.lineTo(cx - w * 0.5, cy - h);
  ctx.lineTo(cx + w * 0.5, cy - h);
  ctx.lineTo(cx + w, cy);
  ctx.lineTo(cx + w * 0.45, cy + h * 0.5);
  ctx.lineTo(cx - w * 0.45, cy + h * 0.5);
  ctx.closePath();
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Compile-time exhaustiveness guard for the resource-kind switch. */
function assertNever(_x: never): void {
  /* unreachable */
}
