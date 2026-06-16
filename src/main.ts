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
    `Bronze Age — Phase 0\n` +
    `fps   ${fps.toFixed(0)}\n` +
    `tick  ${game.tick}${loop.paused ? "  [PAUSED]" : ""}\n` +
    `zoom  ${camera.zoom.toFixed(2)}x\n` +
    `cam   ${camera.x.toFixed(0)}, ${camera.y.toFixed(0)}\n` +
    `tile  ${onMap ? `${tx},${ty} (${tile})` : "off-map"}\n` +
    `grid  ${showGrid ? "on" : "off"}` +
    (loop.droppedTicks > 0 ? `\ndrop  ${loop.droppedTicks}` : "");
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

    // Smoothed fps for the HUD.
    const instantaneous = frameDt > 0 ? 1 / frameDt : 0;
    fps += (instantaneous - fps) * 0.1;

    renderer.render(camera, game.map, showGrid);
    updateHud();

    input.endFrame();
  },
});

loop.start();

// Expose for debugging in the browser console.
Object.assign(window as unknown as Record<string, unknown>, { game, camera, loop });
