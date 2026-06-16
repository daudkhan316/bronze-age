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
import { findPath, isWalkable } from "@/pathfinding/astar";
import { CMovement, CTransform } from "@/game/components";
import type { GridPoint } from "@/math/iso";

const canvasEl = document.getElementById("game");
const hudEl = document.getElementById("hud");
if (!(canvasEl instanceof HTMLCanvasElement) || hudEl === null) {
  throw new Error("Bootstrap: #game canvas or #hud element missing");
}
const canvas: HTMLCanvasElement = canvasEl;
const hud: HTMLElement = hudEl;

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
    `Bronze Age — Phase 1\n` +
    `fps   ${fps.toFixed(0)}\n` +
    `tick  ${game.tick}${loop.paused ? "  [PAUSED]" : ""}\n` +
    `zoom  ${camera.zoom.toFixed(2)}x\n` +
    `sel   ${selection.selected.size} unit(s)\n` +
    `tile  ${onMap ? `${tx},${ty} (${tile})` : "off-map"}\n` +
    `grid  ${showGrid ? "on" : "off"}` +
    (loop.droppedTicks > 0 ? `\ndrop  ${loop.droppedTicks}` : "");
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
        if (isWalkable(game.map, tx, ty)) out.push({ tx, ty });
      }
    }
  }
  return out;
}

/** Right-click: order selected units to spread onto walkable tiles near the cursor. */
function issueMoveOrder(): void {
  const { wx, wy } = camera.screenToWorld(input.mouseX, input.mouseY);
  const goal = worldToTile(wx, wy);
  if (!game.map.inBounds(goal.tx, goal.ty)) return;

  const units = [...selection.selected];
  const dests = collectDestinations(goal, units.length);

  for (let i = 0; i < units.length; i++) {
    const e = units[i];
    if (e === undefined) continue;
    const tr = game.world.get(e, CTransform);
    const mv = game.world.get(e, CMovement);
    if (tr === undefined || mv === undefined) continue;

    // Each unit gets its own destination tile; fall back to the clicked tile if
    // the area can't supply enough walkable tiles.
    const dest = dests[i] ?? goal;
    const start = worldToTile(tr.x, tr.y);
    const path = findPath(game.map, start, dest);
    mv.path = path;
    // findPath may retarget a blocked goal; the real destination is the last tile.
    mv.goal = path.length > 0 ? (path[path.length - 1] ?? null) : null;
  }
}

/** Game-specific layers drawn over the terrain: units, then the drag marquee. */
function drawOverlay(ctx: CanvasRenderingContext2D): void {
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

    updateCamera(frameDt);

    // Selection (left mouse) and move orders (right mouse) — both must run
    // before input.endFrame() clears this frame's button edges.
    selection.update(input, camera, game.world);
    if (input.wasButtonPressed(2)) issueMoveOrder();

    // Smoothed fps for the HUD.
    const instantaneous = frameDt > 0 ? 1 / frameDt : 0;
    fps += (instantaneous - fps) * 0.1;

    renderer.render(camera, game.map, showGrid, drawOverlay);
    updateHud();

    input.endFrame();
  },
});

loop.start();

// Expose for debugging in the browser console.
Object.assign(window as unknown as Record<string, unknown>, { game, camera, loop, selection });

// On hot-reload, tear down the old loop and listeners so we don't stack a
// second RAF loop / duplicate input handlers on top of the new module.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    loop.stop();
    input.dispose();
    window.removeEventListener("resize", syncViewport);
  });
}
