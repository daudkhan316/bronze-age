import {
  PAN_SPEED,
  EDGE_SCROLL_MARGIN,
  ZOOM_STEP,
  WHEEL_NOTCH_PX,
  DEFAULT_SEED,
} from "@/config";
import { Loop } from "@/core/Loop";
import { Game } from "@/game/Game";
import { Renderer } from "@/render/Renderer";
import { Camera } from "@/render/Camera";
import { Input } from "@/input/Input";
import { normalize } from "@/math/Vec2";
import { worldToTile } from "@/math/iso";
import { SelectionController } from "@/selection/SelectionController";
import { PlacementController } from "@/placement/PlacementController";
import { drawWorld } from "@/render/drawWorld";
import { drawFog } from "@/render/drawFog";
import { drawPlacementGhost } from "@/render/drawPlacement";
import { findPath, canStand } from "@/pathfinding/astar";
import {
  CMovement,
  CTransform,
  CUnit,
  CGather,
  CBuild,
  CCombat,
  CBuilding,
  CTrainQueue,
  PLAYER_ID,
  UNIT_STATS,
  BUILDING_DEFS,
  BUILDABLE_KINDS,
  RESOURCE_KINDS,
  type ResourceKind,
  type BuildingKind,
} from "@/game/components";
import { spawnBuilding } from "@/game/spawn";
import { getPlayerState, resourceNodeAtTile } from "@/game/economy";
import { spawnUnit } from "@/game/spawn";
import type { GridPoint } from "@/math/iso";
import type { Entity } from "@/ecs/types";

const canvasEl = document.getElementById("game");
const hudEl = document.getElementById("hud");
if (!(canvasEl instanceof HTMLCanvasElement) || hudEl === null) {
  throw new Error("Bootstrap: #game canvas or #hud element missing");
}
const canvas: HTMLCanvasElement = canvasEl;
const hud: HTMLElement = hudEl;
const resbar = document.getElementById("resbar");
const controls = document.getElementById("controls");

const renderer = new Renderer(canvas);
const camera = new Camera();
const input = new Input(canvas);
const game = new Game(DEFAULT_SEED);
const selection = new SelectionController();
const placement = new PlacementController();

// Start centred on the map.
const center = game.centerWorld();
camera.x = center.x;
camera.y = center.y;

let showGrid = false;
let fps = 0;
/** Attack-move cursor: armed by `F`, consumed by the next left-click. */
let attackMoveArmed = false;

function syncViewport(): void {
  renderer.resize();
  camera.setViewport(renderer.cssWidth, renderer.cssHeight);
}
syncViewport();
window.addEventListener("resize", syncViewport);

/** Update camera from input. Runs at render framerate for smooth panning. */
function updateCamera(frameDt: number): void {
  // Keyboard + edge-scroll pan direction (screen-aligned world axes).
  let dx = 0;
  let dy = 0;
  if (input.isKeyDown("KeyW") || input.isKeyDown("ArrowUp")) dy -= 1;
  if (input.isKeyDown("KeyS") || input.isKeyDown("ArrowDown")) dy += 1;
  if (input.isKeyDown("KeyA") || input.isKeyDown("ArrowLeft")) dx -= 1;
  if (input.isKeyDown("KeyD") || input.isKeyDown("ArrowRight")) dx += 1;

  if (input.pointerInside) {
    if (input.mouseX < EDGE_SCROLL_MARGIN) dx -= 1;
    else if (input.mouseX > renderer.cssWidth - EDGE_SCROLL_MARGIN) dx += 1;
    if (input.mouseY < EDGE_SCROLL_MARGIN) dy -= 1;
    else if (input.mouseY > renderer.cssHeight - EDGE_SCROLL_MARGIN) dy += 1;
  }

  if (dx !== 0 || dy !== 0) {
    const dir = normalize({ x: dx, y: dy });
    // Divide by zoom so pan feels the same speed on screen at any zoom.
    const amount = (PAN_SPEED * frameDt) / camera.zoom;
    camera.panByWorld(dir.x * amount, dir.y * amount);
  }

  // Middle-mouse drag pan: content follows the cursor.
  const drag = input.consumeDrag();
  if (drag.x !== 0 || drag.y !== 0) {
    camera.panByScreen(-drag.x, -drag.y);
  }

  // Wheel zoom toward the cursor. ~100 deltaY per notch; up = zoom in.
  const wheel = input.consumeWheel();
  if (wheel !== 0) {
    const factor = Math.pow(ZOOM_STEP, -wheel / WHEEL_NOTCH_PX);
    camera.zoomAt(input.mouseX, input.mouseY, factor);
  }

  const b = game.worldBounds();
  camera.clampToBounds(b.minX, b.minY, b.maxX, b.maxY);
}

function updateHud(): void {
  const { wx, wy } = camera.screenToWorld(input.mouseX, input.mouseY);
  const { tx, ty } = worldToTile(wx, wy);
  const onMap = game.map.inBounds(tx, ty);
  const tile = onMap ? game.map.get(tx, ty) : "—";
  hud.textContent =
    `Bronze Age — Phase 4\n` +
    `fps   ${fps.toFixed(0)}\n` +
    `tick  ${game.tick}${loop.paused ? "  [PAUSED]" : ""}\n` +
    `zoom  ${camera.zoom.toFixed(2)}x\n` +
    `sel   ${selection.selected.size} unit(s)\n` +
    `tile  ${onMap ? `${tx},${ty} (${tile})` : "off-map"}\n` +
    `grid  ${showGrid ? "on" : "off"}` +
    (loop.droppedTicks > 0 ? `\ndrop  ${loop.droppedTicks}` : "");
}

const RESOURCE_COLORS: Record<ResourceKind, string> = {
  food: "#d96a4a",
  wood: "#7a8b3c",
  gold: "#c9a227",
  stone: "#9aa0a6",
};

/** Refresh the top resource bar and the train button's enabled state. */
function updateResbar(): void {
  if (!(resbar instanceof HTMLElement)) return;
  const p = getPlayerState(game.world, PLAYER_ID);
  if (p === undefined) {
    resbar.textContent = "";
    return;
  }
  let html = "";
  for (const k of RESOURCE_KINDS) {
    const label = k.charAt(0).toUpperCase() + k.slice(1);
    html +=
      `<span class="res"><span class="dot" style="background:${RESOURCE_COLORS[k]}"></span>` +
      `${label} <span class="v">${Math.floor(p[k])}</span></span>`;
  }
  html +=
    `<span class="res"><span class="dot" style="background:#cfd8e0"></span>` +
    `Pop <span class="v">${p.popUsed}/${p.popCap}</span></span>`;
  resbar.innerHTML = html;
}

const MARQUEE_FILL = "rgba(120, 200, 255, 0.12)";
const MARQUEE_STROKE = "rgba(170, 220, 255, 0.9)";

/**
 * Collect up to `count` distinct walkable tiles near `center`, scanning in
 * outward rings. Used to spread a group order so units don't all contend for a
 * single destination tile (which would make the ones that can't fit jitter
 * against it forever) — a lightweight stand-in for AoE-style formations.
 */
function collectDestinations(center: GridPoint, count: number): GridPoint[] {
  const out: GridPoint[] = [];
  for (let r = 0; r <= 24 && out.length < count; r++) {
    for (let dy = -r; dy <= r && out.length < count; dy++) {
      for (let dx = -r; dx <= r && out.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // current ring
        const tx = center.tx + dx;
        const ty = center.ty + dy;
        if (canStand(game.map, tx, ty, game.occ)) out.push({ tx, ty });
      }
    }
  }
  return out;
}

/**
 * Right-click: if the clicked tile holds a resource node, send selected
 * villagers to gather it; otherwise issue a spread move order.
 */
function issueRightClick(): void {
  const { wx, wy } = camera.screenToWorld(input.mouseX, input.mouseY);
  const tile = worldToTile(wx, wy);
  if (!game.map.inBounds(tile.tx, tile.ty)) return;

  const enemy = enemyAtTile(tile.tx, tile.ty);
  if (enemy !== null) {
    assignAttack(enemy);
    return;
  }
  const foundation = foundationAtTile(tile.tx, tile.ty);
  if (foundation !== null) {
    assignBuild(foundation);
    return;
  }
  const node = resourceNodeAtTile(game.world, tile.tx, tile.ty);
  if (node !== null) {
    assignGather(node.entity, node.node.kind);
  } else {
    issueMove(tile);
  }
}

/** Enemy unit on tile (tx,ty), or enemy building whose footprint covers it; else null. */
function enemyAtTile(tx: number, ty: number): Entity | null {
  for (const [e, u] of game.world.query(CUnit)) {
    if (u.owner === PLAYER_ID) continue;
    const tr = game.world.get(e, CTransform);
    if (tr === undefined) continue;
    const t = worldToTile(tr.x, tr.y);
    // Only target an enemy unit the player can actually see (currently in sight).
    if (t.tx === tx && t.ty === ty && game.fog.isVisible(tx, ty)) return e;
  }
  for (const [e, b] of game.world.query(CBuilding)) {
    if (b.owner === PLAYER_ID) continue;
    // Enemy buildings are remembered: targetable once their tile is explored.
    if (tx >= b.tx && tx < b.tx + b.w && ty >= b.ty && ty < b.ty + b.h && game.fog.isExplored(tx, ty)) {
      return e;
    }
  }
  return null;
}

/** Order every selected player unit to attack `target` (CombatSystem chases it). */
function assignAttack(target: Entity): void {
  for (const e of selection.selected) {
    const unit = game.world.get(e, CUnit);
    const cb = game.world.get(e, CCombat);
    const mv = game.world.get(e, CMovement);
    if (unit === undefined || cb === undefined || mv === undefined || unit.owner !== PLAYER_ID) continue;
    cancelTasks(e, mv);
    cb.target = target;
    cb.ordered = true;
    cb.attackMove = null;
  }
}

/** Order selected player units to attack-move toward a tile. */
function issueAttackMove(goal: GridPoint): void {
  for (const e of selection.selected) {
    const unit = game.world.get(e, CUnit);
    const cb = game.world.get(e, CCombat);
    const mv = game.world.get(e, CMovement);
    if (unit === undefined || cb === undefined || mv === undefined || unit.owner !== PLAYER_ID) continue;
    cancelTasks(e, mv);
    cb.target = null;
    cb.ordered = false;
    cb.attackMove = goal;
  }
}

/** Clear a unit's gather/build tasks and current path (shared by all order types). */
function cancelTasks(e: Entity, mv: { path: GridPoint[]; goal: GridPoint | null; stuck: number }): void {
  mv.path = [];
  mv.goal = null;
  mv.stuck = 0;
  if (game.world.has(e, CGather)) game.world.remove(e, CGather);
  if (game.world.has(e, CBuild)) game.world.remove(e, CBuild);
}

/** Clear a unit's combat order (target + attack-move) — a manual order overrides it. */
function clearCombatOrder(e: Entity): void {
  const cb = game.world.get(e, CCombat);
  if (cb !== undefined) {
    cb.target = null;
    cb.ordered = false;
    cb.attackMove = null;
  }
}

/** True if the player has at least one of their own units selected. */
function hasSelectedUnit(): boolean {
  for (const e of selection.selected) {
    const u = game.world.get(e, CUnit);
    if (u !== undefined && u.owner === PLAYER_ID) return true;
  }
  return false;
}

/** Assign every selected player villager to gather the given resource node. */
function assignGather(node: Entity, kind: ResourceKind): void {
  for (const e of selection.selected) {
    const unit = game.world.get(e, CUnit);
    const mv = game.world.get(e, CMovement);
    if (unit === undefined || mv === undefined || unit.owner !== PLAYER_ID) continue;
    if (unit.kind !== "villager") continue; // only villagers gather
    // Hand control to GatherSystem: clear any current walk / build task.
    mv.path = [];
    mv.goal = null;
    mv.stuck = 0;
    if (game.world.has(e, CBuild)) game.world.remove(e, CBuild);
    clearCombatOrder(e);
    const existing = game.world.get(e, CGather);
    if (existing !== undefined) {
      existing.node = node;
      existing.resourceKind = kind;
      existing.carrying = 0;
      existing.state = "toNode";
    } else {
      game.world.add(e, CGather, { node, resourceKind: kind, carrying: 0, state: "toNode" });
    }
  }
}

/** Spread selected units onto distinct standable tiles near `goal` and walk there. */
function issueMove(goal: GridPoint): void {
  const units = [...selection.selected];
  const dests = collectDestinations(goal, units.length);

  for (let i = 0; i < units.length; i++) {
    const e = units[i];
    if (e === undefined) continue;
    const tr = game.world.get(e, CTransform);
    const mv = game.world.get(e, CMovement);
    if (tr === undefined || mv === undefined) continue;

    // A manual move cancels any gathering / building / combat order.
    if (game.world.has(e, CGather)) game.world.remove(e, CGather);
    if (game.world.has(e, CBuild)) game.world.remove(e, CBuild);
    clearCombatOrder(e);

    const dest = dests[i] ?? goal;
    const start = worldToTile(tr.x, tr.y);
    const path = findPath(game.map, start, dest, game.occ);
    mv.path = path;
    // findPath may retarget a blocked goal; the real destination is the last tile.
    mv.goal = path.length > 0 ? (path[path.length - 1] ?? null) : null;
  }
}

type Cost = Partial<Record<ResourceKind, number>>;

/** Can the human player afford `cost`? */
function canAfford(cost: Cost): boolean {
  const p = getPlayerState(game.world, PLAYER_ID);
  if (p === undefined) return false;
  for (const k of RESOURCE_KINDS) {
    if ((cost[k] ?? 0) > p[k]) return false;
  }
  return true;
}

/** Deduct `cost` from the human player's resources (assumes affordability). */
function payCost(cost: Cost): void {
  const p = getPlayerState(game.world, PLAYER_ID);
  if (p === undefined) return;
  for (const k of RESOURCE_KINDS) p[k] -= cost[k] ?? 0;
}

/** Compact cost label like "120 W" or "35 F 25 W". */
function costLabel(cost: Cost): string {
  const letter: Record<ResourceKind, string> = { food: "F", wood: "W", gold: "G", stone: "S" };
  const parts: string[] = [];
  for (const k of RESOURCE_KINDS) {
    const c = cost[k] ?? 0;
    if (c > 0) parts.push(`${c} ${letter[k]}`);
  }
  return parts.length > 0 ? parts.join(" ") : "free";
}

/** Total units queued across all of a player's training buildings. */
function queuedForPlayer(owner: number): number {
  let total = 0;
  for (const [e, b] of game.world.query(CBuilding)) {
    if (b.owner !== owner) continue;
    const tq = game.world.get(e, CTrainQueue);
    if (tq !== undefined) total += tq.queued;
  }
  return total;
}

/** Queue a unit at the currently-selected building, if affordable and pop allows. */
function trainFromSelectedBuilding(): void {
  const be = selection.selectedBuilding;
  if (be === null) return;
  const b = game.world.get(be, CBuilding);
  if (b === undefined || b.owner !== PLAYER_ID || !b.complete) return;
  const trains = BUILDING_DEFS[b.kind].trains;
  if (trains === null) return;
  const tq = game.world.get(be, CTrainQueue);
  const player = getPlayerState(game.world, PLAYER_ID);
  if (tq === undefined || player === undefined) return;

  const cost = UNIT_STATS[trains].cost;
  // Pop is gated on used + already-queued so we never pre-pay (cost is non-refundable).
  if (!canAfford(cost) || player.popUsed + queuedForPlayer(PLAYER_ID) >= player.popCap) return;
  payCost(cost);
  tq.queued += 1;
}

/** The own incomplete building (foundation) covering tile (tx,ty), or null. */
function foundationAtTile(tx: number, ty: number): Entity | null {
  for (const [e, b] of game.world.query(CBuilding)) {
    if (b.owner !== PLAYER_ID || b.complete) continue;
    if (tx >= b.tx && tx < b.tx + b.w && ty >= b.ty && ty < b.ty + b.h) return e;
  }
  return null;
}

/** Assign every selected villager to construct the given foundation. */
function assignBuild(target: Entity): void {
  for (const e of selection.selected) {
    const unit = game.world.get(e, CUnit);
    const mv = game.world.get(e, CMovement);
    if (unit === undefined || mv === undefined || unit.owner !== PLAYER_ID) continue;
    if (unit.kind !== "villager") continue; // only villagers build
    mv.path = [];
    mv.goal = null;
    mv.stuck = 0;
    if (game.world.has(e, CGather)) game.world.remove(e, CGather);
    clearCombatOrder(e);
    const existing = game.world.get(e, CBuild);
    if (existing !== undefined) {
      existing.target = target;
      existing.state = "toSite";
    } else {
      game.world.add(e, CBuild, { target, state: "toSite" });
    }
  }
}

/** Commit the current placement ghost: pay, spawn a foundation, block its tiles. */
function placeBuildingAtGhost(): boolean {
  const ghost = placement.getGhost();
  if (ghost === null || !ghost.valid) return false;
  const def = BUILDING_DEFS[ghost.kind];
  if (!canAfford(def.cost)) return false;
  payCost(def.cost);
  const e = spawnBuilding(game.world, ghost.kind, PLAYER_ID, ghost.tx, ghost.ty, { foundation: true });
  const b = game.world.get(e, CBuilding);
  if (b !== undefined) game.setBuildingOccupancy(b, true);
  return true;
}

/** Game layers over the terrain: depth-sorted world, marquee, placement ghost. */
function drawOverlay(ctx: CanvasRenderingContext2D): void {
  drawWorld(ctx, camera, game.world, selection.selected, selection.selectedBuilding, game.fog);
  // Fog veil sits over the world but under the selection/placement UI.
  drawFog(ctx, camera, game.fog);

  const box = selection.getDragBox();
  if (box !== null) {
    ctx.save();
    ctx.fillStyle = MARQUEE_FILL;
    ctx.strokeStyle = MARQUEE_STROKE;
    ctx.lineWidth = 1;
    ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    ctx.strokeRect(box.x0 + 0.5, box.y0 + 0.5, box.x1 - box.x0, box.y1 - box.y0);
    ctx.restore();
  }

  // Placement ghost sits on top of everything.
  drawPlacementGhost(ctx, camera, placement.getGhost());
}

/** True if the player has at least one of their own villagers selected. */
function hasSelectedVillager(): boolean {
  for (const e of selection.selected) {
    const u = game.world.get(e, CUnit);
    if (u !== undefined && u.owner === PLAYER_ID && u.kind === "villager") return true;
  }
  return false;
}

let lastPanelHtml = "";

/** Rebuild the context command panel from the current selection / placement. */
function updatePanel(): void {
  if (!(controls instanceof HTMLElement)) return;
  let html = "";

  if (attackMoveArmed) {
    html =
      `<div class="panel-title">Attack-move</div>` +
      `<div class="panel-hint">Left-click a destination · Right-click / Esc to cancel</div>`;
  } else if (placement.isActive()) {
    const kind = placement.pendingKind();
    const label = kind !== null ? BUILDING_DEFS[kind].label : "";
    html =
      `<div class="panel-title">Placing: ${label}</div>` +
      `<div class="panel-hint">Left-click to place · Right-click / Esc to cancel</div>` +
      `<button data-action="cancel-place">Cancel</button>`;
  } else if (selection.selectedBuilding !== null) {
    const b = game.world.get(selection.selectedBuilding, CBuilding);
    if (b !== undefined) {
      const def = BUILDING_DEFS[b.kind];
      html = `<div class="panel-title">${def.label}${b.complete ? "" : " — building…"}</div>`;
      if (b.owner === PLAYER_ID && b.complete && def.trains !== null) {
        const ukind = def.trains;
        const ucost = UNIT_STATS[ukind].cost;
        const ulabel = ukind.charAt(0).toUpperCase() + ukind.slice(1);
        const disabled = canAfford(ucost) ? "" : "disabled";
        html += `<button data-action="train" ${disabled}>Train ${ulabel} (${costLabel(ucost)})</button>`;
      }
    }
  } else if (hasSelectedVillager()) {
    html = `<div class="panel-title">Build</div>`;
    for (const kind of BUILDABLE_KINDS) {
      const def = BUILDING_DEFS[kind];
      const disabled = canAfford(def.cost) ? "" : "disabled";
      html += `<button data-action="build:${kind}" ${disabled}>${def.label} (${costLabel(def.cost)})</button>`;
    }
  }

  if (html !== lastPanelHtml) {
    controls.innerHTML = html;
    lastPanelHtml = html;
  }
}

const loop = new Loop({
  fixedUpdate: (dt: number): void => {
    game.fixedUpdate(dt);
  },
  frame: (_alpha: number, frameDt: number): void => {
    // Hotkeys (edge-triggered).
    if (input.wasPressed("Space")) loop.togglePause();
    if (input.wasPressed("KeyG")) showGrid = !showGrid;

    updateCamera(frameDt);

    // Placement mode intercepts clicks; otherwise selection + orders run.
    placement.update(input, camera, game.world, game.map, game.occ);
    if (placement.isActive()) {
      if (input.wasPressed("Escape") || input.wasButtonPressed(2)) {
        placement.cancel();
      } else if (input.wasButtonPressed(0)) {
        const placed = placeBuildingAtGhost();
        const shift = input.isKeyDown("ShiftLeft") || input.isKeyDown("ShiftRight");
        if (placed && !shift) placement.cancel(); // Shift keeps placing.
      }
    } else {
      // Attack-move: press F (with units selected) to arm; next left-click sets it.
      if (input.wasPressed("KeyF") && hasSelectedUnit()) attackMoveArmed = true;

      if (attackMoveArmed) {
        if (input.wasButtonPressed(2)) {
          attackMoveArmed = false; // right-click cancels the armed cursor
        } else if (input.wasButtonPressed(0)) {
          const p = camera.screenToWorld(input.mouseX, input.mouseY);
          const t = worldToTile(p.wx, p.wy);
          if (game.map.inBounds(t.tx, t.ty)) issueAttackMove(t);
          attackMoveArmed = false;
        }
      } else {
        selection.update(input, camera, game.world);
        // Don't fire an order with the stale selection while a marquee is live.
        if (input.wasButtonPressed(2) && selection.getDragBox() === null) issueRightClick();
      }

      if (input.wasPressed("KeyQ")) trainFromSelectedBuilding();
      if (input.wasPressed("Escape")) {
        if (attackMoveArmed) attackMoveArmed = false;
        else selection.clear();
      }
    }

    updatePanel();

    // Smoothed fps for the HUD.
    const instantaneous = frameDt > 0 ? 1 / frameDt : 0;
    fps += (instantaneous - fps) * 0.1;

    renderer.render(camera, game.map, showGrid, drawOverlay);
    updateHud();
    updateResbar();

    input.endFrame();
  },
});

// One delegated listener handles every context-panel button (build / train /
// cancel), so the panel HTML can be rebuilt freely without re-binding.
if (controls instanceof HTMLElement) {
  controls.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("[data-action]");
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.getAttribute("data-action") ?? "";
    if (action === "cancel-place") placement.cancel();
    else if (action === "train") trainFromSelectedBuilding();
    else if (action.startsWith("build:")) placement.begin(action.slice(6) as BuildingKind);
    if (btn instanceof HTMLButtonElement) btn.blur();
  });
}

loop.start();

// Expose for debugging in the browser console.
Object.assign(window as unknown as Record<string, unknown>, {
  game,
  camera,
  loop,
  selection,
  placement,
  getPlayer: () => getPlayerState(game.world, PLAYER_ID),
  queuedForPlayer: () => queuedForPlayer(PLAYER_ID),
  spawn: (kind: "villager" | "spearman" | "archer", tx: number, ty: number, owner: number) =>
    spawnUnit(game.world, kind, tx, ty, owner),
  spawnBuilding: (kind: BuildingKind, owner: number, tx: number, ty: number) => {
    const e = spawnBuilding(game.world, kind, owner, tx, ty);
    const b = game.world.get(e, CBuilding);
    if (b !== undefined) game.setBuildingOccupancy(b, true);
    return e;
  },
});

// On hot-reload, tear down the old loop and listeners so we don't stack a
// second RAF loop / duplicate input handlers on top of the new module.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    loop.stop();
    input.dispose();
    window.removeEventListener("resize", syncViewport);
  });
}
