import type { Camera } from "@/render/Camera";
import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import type { Fog } from "@/map/Fog";
import type {
  Building,
  BuildingKind,
  Construction,
  ResourceNode,
  Unit,
} from "@/game/components";
import {
  CBuilding,
  CConstruction,
  CProjectile,
  CResourceNode,
  CTransform,
  CUnit,
  NODE_AMOUNT,
  PLAYER_ID,
} from "@/game/components";
import { gridToWorld, worldToTile } from "@/math/iso";

/**
 * Unified, depth-sorted world renderer.
 *
 * Phase 3 introduced cross-type occlusion bugs: resources, buildings and units
 * were each drawn in their own pass, so (for example) a unit standing BEHIND a
 * building could paint on top of it. The fix is to collect every world drawable
 * — resource nodes, buildings, units — into ONE list, assign each a depth key,
 * sort back-to-front (ascending world-Y), then draw. Within one Y all three
 * types interleave correctly because the comparator breaks ties by category.
 *
 * Pure rendering: reads the world + selection inputs, mutates no simulation
 * state, and brackets every style change in save/restore. All sizes scale with
 * camera.zoom so the look holds across the full zoom range.
 */

// ---------------------------------------------------------------------------
// Drawable collection + depth sort
// ---------------------------------------------------------------------------

/** Draw category, used as the tie-breaker so overlaps read correctly. */
const enum Category {
  Resource = 0,
  Building = 1,
  Unit = 2,
}

/**
 * One thing to draw, reduced to a depth key (`y`, the ground anchor's world-Y),
 * a `cat` tie-breaker, and a closure that paints it. Closures keep the per-type
 * draw code self-contained while letting the sort treat all drawables uniformly.
 */
interface Drawable {
  /** Depth key: ground-anchor world-Y. Smaller = farther/back = drawn first. */
  readonly y: number;
  /** Tie-breaker within equal Y: resources < buildings < units. */
  readonly cat: Category;
  readonly draw: () => void;
}

interface ScreenPt {
  readonly sx: number;
  readonly sy: number;
}

/** Cull margin in world units — generous so tall sprites near the edge survive. */
const CULL_MARGIN_WORLD = 180;

export function drawWorld(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  world: World,
  selectedUnits: ReadonlySet<Entity>,
  selectedBuilding: Entity | null,
  fog: Fog,
): void {
  const z = camera.zoom;
  const marginPx = CULL_MARGIN_WORLD * z;

  /** True when a screen point lies within the (margin-expanded) viewport. */
  const onScreen = (p: ScreenPt): boolean =>
    p.sx >= -marginPx &&
    p.sx <= camera.viewW + marginPx &&
    p.sy >= -marginPx &&
    p.sy <= camera.viewH + marginPx;

  const drawables: Drawable[] = [];

  // --- Resource nodes ------------------------------------------------------
  for (const [e, node] of world.query(CResourceNode)) {
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;
    const a = camera.worldToScreen(tr.x, tr.y);
    if (!onScreen(a)) continue;
    drawables.push({
      y: tr.y,
      cat: Category.Resource,
      draw: () => drawResourceNode(ctx, a.sx, a.sy, node, z),
    });
  }

  // --- Buildings -----------------------------------------------------------
  for (const [e, b] of world.query(CBuilding)) {
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;
    // Enemy buildings are remembered: shown once their footprint is explored
    // (they don't move), even when not currently in sight. Own buildings always.
    if (b.owner !== PLAYER_ID && !fog.isExplored(b.tx + (b.w >> 1), b.ty + (b.h >> 1))) continue;
    const centre = camera.worldToScreen(tr.x, tr.y);
    if (!onScreen(centre)) continue;

    // Key by the CENTRE of the front-most footprint TILE (not the footprint's
    // south vertex). A unit standing on a tile directly in front of the building
    // shares that tile-row's world-Y, so it ties the key and wins via the
    // Unit > Building tie-break (drawn in front). Using the south vertex instead
    // pushes the key half a tile-diagonal too far south, wrongly occluding units
    // standing in front of multi-tile footprints.
    const front = gridToWorld(b.tx + b.w - 0.5, b.ty + b.h - 0.5);
    const construction = world.get(e, CConstruction);
    const selected = selectedBuilding === e;
    drawables.push({
      y: front.y,
      cat: Category.Building,
      // exactOptionalPropertyTypes: pass null, never undefined.
      draw: () =>
        drawBuilding(ctx, camera, b, construction ?? null, selected, z),
    });
  }

  // --- Units ---------------------------------------------------------------
  for (const [e, tr] of world.query(CTransform)) {
    const unit = world.get(e, CUnit);
    if (unit === undefined) continue;
    // Enemy units are only drawn while currently in sight (fog of war).
    if (unit.owner !== PLAYER_ID) {
      const ut = worldToTile(tr.x, tr.y);
      if (!fog.isVisible(ut.tx, ut.ty)) continue;
    }
    const a = camera.worldToScreen(tr.x, tr.y);
    if (!onScreen(a)) continue;
    const selected = selectedUnits.has(e);
    drawables.push({
      y: tr.y,
      cat: Category.Unit,
      draw: () => drawUnit(ctx, a.sx, a.sy, unit, selected, z),
    });
  }

  // Back-to-front: ascending world-Y, then by category so a unit on/near a
  // building tile reads in front of the building (and resources behind both).
  drawables.sort((p, q) => (p.y !== q.y ? p.y - q.y : p.cat - q.cat));

  for (const d of drawables) d.draw();

  // Projectiles fly above the ground, so draw them last (on top of everything),
  // oriented toward their aim point.
  for (const [e, p] of world.query(CProjectile)) {
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;
    const s = camera.worldToScreen(tr.x, tr.y);
    if (!onScreen(s)) continue;
    const aimTr = p.target !== null ? world.get(p.target, CTransform) : undefined;
    const aimX = aimTr !== undefined ? aimTr.x : p.gx;
    const aimY = aimTr !== undefined ? aimTr.y : p.gy;
    const aim = camera.worldToScreen(aimX, aimY);
    drawArrow(ctx, s.sx, s.sy, Math.atan2(aim.sy - s.sy, aim.sx - s.sx), z);
  }
}

/** A small arrow/dart at (sx, sy) pointing along `ang`. */
function drawArrow(ctx: CanvasRenderingContext2D, sx: number, sy: number, ang: number, z: number): void {
  const len = 11 * z;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "#3a2a18";
  ctx.lineWidth = Math.max(1, 1.7 * z);
  ctx.beginPath();
  ctx.moveTo(sx - ux * len, sy - uy * len);
  ctx.lineTo(sx, sy);
  ctx.stroke();
  // Metal head: a small triangle at the tip.
  const hl = 4.5 * z;
  const hw = 2.6 * z;
  const px = -uy;
  const py = ux;
  ctx.fillStyle = "#d8dde2";
  ctx.beginPath();
  ctx.moveTo(sx + ux * hl, sy + uy * hl);
  ctx.lineTo(sx + px * hw, sy + py * hw);
  ctx.lineTo(sx - px * hw, sy - py * hw);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Resource node sprites (consolidated from drawResources.ts)
// ---------------------------------------------------------------------------

/** Base on-screen size of a node sprite at zoom 1, in pixels. */
const NODE_BASE_SIZE = 22;
/** Smallest amount-driven scale, so a near-empty node never shrinks to nothing. */
const NODE_MIN_FULLNESS = 0.45;

function drawResourceNode(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  node: ResourceNode,
  z: number,
): void {
  const max = NODE_AMOUNT[node.kind];
  const fullness = max > 0 ? clamp01(node.amount / max) : 1;
  const scale = NODE_MIN_FULLNESS + (1 - NODE_MIN_FULLNESS) * fullness;
  const s = NODE_BASE_SIZE * z * scale;

  switch (node.kind) {
    case "food":
      drawFood(ctx, sx, sy, s, z);
      return;
    case "wood":
      drawWood(ctx, sx, sy, s, z);
      return;
    case "gold":
      drawRocks(ctx, sx, sy, s, z, "#e8b923", "#a8841a");
      return;
    case "stone":
      drawRocks(ctx, sx, sy, s, z, "#b9bdc2", "#7f858a");
      return;
    default:
      assertNever(node.kind);
      return;
  }
}

/** Soft elliptical ground shadow shared by every node sprite. */
function drawNodeShadow(
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
  drawNodeShadow(ctx, sx, sy, s);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, s * 0.07);

  ctx.fillStyle = "#3f7a35";
  ctx.strokeStyle = "#27521f";
  ctx.beginPath();
  ctx.ellipse(sx, sy - s * 0.18, s * 0.55, s * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

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
  drawNodeShadow(ctx, sx, sy, s);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, s * 0.06);

  const trunkW = s * 0.18;
  const trunkH = s * 0.55;
  ctx.fillStyle = "#6b4a2b";
  ctx.strokeStyle = "#43301c";
  ctx.beginPath();
  ctx.rect(sx - trunkW / 2, sy - trunkH, trunkW, trunkH);
  ctx.fill();
  if (z > 0.6) ctx.stroke();

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

/** A small cluster of faceted rocks (used for both gold and stone). */
function drawRocks(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  s: number,
  z: number,
  fill: string,
  stroke: string,
): void {
  drawNodeShadow(ctx, sx, sy, s);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;

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

// ---------------------------------------------------------------------------
// Building sprites (consolidated from drawBuildings.ts, extended for Phase 3)
// ---------------------------------------------------------------------------

/** Wall (body) height in world units at zoom 1, before the per-kind multiplier. */
const BASE_WALL_HEIGHT = 26;
/** Roof rise above the wall top, in world units at zoom 1. */
const BASE_ROOF_HEIGHT = 22;
/** Outline colour for crisp silhouettes against terrain. */
const OUTLINE = "#1b232b";
/** Bright friendly highlight, shared with the unit selection ring. */
const SELECTION_COLOR = "#6cff8a";

/**
 * Draws one building: footprint diamond, two extruded wall faces, the wall top,
 * and a pitched roof, plus a small owner flag. A foundation (has a Construction
 * component and !complete) renders translucent as scaffolding with a build
 * progress bar; a completed but damaged building shows a thin HP bar; the
 * selected building gets a footprint outline.
 */
function drawBuilding(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  b: Building,
  construction: Construction | null,
  selected: boolean,
  z: number,
): void {
  const palette = kindPalette(b.kind, b.owner);
  const grand = kindScale(b.kind);
  const wallH = BASE_WALL_HEIGHT * grand * z;
  const roofH = BASE_ROOF_HEIGHT * grand * z;

  // A foundation (under construction) is drawn semi-transparent as scaffolding.
  const underConstruction = construction !== null && !b.complete;

  // Footprint corners in grid space, clockwise from the top (north) vertex.
  const top = projectGrid(camera, b.tx, b.ty);
  const right = projectGrid(camera, b.tx + b.w, b.ty);
  const bottom = projectGrid(camera, b.tx + b.w, b.ty + b.h);
  const left = projectGrid(camera, b.tx, b.ty + b.h);

  const lineW = Math.max(1, 1.4 * z);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = lineW;
  ctx.strokeStyle = OUTLINE;
  if (underConstruction) ctx.globalAlpha = 0.55;

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

  // 2) Left wall face (left -> bottom), the shaded side.
  fillQuad(ctx, left, bottom, bottomT, leftT, palette.shade);
  // 3) Right wall face (right -> bottom), the lit side.
  fillQuad(ctx, right, bottom, bottomT, rightT, palette.body);

  // 4) Wall top diamond (the roof base footprint, lifted).
  ctx.beginPath();
  ctx.moveTo(topT.sx, topT.sy);
  ctx.lineTo(rightT.sx, rightT.sy);
  ctx.lineTo(bottomT.sx, bottomT.sy);
  ctx.lineTo(leftT.sx, leftT.sy);
  ctx.closePath();
  ctx.fillStyle = lighten(palette.body);
  ctx.fill();
  ctx.stroke();

  // 5) Roof: a pyramid apex above the wall-top centre.
  const apex: ScreenPt = {
    sx: (topT.sx + bottomT.sx) / 2,
    sy: (topT.sy + bottomT.sy) / 2 - roofH,
  };
  fillTri(ctx, leftT, bottomT, apex, darken(palette.roof));
  fillTri(ctx, rightT, bottomT, apex, palette.roof);
  fillTri(ctx, leftT, topT, apex, darken(palette.roof));
  fillTri(ctx, rightT, topT, apex, palette.roof);

  // 6) Owner flag on the apex.
  drawFlag(ctx, apex, roofH, b.owner, z);

  ctx.restore();

  // Overlays (full opacity, above the body).
  // Footprint apex extents for placing bars/outlines above the roof.
  const topY = Math.min(topT.sy, rightT.sy, leftT.sy, apex.sy);

  if (selected) {
    drawFootprintOutline(ctx, top, right, bottom, left, z);
  }

  if (underConstruction && construction !== null) {
    const frac =
      construction.required > 0
        ? clamp01(construction.progress / construction.required)
        : 1;
    drawProgressBar(ctx, top, bottom, topY, frac, "#6cff8a", z);
  } else if (b.hp < b.maxHp) {
    const frac = b.maxHp > 0 ? clamp01(b.hp / b.maxHp) : 0;
    drawProgressBar(ctx, top, bottom, topY, frac, hpColor(frac), z);
  }
}

/** Per-kind body/roof palette, owner-tinted, giving each kind a distinct look. */
interface Palette {
  readonly body: string;
  readonly shade: string;
  readonly roof: string;
}

function kindPalette(kind: BuildingKind, owner: number): Palette {
  // Owner 0 buildings lean blue-grey; non-owner-0 lean warm tan. Roof colour is
  // per-kind so Houses, Barracks, Mill and the two camps each read distinctly.
  const friendly = owner === 0;
  const body = friendly ? "#7d93a8" : "#b9a888";
  const shade = friendly ? "#5f7387" : "#998a6c";
  switch (kind) {
    case "town_center":
      return { body, shade, roof: friendly ? "#3f566b" : "#7a5b3a" };
    case "barracks":
      // Military red roof.
      return { body, shade, roof: "#8c3b34" };
    case "archery_range":
      // Fletcher's deep green roof.
      return { body, shade, roof: "#3f6b46" };
    case "house":
      // Warm thatch/terracotta roof.
      return { body, shade, roof: "#c08a4a" };
    case "lumber_camp":
      // Timber green-brown.
      return { body: "#8a7a55", shade: "#6c5f42", roof: "#4f6b3a" };
    case "mining_camp":
      // Stone grey.
      return { body: "#8f9499", shade: "#70757a", roof: "#5a6066" };
    case "mill":
      // Wheat gold roof.
      return { body, shade, roof: "#caa83f" };
    case "blacksmith":
      // Dark iron/soot roof.
      return { body, shade, roof: "#4a4f57" };
    case "watch_tower":
      // Stone tower with a slate cap.
      return { body: "#9aa0a6", shade: "#767c82", roof: "#55606a" };
    case "stable":
      // Warm timber barn with a brown roof.
      return { body, shade, roof: "#6e4a2c" };
    default:
      return assertNeverPalette(kind);
  }
}

/** Larger civic/military buildings are noticeably taller than small ones. */
function kindScale(kind: BuildingKind): number {
  switch (kind) {
    case "town_center":
      return 1.35;
    case "barracks":
    case "archery_range":
    case "blacksmith":
    case "stable":
      return 1.3;
    case "watch_tower":
      // Tall and narrow — the tower silhouette.
      return 1.8;
    case "house":
    case "lumber_camp":
    case "mining_camp":
    case "mill":
      return 1.0;
    default:
      return assertNeverNum(kind);
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

/** Fill + stroke an outlined quad from four screen points. */
function fillQuad(
  ctx: CanvasRenderingContext2D,
  a: ScreenPt,
  b: ScreenPt,
  c: ScreenPt,
  d: ScreenPt,
  fill: string,
): void {
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
  ctx.lineTo(c.sx, c.sy);
  ctx.lineTo(d.sx, d.sy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

/** Fill + stroke an outlined triangle from three screen points. */
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

  ctx.beginPath();
  ctx.moveTo(apex.sx, apex.sy);
  ctx.lineTo(apex.sx, poleTopY);
  ctx.stroke();

  const flagW = Math.max(4, 6 * z);
  const flagH = Math.max(3, 4 * z);
  ctx.beginPath();
  ctx.moveTo(apex.sx, poleTopY);
  ctx.lineTo(apex.sx + flagW, poleTopY + flagH * 0.5);
  ctx.lineTo(apex.sx, poleTopY + flagH);
  ctx.closePath();
  ctx.fillStyle = ownerColor(owner);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Bright outline tracing the ground footprint of the selected building. */
function drawFootprintOutline(
  ctx: CanvasRenderingContext2D,
  top: ScreenPt,
  right: ScreenPt,
  bottom: ScreenPt,
  left: ScreenPt,
  z: number,
): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = Math.max(1.5, 2.4 * z);
  ctx.beginPath();
  ctx.moveTo(top.sx, top.sy);
  ctx.lineTo(right.sx, right.sy);
  ctx.lineTo(bottom.sx, bottom.sy);
  ctx.lineTo(left.sx, left.sy);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/**
 * A small bar centred over the building, drawn just above its roofline. Used for
 * both construction progress (green) and damaged-HP readout.
 */
function drawProgressBar(
  ctx: CanvasRenderingContext2D,
  top: ScreenPt,
  bottom: ScreenPt,
  topY: number,
  frac: number,
  fill: string,
  z: number,
): void {
  const cx = (top.sx + bottom.sx) / 2;
  const w = Math.max(18, 34 * z);
  const h = Math.max(3, 5 * z);
  const x = cx - w / 2;
  const y = topY - h - Math.max(4, 6 * z);

  ctx.save();
  // Backing.
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  // Empty track.
  ctx.fillStyle = "#3a3f44";
  ctx.fillRect(x, y, w, h);
  // Filled portion.
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w * clamp01(frac), h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Unit sprites (consolidated from drawUnits.ts, extended with spearman + HP)
// ---------------------------------------------------------------------------

/**
 * Owner colour palette. Owner 0 is the human player (friendly cyan/blue),
 * owner 1 the canonical enemy (red); anything else falls back to neutral grey.
 */
export function ownerColor(owner: number): string {
  switch (owner) {
    case 0:
      return "#3fb6e6";
    case 1:
      return "#e34b4b";
    default:
      return "#b8b8b8";
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

function drawUnit(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  unit: Unit,
  selected: boolean,
  z: number,
): void {
  const r = unit.radius * z;

  drawUnitShadow(ctx, sx, sy, r);
  if (selected) drawSelectionRing(ctx, sx, sy, r);

  if (unit.kind === "spearman") {
    drawSpearman(ctx, sx, sy, r, unit.owner);
  } else if (unit.kind === "archer") {
    drawArcher(ctx, sx, sy, r, unit.owner);
  } else if (unit.kind === "cavalry") {
    drawCavalry(ctx, sx, sy, r, unit.owner);
  } else {
    drawVillager(ctx, sx, sy, r, unit.owner);
  }

  if (unit.hp < unit.maxHp) {
    const frac = unit.maxHp > 0 ? clamp01(unit.hp / unit.maxHp) : 0;
    drawUnitHpBar(ctx, sx, sy, r, frac, z);
  }
}

/** Soft elliptical ground shadow beneath a unit. */
function drawUnitShadow(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  r: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(sx, sy + r * 0.15, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Flat ground ellipse selection ring (AoE-style) in a bright friendly colour. */
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
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.stroke();
  ctx.restore();
}

/**
 * Villager: a rounded torso capsule topped by a head dot, owner-tinted and
 * outlined. Anchored so the feet sit at the transform point.
 */
function drawVillager(
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

  const torsoW = r * 0.9;
  const torsoH = r * 1.6;
  const torsoBottom = sy + r * 0.15;
  const torsoTop = torsoBottom - torsoH;
  const torsoCornerR = torsoW * 0.5;

  ctx.fillStyle = fill;
  ctx.strokeStyle = outline;
  ctx.beginPath();
  roundedRect(ctx, sx - torsoW / 2, torsoTop, torsoW, torsoH, torsoCornerR);
  ctx.fill();
  ctx.stroke();

  const headR = r * 0.45;
  const headCy = torsoTop - headR * 0.55;
  ctx.beginPath();
  ctx.arc(sx, headCy, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/**
 * Spearman: a soldier silhouette — squarer (armoured) torso, a head, and a long
 * spear held diagonally with a triangular tip, so it reads as military at a
 * glance and is clearly distinct from the rounded villager.
 */
function drawSpearman(
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
  ctx.lineCap = "round";

  // Spear FIRST so the body overlaps its grip (reads as held). Drawn from down
  // by the feet up past the head, angled to the right.
  const spearBottomX = sx + r * 0.55;
  const spearBottomY = sy + r * 0.35;
  const spearTopX = sx + r * 0.95;
  const spearTopY = sy - r * 2.0;
  ctx.strokeStyle = "#7a5a33";
  ctx.lineWidth = Math.max(1, r * 0.18);
  ctx.beginPath();
  ctx.moveTo(spearBottomX, spearBottomY);
  ctx.lineTo(spearTopX, spearTopY);
  ctx.stroke();

  // Spear tip: a small triangle at the top of the shaft.
  const tipH = r * 0.5;
  const tipW = r * 0.26;
  const dx = spearTopX - spearBottomX;
  const dy = spearTopY - spearBottomY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular for the tip's width.
  const px = -uy;
  const py = ux;
  const apexX = spearTopX + ux * tipH;
  const apexY = spearTopY + uy * tipH;
  ctx.fillStyle = "#d8dde2";
  ctx.strokeStyle = "#5a5f64";
  ctx.lineWidth = Math.max(0.8, r * 0.08);
  ctx.beginPath();
  ctx.moveTo(apexX, apexY);
  ctx.lineTo(spearTopX + px * tipW, spearTopY + py * tipW);
  ctx.lineTo(spearTopX - px * tipW, spearTopY - py * tipW);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Armoured torso: a tapered (trapezoid) body, squarer than the villager.
  ctx.fillStyle = fill;
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(1, r * 0.14);
  const torsoBottom = sy + r * 0.15;
  const torsoTop = torsoBottom - r * 1.5;
  const halfTopW = r * 0.42;
  const halfBotW = r * 0.6;
  ctx.beginPath();
  ctx.moveTo(sx - halfTopW, torsoTop);
  ctx.lineTo(sx + halfTopW, torsoTop);
  ctx.lineTo(sx + halfBotW, torsoBottom);
  ctx.lineTo(sx - halfBotW, torsoBottom);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Helmeted head: a circle with a small crest notch above the torso.
  const headR = r * 0.42;
  const headCy = torsoTop - headR * 0.5;
  ctx.beginPath();
  ctx.arc(sx, headCy, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/**
 * Cavalry: a brown horse (elongated body + legs + neck/head) with an owner-
 * coloured rider seated on top — clearly mounted and bulkier than the infantry.
 */
function drawCavalry(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  r: number,
  owner: number,
): void {
  ctx.save();
  const fill = ownerColor(owner);
  const outline = ownerOutline(owner);
  const horse = "#6b4f34";
  const horseShade = "#4f3a26";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Legs down to the ground.
  ctx.strokeStyle = horseShade;
  ctx.lineWidth = Math.max(1, r * 0.16);
  const groundY = sy + r * 0.5;
  for (const lx of [-0.7, -0.35, 0.35, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(sx + r * lx, sy + r * 0.05);
    ctx.lineTo(sx + r * lx, groundY);
    ctx.stroke();
  }

  // Horse body (elongated) + neck and head out front-right.
  ctx.fillStyle = horse;
  ctx.strokeStyle = horseShade;
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.beginPath();
  ctx.ellipse(sx, sy - r * 0.05, r * 1.0, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx + r * 0.7, sy - r * 0.2);
  ctx.lineTo(sx + r * 1.2, sy - r * 0.85);
  ctx.lineTo(sx + r * 1.45, sy - r * 0.66);
  ctx.lineTo(sx + r * 0.95, sy + r * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Rider torso + head, seated on the horse's back.
  ctx.fillStyle = fill;
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(1, r * 0.14);
  const torsoBottom = sy - r * 0.45;
  const torsoTop = torsoBottom - r * 1.0;
  ctx.beginPath();
  ctx.moveTo(sx - r * 0.35, torsoTop);
  ctx.lineTo(sx + r * 0.35, torsoTop);
  ctx.lineTo(sx + r * 0.5, torsoBottom);
  ctx.lineTo(sx - r * 0.5, torsoBottom);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const headR = r * 0.38;
  ctx.beginPath();
  ctx.arc(sx, torsoTop - headR * 0.5, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/**
 * Archer: a lean villager-like body holding a bow (a brown arc with a pale
 * string) out to one side — clearly a ranged soldier, distinct from villager
 * and spearman.
 */
function drawArcher(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  r: number,
  owner: number,
): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Bow FIRST, held to the left: a brown arc bowed away from the body.
  const bowX = sx - r * 0.6;
  const bowTopY = sy - r * 1.85;
  const bowBotY = sy + r * 0.1;
  ctx.strokeStyle = "#7a5a33";
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.beginPath();
  ctx.moveTo(bowX, bowTopY);
  ctx.quadraticCurveTo(bowX - r * 0.75, (bowTopY + bowBotY) / 2, bowX, bowBotY);
  ctx.stroke();
  // Bowstring: a straight line tip to tip.
  ctx.strokeStyle = "#e6e6e6";
  ctx.lineWidth = Math.max(0.8, r * 0.06);
  ctx.beginPath();
  ctx.moveTo(bowX, bowTopY);
  ctx.lineTo(bowX, bowBotY);
  ctx.stroke();

  // Lean torso, narrower than the villager.
  const fill = ownerColor(owner);
  const outline = ownerOutline(owner);
  ctx.fillStyle = fill;
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(1, r * 0.14);
  const torsoW = r * 0.7;
  const torsoH = r * 1.55;
  const torsoBottom = sy + r * 0.15;
  const torsoTop = torsoBottom - torsoH;
  ctx.beginPath();
  roundedRect(ctx, sx - torsoW / 2, torsoTop, torsoW, torsoH, torsoW * 0.5);
  ctx.fill();
  ctx.stroke();

  // Hooded head.
  const headR = r * 0.42;
  const headCy = torsoTop - headR * 0.5;
  ctx.beginPath();
  ctx.arc(sx, headCy, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/** Thin HP bar floating above a damaged unit's head. */
function drawUnitHpBar(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  r: number,
  frac: number,
  z: number,
): void {
  const w = Math.max(14, r * 2.0);
  const h = Math.max(2, 3 * z);
  const x = sx - w / 2;
  const y = sy - r * 2.6;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = "#3a3f44";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = hpColor(frac);
  ctx.fillRect(x, y, w * clamp01(frac), h);
  ctx.restore();
}

/** Green→amber→red as HP fraction drops, a familiar RTS readout. */
function hpColor(frac: number): string {
  if (frac > 0.5) return "#4cd964";
  if (frac > 0.25) return "#e7b53b";
  return "#e3463b";
}

/**
 * Trace a rounded-rectangle path. `r` is clamped to half the smaller side so
 * the corners never overlap at small sizes.
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

// ---------------------------------------------------------------------------
// Colour + numeric helpers (consolidated from drawBuildings.ts)
// ---------------------------------------------------------------------------

/** Lighten a #rrggbb hex toward white (for the lit wall top). */
function lighten(hex: string): string {
  return mix(hex, 255, 0.18);
}

/** Darken a #rrggbb hex toward black (for shaded roof slopes). */
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

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Compile-time exhaustiveness guards (one per return shape needed). */
function assertNever(_x: never): void {
  /* unreachable */
}
function assertNeverNum(_x: never): number {
  return 1;
}
function assertNeverPalette(_x: never): Palette {
  return { body: "#888888", shade: "#666666", roof: "#555555" };
}
