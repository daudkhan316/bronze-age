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
import { drawUnits } from "@/render/drawUnits";
import { drawResources } from "@/render/drawResources";
import { drawBuildings } from "@/render/drawBuildings";
import { findPath, canStand } from "@/pathfinding/astar";
import {
  CMovement,
  CTransform,
  CUnit,
  CGather,
  CBuilding,
  CTrainQueue,
  PLAYER_ID,
  VILLAGER_COST,
  RESOURCE_KINDS,
  type ResourceKind,
} from "@/game/components";
import { getPlayerState, resourceNodeAtTile } from "@/game/economy";
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
const trainBtn = document.getElementById("train-villager");

const renderer = new Renderer(canvas);
const camera = new Camera();
const input = new Input(canvas);
const game = new Game(DEFAULT_SEED);
const selection = new SelectionController();

// Start centred on the map.
const center = game.centerWorld();
camera.x = center.x;
camera.y = center.y;

let showGrid = false;
let fps = 0;

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
    `Bronze Age — Phase 2\n` +
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

  if (trainBtn instanceof HTMLButtonElement) {
    trainBtn.disabled = !canTrainVillager();
  }
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

  const node = resourceNodeAtTile(game.world, tile.tx, tile.ty);
  if (node !== null) {
    assignGather(node.entity, node.node.kind);
  } else {
    issueMove(tile);
  }
}

/** Assign every selected player villager to gather the given resource node. */
function assignGather(node: Entity, kind: ResourceKind): void {
  for (const e of selection.selected) {
    const unit = game.world.get(e, CUnit);
    const mv = game.world.get(e, CMovement);
    if (unit === undefined || mv === undefined || unit.owner !== PLAYER_ID) continue;
    // Hand control to GatherSystem: clear any current walk so it can re-path.
    mv.path = [];
    mv.goal = null;
    mv.stuck = 0;
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

    // A manual move cancels any gathering task.
    if (game.world.has(e, CGather)) game.world.remove(e, CGather);

    const dest = dests[i] ?? goal;
    const start = worldToTile(tr.x, tr.y);
    const path = findPath(game.map, start, dest, game.occ);
    mv.path = path;
    // findPath may retarget a blocked goal; the real destination is the last tile.
    mv.goal = path.length > 0 ? (path[path.length - 1] ?? null) : null;
  }
}

/** Total villagers queued across a player's Town Centers (not yet spawned). */
function queuedForPlayer(owner: number): number {
  let total = 0;
  for (const [e, b] of game.world.query(CBuilding)) {
    if (b.owner !== owner || b.kind !== "town_center") continue;
    const tq = game.world.get(e, CTrainQueue);
    if (tq !== undefined) total += tq.queued;
  }
  return total;
}

/** Whether the player can currently afford and house another trained villager. */
function canTrainVillager(): boolean {
  const player = getPlayerState(game.world, PLAYER_ID);
  if (player === undefined) return false;
  const cost = VILLAGER_COST.food ?? 0;
  // Count already-queued villagers against the cap so we never pre-pay for
  // villagers that can't spawn (the cost is non-refundable).
  return player.food >= cost && player.popUsed + queuedForPlayer(PLAYER_ID) < player.popCap;
}

/** Queue a villager at the player's Town Center if affordable and pop allows. */
function trainVillager(): void {
  if (!canTrainVillager()) return;
  const player = getPlayerState(game.world, PLAYER_ID);
  if (player === undefined) return;
  const cost = VILLAGER_COST.food ?? 0;

  for (const [e, b] of game.world.query(CBuilding)) {
    if (b.owner !== PLAYER_ID || b.kind !== "town_center") continue;
    const tq = game.world.get(e, CTrainQueue);
    if (tq === undefined) continue;
    player.food -= cost; // charged on enqueue (EconomySystem only counts down)
    tq.queued += 1;
    return;
  }
}

/** Game-specific layers over the terrain: resources, buildings, units, marquee. */
function drawOverlay(ctx: CanvasRenderingContext2D): void {
  drawResources(ctx, camera, game.world);
  drawBuildings(ctx, camera, game.world);
  drawUnits(ctx, camera, game.world, selection.selected);

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
}

const loop = new Loop({
  fixedUpdate: (dt: number): void => {
    game.fixedUpdate(dt);
  },
  frame: (_alpha: number, frameDt: number): void => {
    // Hotkeys (edge-triggered).
    if (input.wasPressed("Space")) loop.togglePause();
    if (input.wasPressed("KeyG")) showGrid = !showGrid;
    if (input.wasPressed("KeyQ")) trainVillager();

    updateCamera(frameDt);

    // Selection (left mouse) and orders (right mouse) — both must run before
    // input.endFrame() clears this frame's button edges.
    selection.update(input, camera, game.world);
    if (input.wasButtonPressed(2)) issueRightClick();

    // Smoothed fps for the HUD.
    const instantaneous = frameDt > 0 ? 1 / frameDt : 0;
    fps += (instantaneous - fps) * 0.1;

    renderer.render(camera, game.map, showGrid, drawOverlay);
    updateHud();
    updateResbar();

    input.endFrame();
  },
});

if (trainBtn instanceof HTMLButtonElement) {
  trainBtn.addEventListener("click", () => {
    trainVillager();
    trainBtn.blur(); // so Space/Q don't re-trigger the focused button
  });
}

loop.start();

// Expose for debugging in the browser console.
Object.assign(window as unknown as Record<string, unknown>, {
  game,
  camera,
  loop,
  selection,
  getPlayer: () => getPlayerState(game.world, PLAYER_ID),
  queuedForPlayer: () => queuedForPlayer(PLAYER_ID),
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
