import type { Camera } from "@/render/Camera";
import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import type { Transform, Unit } from "@/game/components";
import { CTransform, CUnit } from "@/game/components";

/**
 * A unit ready to draw: its entity id (for selection lookup) plus its
 * transform and unit data. Collected once per frame so we can depth-sort the
 * whole set before any drawing happens.
 */
interface Drawable {
  readonly e: Entity;
  readonly tr: Transform;
  readonly unit: Unit;
}

/**
 * Owner colour palette. Owner 0 is the human player (friendly cyan/blue),
 * owner 1 the canonical enemy (red); anything else falls back to a neutral
 * grey so a stray owner id never throws or renders invisibly.
 */
export function ownerColor(owner: number): string {
  switch (owner) {
    case 0:
      return "#3fb6e6"; // friendly cyan
    case 1:
      return "#e34b4b"; // enemy red
    default:
      return "#b8b8b8"; // neutral fallback
  }
}

/** Slightly darker shade of an owner colour, used for body outlines. */
function ownerOutline(owner: number): string {
  switch (owner) {
    case 0:
      return "#1b6e94";
    case 1:
      return "#8f2727";
    default:
      return "#6f6f6f";
  }
}

/** Bright friendly highlight for the AoE-style selection ring. */
const SELECTION_COLOR = "#6cff8a";

/**
 * Cull margin in world units. The largest on-screen artefact (shadow ellipse)
 * extends ~2× the unit radius from the transform; a couple of tiles (TILE_W is
 * 64) comfortably covers that plus any unit straddling the viewport edge.
 */
const CULL_MARGIN_WORLD = 128;

/**
 * Draws every unit in the world, depth-sorted back-to-front so lower (nearer)
 * units overlap higher (farther) ones — mirroring the iso painter order in
 * drawMap. Pure rendering: reads the world and the selection set, mutates no
 * simulation state. All sizes scale with camera.zoom so the look holds across
 * the full zoom range (0.4–2.5).
 */
export function drawUnits(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  world: World,
  selected: ReadonlySet<Entity>,
): void {
  // Gather drawables. Iterate transforms (every renderable thing has one) and
  // keep only those that are also units.
  const drawables: Drawable[] = [];
  for (const [e, tr] of world.query(CTransform)) {
    const unit = world.get(e, CUnit);
    if (unit === undefined) continue;
    drawables.push({ e, tr, unit });
  }

  // Back-to-front by world Y: smaller y draws first (upper/farther), larger y
  // last (lower/nearer) so it paints on top. Matches the terrain painter and
  // keeps overlapping units stacked correctly.
  drawables.sort((p, q) => p.tr.y - q.tr.y);

  const z = camera.zoom;

  for (const { e, tr, unit } of drawables) {
    // Cull units whose transform is well outside the viewport. Done in screen
    // space against a zoom-scaled margin so the test stays valid at any zoom.
    const { sx, sy } = camera.worldToScreen(tr.x, tr.y);
    const marginPx = CULL_MARGIN_WORLD * z;
    if (
      sx < -marginPx ||
      sx > camera.viewW + marginPx ||
      sy < -marginPx ||
      sy > camera.viewH + marginPx
    ) {
      continue;
    }

    const r = unit.radius * z;

    drawShadow(ctx, sx, sy, r);
    if (selected.has(e)) drawSelectionRing(ctx, sx, sy, r);
    drawBody(ctx, sx, sy, r, unit.owner);
  }
}

/**
 * Soft elliptical ground shadow beneath a unit. Drawn as a flat (2:1) ellipse
 * on the iso ground plane, offset slightly so it reads as cast underfoot.
 */
function drawShadow(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  r: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  // Sit the shadow under the feet (which are below the transform anchor).
  ctx.ellipse(sx, sy + r * 0.15, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Age-of-Empires-style selection indicator: a flat ground ellipse (2:1 to lie
 * on the iso plane) in a bright friendly colour, with a faint translucent fill
 * so the ring reads clearly over any terrain.
 */
function drawSelectionRing(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  r: number,
): void {
  ctx.save();
  const rx = r * 1.35;
  const ry = r * 0.66;
  const cy = sy + r * 0.15;

  ctx.beginPath();
  ctx.ellipse(sx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(108,255,138,0.15)";
  ctx.fill();

  ctx.strokeStyle = SELECTION_COLOR;
  // Keep the ring crisp but legible across zooms without ballooning when zoomed
  // far in; floor at 1px so it never vanishes when zoomed far out.
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.stroke();
  ctx.restore();
}

/**
 * Villager body placeholder: a rounded torso capsule topped by a head dot,
 * filled with the owner colour and outlined for contrast against terrain.
 * Anchored so the feet sit at the transform point (where the shadow/ring are).
 */
function drawBody(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  r: number,
  owner: number,
): void {
  ctx.save();

  const fill = ownerColor(owner);
  const outline = ownerOutline(owner);
  ctx.lineWidth = Math.max(1, r * 0.14);
  ctx.lineJoin = "round";

  // Torso: a vertical rounded rectangle (capsule) standing on the ground point.
  const torsoW = r * 0.9;
  const torsoH = r * 1.6;
  const torsoCx = sx;
  const torsoBottom = sy + r * 0.15; // align with shadow centre
  const torsoTop = torsoBottom - torsoH;
  const torsoCornerR = torsoW * 0.5;

  ctx.fillStyle = fill;
  ctx.strokeStyle = outline;
  ctx.beginPath();
  roundedRect(
    ctx,
    torsoCx - torsoW / 2,
    torsoTop,
    torsoW,
    torsoH,
    torsoCornerR,
  );
  ctx.fill();
  ctx.stroke();

  // Head: a circle sitting just above the torso.
  const headR = r * 0.45;
  const headCy = torsoTop - headR * 0.55;
  ctx.beginPath();
  ctx.arc(torsoCx, headCy, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/**
 * Trace a rounded-rectangle path. `r` is clamped to half the smaller side so
 * the corners never overlap (which would invert the path) at small sizes.
 */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
