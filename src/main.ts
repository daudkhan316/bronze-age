import {
  PAN_SPEED,
  EDGE_SCROLL_MARGIN,
  ZOOM_STEP,
  WHEEL_NOTCH_PX,
} from "@/config";
import { Loop } from "@/core/Loop";
import { Game } from "@/game/Game";
import type { GameSnapshot } from "@/game/Game";
import { Renderer } from "@/render/Renderer";
import { Camera } from "@/render/Camera";
import { Input } from "@/input/Input";
import { normalize } from "@/math/Vec2";
import { worldToTile } from "@/math/iso";
import { SelectionController } from "@/selection/SelectionController";
import { PlacementController } from "@/placement/PlacementController";
import { Lobby } from "@/ui/Lobby";
import { drawWorld } from "@/render/drawWorld";
import { drawFog } from "@/render/drawFog";
import { drawPlacementGhost } from "@/render/drawPlacement";
import { drawMinimap, minimapToWorld } from "@/render/drawMinimap";
import { SoundBank } from "@/audio/SoundBank";
import {
  CUnit,
  CTransform,
  CBuilding,
  CTrainQueue,
  CResearch,
  PLAYER_ID,
  UNIT_STATS,
  BUILDING_DEFS,
  BUILDABLE_KINDS,
  UPGRADE_DEFS,
  AGE_NAMES,
  RESOURCE_KINDS,
  type ResourceKind,
  type BuildingKind,
  type UpgradeId,
} from "@/game/components";
import { getPlayerState, getMatchState, resourceNodeAtTile } from "@/game/economy";
import { availableResearch } from "@/game/tech";
import { spawnUnit, spawnBuilding } from "@/game/spawn";
import type { MatchConfig } from "@/game/match";
import type { GridPoint } from "@/math/iso";
import type { Entity } from "@/ecs/types";

const canvasEl = document.getElementById("game");
const hudEl = document.getElementById("hud");
const menuEl = document.getElementById("menu");
const gameoverEl = document.getElementById("gameover");
if (
  !(canvasEl instanceof HTMLCanvasElement) ||
  hudEl === null ||
  !(menuEl instanceof HTMLElement) ||
  !(gameoverEl instanceof HTMLElement)
) {
  throw new Error("Bootstrap: a required DOM element (#game/#hud/#menu/#gameover) is missing");
}
const canvas: HTMLCanvasElement = canvasEl;
const hud: HTMLElement = hudEl;
const menu: HTMLElement = menuEl;
const gameover: HTMLElement = gameoverEl;
const resbar = document.getElementById("resbar");
const controls = document.getElementById("controls");
const toolbar = document.getElementById("toolbar");
const minimapEl = document.getElementById("minimap");
const minimapCanvas = minimapEl instanceof HTMLCanvasElement ? minimapEl : null;
const minimapCtx = minimapCanvas?.getContext("2d") ?? null;
/** localStorage key for the single quick-save slot. */
const SAVE_KEY = "bronze-age-save";
/** localStorage key remembering the player's mute preference. */
const MUTE_KEY = "bronze-age-muted";

// Persistent across matches: renderer + raw input + the lobby + the sound bank.
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const lobby = new Lobby(menu, startMatch);
const sound = new SoundBank(localStorage.getItem(MUTE_KEY) === "1");

/** Per-match state. Null while in the menu. Rebuilt on each Start. */
interface Session {
  game: Game;
  camera: Camera;
  selection: SelectionController;
  placement: PlacementController;
  /** Attack-move cursor: armed by `F`, consumed by the next left-click. */
  attackMoveArmed: boolean;
}
let session: Session | null = null;
let appState: "menu" | "playing" | "gameover" = "menu";

let showGrid = false;
let fps = 0;

function syncViewport(): void {
  renderer.resize();
  if (session !== null) session.camera.setViewport(renderer.cssWidth, renderer.cssHeight);
}
syncViewport();
window.addEventListener("resize", syncViewport);

// --- match lifecycle -------------------------------------------------------

/** Build a fresh match from the lobby config and switch to play. */
function startMatch(config: MatchConfig): void {
  const game = new Game(config);
  const camera = new Camera();
  camera.setViewport(renderer.cssWidth, renderer.cssHeight);
  const start = game.playerCenterWorld(PLAYER_ID);
  camera.x = start.x;
  camera.y = start.y;
  const b = game.worldBounds();
  camera.clampToBounds(b.minX, b.minY, b.maxX, b.maxY);

  session = {
    game,
    camera,
    selection: new SelectionController(),
    placement: new PlacementController(),
    attackMoveArmed: false,
  };
  lobby.hide();
  gameover.hidden = true;
  appState = "playing";
  if (loop.paused) loop.togglePause();
  exposeDebug(session);
}

/** Show the victory/defeat screen (the final frame stays behind it). */
function endMatch(winner: number | null): void {
  appState = "gameover";
  const won = winner === PLAYER_ID;
  sound.play(won ? "victory" : "defeat");
  gameover.innerHTML =
    `<div class="panel">` +
    `<h1 class="${won ? "win" : "lose"}">${won ? "Victory" : "Defeat"}</h1>` +
    `<p class="sub">${won ? "The enemy has been wiped out." : "Your civilization has fallen."}</p>` +
    `<button class="primary" data-action="again">Play again</button>` +
    `</div>`;
  const again = gameover.querySelector('[data-action="again"]');
  if (again instanceof HTMLButtonElement) again.addEventListener("click", backToMenu);
  gameover.hidden = false;
}

/** Tear the match down and return to the lobby. */
function backToMenu(): void {
  session = null;
  appState = "menu";
  gameover.hidden = true;
  lobby.show();
}

/** Update camera from input. Runs at render framerate for smooth panning. */
function updateCamera(s: Session, frameDt: number): void {
  const camera = s.camera;
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
    const amount = (PAN_SPEED * frameDt) / camera.zoom;
    camera.panByWorld(dir.x * amount, dir.y * amount);
  }

  const drag = input.consumeDrag();
  if (drag.x !== 0 || drag.y !== 0) camera.panByScreen(-drag.x, -drag.y);

  const wheel = input.consumeWheel();
  if (wheel !== 0) {
    const factor = Math.pow(ZOOM_STEP, -wheel / WHEEL_NOTCH_PX);
    camera.zoomAt(input.mouseX, input.mouseY, factor);
  }

  const b = s.game.worldBounds();
  camera.clampToBounds(b.minX, b.minY, b.maxX, b.maxY);
}

function updateHud(s: Session): void {
  const { wx, wy } = s.camera.screenToWorld(input.mouseX, input.mouseY);
  const { tx, ty } = worldToTile(wx, wy);
  const onMap = s.game.map.inBounds(tx, ty);
  const tile = onMap ? s.game.map.get(tx, ty) : "—";
  const p = getPlayerState(s.game.world, PLAYER_ID);
  const ageName = p !== undefined ? (AGE_NAMES[p.age] ?? `Age ${p.age}`) : "—";
  hud.textContent =
    `Bronze Age — Phase 6\n` +
    `fps   ${fps.toFixed(0)}\n` +
    `tick  ${s.game.tick}${loop.paused ? "  [PAUSED]" : ""}\n` +
    `age   ${ageName}\n` +
    `zoom  ${s.camera.zoom.toFixed(2)}x\n` +
    `sel   ${s.selection.selected.size} unit(s)\n` +
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

/** Refresh the top resource bar from the human player's economy. */
function updateResbar(s: Session): void {
  if (!(resbar instanceof HTMLElement)) return;
  const p = getPlayerState(s.game.world, PLAYER_ID);
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
 * Right-click: enemy → attack, own foundation → build, resource → gather, else
 * a spread move order. Each branch ENQUEUES a command (applied on the next tick).
 */
function issueRightClick(s: Session): void {
  const { wx, wy } = s.camera.screenToWorld(input.mouseX, input.mouseY);
  const tile = worldToTile(wx, wy);
  if (!s.game.map.inBounds(tile.tx, tile.ty)) return;

  const units = selectedPlayerUnits(s);
  if (units.length === 0) return;

  const enemy = enemyAtTile(s, tile.tx, tile.ty);
  if (enemy !== null) {
    s.game.commands.enqueue({ type: "attack", owner: PLAYER_ID, units, target: enemy });
    sound.play("attack");
    return;
  }
  const foundation = foundationAtTile(s, tile.tx, tile.ty);
  if (foundation !== null) {
    const villagers = units.filter((e) => unitKind(s, e) === "villager");
    if (villagers.length > 0) {
      s.game.commands.enqueue({ type: "assignBuild", owner: PLAYER_ID, villagers, target: foundation });
      sound.play("command");
    }
    return;
  }
  const node = resourceNodeAtTile(s.game.world, tile.tx, tile.ty);
  if (node !== null) {
    const villagers = units.filter((e) => unitKind(s, e) === "villager");
    if (villagers.length > 0) {
      s.game.commands.enqueue({ type: "gather", owner: PLAYER_ID, units: villagers, node: node.entity });
      sound.play("command");
    }
  } else {
    s.game.commands.enqueue({ type: "move", owner: PLAYER_ID, units, tx: tile.tx, ty: tile.ty });
    sound.play("command");
  }
}

/** Selected entities that are the human player's living units (in selection order). */
function selectedPlayerUnits(s: Session): Entity[] {
  const out: Entity[] = [];
  for (const e of s.selection.selected) {
    const u = s.game.world.get(e, CUnit);
    if (u !== undefined && u.owner === PLAYER_ID) out.push(e);
  }
  return out;
}

function unitKind(s: Session, e: Entity): string | undefined {
  return s.game.world.get(e, CUnit)?.kind;
}

/** Enemy unit on tile (fog-gated to currently visible), or enemy building whose
 *  footprint covers it (targetable once explored); else null. */
function enemyAtTile(s: Session, tx: number, ty: number): Entity | null {
  const { game } = s;
  for (const [e, u] of game.world.query(CUnit)) {
    if (u.owner === PLAYER_ID) continue;
    const pos = game.world.get(e, CTransform);
    if (pos === undefined) continue;
    const t = worldToTile(pos.x, pos.y);
    if (t.tx === tx && t.ty === ty && game.fog.isVisible(tx, ty)) return e;
  }
  for (const [e, b] of game.world.query(CBuilding)) {
    if (b.owner === PLAYER_ID) continue;
    if (tx >= b.tx && tx < b.tx + b.w && ty >= b.ty && ty < b.ty + b.h && game.fog.isExplored(tx, ty)) {
      return e;
    }
  }
  return null;
}

/** Issue an attack-move to a tile for the current selection. */
function issueAttackMove(s: Session, goal: GridPoint): void {
  const units = selectedPlayerUnits(s);
  if (units.length === 0) return;
  s.game.commands.enqueue({ type: "attackMove", owner: PLAYER_ID, units, tx: goal.tx, ty: goal.ty });
  sound.play("attack");
}

/** True if the player has at least one of their own units selected. */
function hasSelectedUnit(s: Session): boolean {
  return selectedPlayerUnits(s).length > 0;
}

type Cost = Partial<Record<ResourceKind, number>>;

/** Can the human player afford `cost`? (UI gating only; the executor re-checks.) */
function canAfford(s: Session, cost: Cost): boolean {
  const p = getPlayerState(s.game.world, PLAYER_ID);
  if (p === undefined) return false;
  for (const k of RESOURCE_KINDS) {
    if ((cost[k] ?? 0) > p[k]) return false;
  }
  return true;
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

/** Total units queued across all of the player's training buildings. */
function queuedForPlayer(s: Session): number {
  let total = 0;
  for (const [e, b] of s.game.world.query(CBuilding)) {
    if (b.owner !== PLAYER_ID) continue;
    const tq = s.game.world.get(e, CTrainQueue);
    if (tq !== undefined) total += tq.queued;
  }
  return total;
}

/** Enqueue a train command at the currently-selected building (if it allows). */
function trainFromSelectedBuilding(s: Session): void {
  const be = s.selection.selectedBuilding;
  if (be === null) return;
  const b = s.game.world.get(be, CBuilding);
  if (b === undefined || b.owner !== PLAYER_ID || !b.complete) return;
  const trains = BUILDING_DEFS[b.kind].trains;
  if (trains === null) return;
  const player = getPlayerState(s.game.world, PLAYER_ID);
  if (player === undefined) return;
  const cost = UNIT_STATS[trains].cost;
  if (!canAfford(s, cost) || player.popUsed + queuedForPlayer(s) >= player.popCap) return;
  s.game.commands.enqueue({ type: "train", owner: PLAYER_ID, building: be, unit: trains });
  sound.play("ui");
}

/** Enqueue a research command for the selected building (executor re-validates). */
function researchFromSelectedBuilding(s: Session, id: UpgradeId): void {
  const be = s.selection.selectedBuilding;
  if (be === null) return;
  s.game.commands.enqueue({ type: "research", owner: PLAYER_ID, building: be, upgrade: id });
  sound.play("ui");
}

/** The own incomplete building (foundation) covering tile (tx,ty), or null. */
function foundationAtTile(s: Session, tx: number, ty: number): Entity | null {
  for (const [e, b] of s.game.world.query(CBuilding)) {
    if (b.owner !== PLAYER_ID || b.complete) continue;
    if (tx >= b.tx && tx < b.tx + b.w && ty >= b.ty && ty < b.ty + b.h) return e;
  }
  return null;
}

/** Commit the placement ghost: enqueue a build command (executor pays + spawns). */
function placeBuildingAtGhost(s: Session): boolean {
  const ghost = s.placement.getGhost();
  if (ghost === null || !ghost.valid) return false;
  s.game.commands.enqueue({
    type: "build",
    owner: PLAYER_ID,
    kind: ghost.kind,
    tx: ghost.tx,
    ty: ghost.ty,
    builders: [],
  });
  sound.play("place");
  return true;
}

/** Game layers over the terrain: depth-sorted world, marquee, placement ghost. */
function drawOverlay(s: Session, ctx: CanvasRenderingContext2D): void {
  drawWorld(ctx, s.camera, s.game.world, s.selection.selected, s.selection.selectedBuilding, s.game.fog);
  drawFog(ctx, s.camera, s.game.fog);

  const box = s.selection.getDragBox();
  if (box !== null) {
    ctx.save();
    ctx.fillStyle = MARQUEE_FILL;
    ctx.strokeStyle = MARQUEE_STROKE;
    ctx.lineWidth = 1;
    ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    ctx.strokeRect(box.x0 + 0.5, box.y0 + 0.5, box.x1 - box.x0, box.y1 - box.y0);
    ctx.restore();
  }

  drawPlacementGhost(ctx, s.camera, s.placement.getGhost());
}

/** True if the player has at least one of their own villagers selected. */
function hasSelectedVillager(s: Session): boolean {
  return selectedPlayerUnits(s).some((e) => unitKind(s, e) === "villager");
}

/** Control groups: Ctrl/Cmd+1–9 binds the current selection; 1–9 recalls it. */
function handleControlGroups(s: Session): void {
  const ctrl =
    input.isKeyDown("ControlLeft") ||
    input.isKeyDown("ControlRight") ||
    input.isKeyDown("MetaLeft") ||
    input.isKeyDown("MetaRight");
  for (let n = 1; n <= 9; n++) {
    if (!input.wasPressed(`Digit${n}`)) continue;
    if (ctrl) s.selection.setGroup(n);
    else s.selection.recallGroup(n, s.game.world);
  }
}

/**
 * Drain the simulation's view-event buffer and play feedback sounds. Combat
 * events are fog-gated (you only hear what you can see); your own train/build
 * completions are owner-gated. Called once per rendered frame, so it catches the
 * events from however many sim ticks ran since the last frame.
 */
function routeSimAudio(s: Session): void {
  const fog = s.game.fog;
  for (const ev of s.game.events.drain()) {
    switch (ev.type) {
      case "projectile_fired":
      case "melee_hit":
      case "unit_died":
      case "building_destroyed": {
        // You always hear your OWN losses: a dying unit/building may have been
        // the only thing giving vision over its tile (FogSystem re-reveals from
        // *living* entities, and it's already reaped by the time we play this),
        // so fog-gating would wrongly mute your forward outpost falling. Enemy
        // and neutral combat stays fog-gated — you only hear what you can see.
        const ownLoss =
          (ev.type === "unit_died" || ev.type === "building_destroyed") && ev.owner === PLAYER_ID;
        if (!ownLoss) {
          const t = worldToTile(ev.x, ev.y);
          if (!s.game.map.inBounds(t.tx, t.ty) || !fog.isVisible(t.tx, t.ty)) break;
        }
        sound.play(
          ev.type === "projectile_fired"
            ? "fire"
            : ev.type === "melee_hit"
              ? "hit"
              : ev.type === "unit_died"
                ? "death"
                : "collapse",
        );
        break;
      }
      case "unit_trained":
        if (ev.owner === PLAYER_ID) sound.play("trained");
        break;
      case "building_completed":
        if (ev.owner === PLAYER_ID) sound.play("built");
        break;
    }
  }
}

/** A cheap signature of the current selection (size + lowest entity id). */
function selectionSignature(s: Session): string {
  const sel = s.selection.selected;
  if (sel.size === 0) return "";
  let min = Infinity;
  for (const e of sel) if (e < min) min = e;
  return `${sel.size}:${min}`;
}

let prevSelSig = "";
let lastPanelHtml = "";

/** Rebuild the context command panel from the current selection / placement. */
function updatePanel(s: Session): void {
  if (!(controls instanceof HTMLElement)) return;
  let html = "";

  if (s.attackMoveArmed) {
    html =
      `<div class="panel-title">Attack-move</div>` +
      `<div class="panel-hint">Left-click a destination · Right-click / Esc to cancel</div>`;
  } else if (s.placement.isActive()) {
    const kind = s.placement.pendingKind();
    const label = kind !== null ? BUILDING_DEFS[kind].label : "";
    html =
      `<div class="panel-title">Placing: ${label}</div>` +
      `<div class="panel-hint">Left-click to place · Right-click / Esc to cancel</div>` +
      `<button data-action="cancel-place">Cancel</button>`;
  } else if (s.selection.selectedBuilding !== null) {
    const be = s.selection.selectedBuilding;
    const b = s.game.world.get(be, CBuilding);
    if (b !== undefined) {
      const def = BUILDING_DEFS[b.kind];
      html = `<div class="panel-title">${def.label}${b.complete ? "" : " — building…"}</div>`;
      if (b.owner === PLAYER_ID && b.complete) {
        if (def.trains !== null) {
          const ukind = def.trains;
          const ucost = UNIT_STATS[ukind].cost;
          const ulabel = ukind.charAt(0).toUpperCase() + ukind.slice(1);
          const disabled = canAfford(s, ucost) ? "" : "disabled";
          html += `<button data-action="train" ${disabled}>Train ${ulabel} (${costLabel(ucost)})</button>`;
        }
        // Research (Phase 6): an in-progress label, else the available upgrades.
        const research = s.game.world.get(be, CResearch);
        if (research !== undefined) {
          const pct = Math.floor((research.progress / research.required) * 100);
          html += `<div class="panel-hint">Researching ${UPGRADE_DEFS[research.id].label} (${pct}%)</div>`;
        } else {
          for (const id of availableResearch(s.game.world, PLAYER_ID, be)) {
            const ud = UPGRADE_DEFS[id];
            const disabled = canAfford(s, ud.cost) ? "" : "disabled";
            html += `<button data-action="research:${id}" ${disabled}>${ud.label} (${costLabel(ud.cost)})</button>`;
          }
        }
      }
    }
  } else if (hasSelectedVillager(s)) {
    html = `<div class="panel-title">Build</div>`;
    const age = getPlayerState(s.game.world, PLAYER_ID)?.age ?? 1;
    for (const kind of BUILDABLE_KINDS) {
      const def = BUILDING_DEFS[kind];
      if (def.ageRequired > age) continue; // not unlocked in this age yet — hide it
      const disabled = canAfford(s, def.cost) ? "" : "disabled";
      html += `<button data-action="build:${kind}" ${disabled}>${def.label} (${costLabel(def.cost)})</button>`;
    }
  }

  if (html !== lastPanelHtml) {
    controls.innerHTML = html;
    lastPanelHtml = html;
  }
}

/** Per-frame play logic: input → orders, then render. */
function frameGame(s: Session, frameDt: number): void {
  if (input.wasPressed("Space")) loop.togglePause();
  if (input.wasPressed("KeyG")) showGrid = !showGrid;
  if (input.wasPressed("KeyM")) toggleMute();

  // Play feedback for whatever the sim emitted since the last frame.
  routeSimAudio(s);

  updateCamera(s, frameDt);
  handleControlGroups(s);

  s.placement.update(input, s.camera, s.game.world, s.game.map, s.game.occ);
  if (s.placement.isActive()) {
    if (input.wasPressed("Escape") || input.wasButtonPressed(2)) {
      s.placement.cancel();
    } else if (input.wasButtonPressed(0)) {
      const placed = placeBuildingAtGhost(s);
      const shift = input.isKeyDown("ShiftLeft") || input.isKeyDown("ShiftRight");
      if (placed && !shift) s.placement.cancel(); // Shift keeps placing.
    }
  } else {
    if (input.wasPressed("KeyF") && hasSelectedUnit(s)) s.attackMoveArmed = true;

    if (s.attackMoveArmed) {
      if (input.wasButtonPressed(2)) {
        s.attackMoveArmed = false;
      } else if (input.wasButtonPressed(0)) {
        const p = s.camera.screenToWorld(input.mouseX, input.mouseY);
        const t = worldToTile(p.wx, p.wy);
        if (s.game.map.inBounds(t.tx, t.ty)) issueAttackMove(s, t);
        s.attackMoveArmed = false;
      }
    } else {
      s.selection.update(input, s.camera, s.game.world);
      if (input.wasButtonPressed(2) && s.selection.getDragBox() === null) issueRightClick(s);
    }

    if (input.wasPressed("KeyQ")) trainFromSelectedBuilding(s);
    if (input.wasPressed("Escape")) {
      if (s.attackMoveArmed) s.attackMoveArmed = false;
      else s.selection.clear();
    }
  }

  updatePanel(s);

  // A new, non-empty selection (click / box / double-click / control-group
  // recall) plays a select blip; clearing is silent.
  const sig = selectionSignature(s);
  if (sig !== prevSelSig) {
    if (sig !== "") sound.play("select");
    prevSelSig = sig;
  }

  const instantaneous = frameDt > 0 ? 1 / frameDt : 0;
  fps += (instantaneous - fps) * 0.1;

  renderer.render(s.camera, s.game.map, showGrid, (ctx) => drawOverlay(s, ctx));
  updateHud(s);
  updateResbar(s);
  if (minimapCanvas !== null && minimapCtx !== null) {
    drawMinimap(minimapCtx, minimapCanvas.width, minimapCanvas.height, s.game.map, s.game.world, s.game.fog, s.camera);
  }
}

const loop = new Loop({
  fixedUpdate: (dt: number): void => {
    if (appState === "playing" && session !== null) session.game.fixedUpdate(dt);
  },
  frame: (_alpha: number, frameDt: number): void => {
    if (appState === "playing" && session !== null) {
      // Check the outcome BEFORE running a frame of input — so the frame that
      // decides the match doesn't also process orders against an ended game.
      const m = getMatchState(session.game.world);
      if (m !== undefined && m.over) {
        // Play the deciding tick's death/collapse (the winning blow) before the
        // outcome jingle — frameGame, the only other drain site, is skipped now.
        routeSimAudio(session);
        endMatch(m.winner);
      } else frameGame(session, frameDt);
    }
    input.endFrame();
  },
});

// One delegated listener handles every context-panel button.
if (controls instanceof HTMLElement) {
  controls.addEventListener("click", (ev) => {
    if (session === null || appState !== "playing") return;
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("[data-action]");
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.getAttribute("data-action") ?? "";
    // train / research play their own sound on a successful enqueue; the other
    // two (begin-placement, cancel) get a plain UI click here.
    if (action === "cancel-place") {
      session.placement.cancel();
      sound.play("ui");
    } else if (action === "train") {
      trainFromSelectedBuilding(session);
    } else if (action.startsWith("research:")) {
      researchFromSelectedBuilding(session, action.slice(9) as UpgradeId);
    } else if (action.startsWith("build:")) {
      session.placement.begin(action.slice(6) as BuildingKind);
      sound.play("ui");
    }
    if (btn instanceof HTMLButtonElement) btn.blur();
  });
}

// --- save / load / minimap navigation -------------------------------------

let saveStatusTimer = 0;
/** Briefly show a status message in the toolbar. */
function flashToolbar(msg: string): void {
  const el = document.getElementById("savestatus");
  if (!(el instanceof HTMLElement)) return;
  el.textContent = msg;
  window.clearTimeout(saveStatusTimer);
  saveStatusTimer = window.setTimeout(() => {
    el.textContent = "";
  }, 1600);
}

/** Reflect the current mute state on the toolbar button. */
function updateMuteButton(): void {
  const el = document.getElementById("mutebtn");
  if (el instanceof HTMLElement) el.textContent = sound.isMuted ? "🔇" : "🔊";
}

/** Toggle sound on/off, persist the choice, and show a brief toast. */
function toggleMute(): void {
  const muted = sound.toggleMute();
  localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  updateMuteButton();
  flashToolbar(muted ? "Muted" : "Sound on");
}

/** Quick-save the live match to localStorage (a single slot). */
function saveGame(): void {
  if (session === null) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(session.game.serialize()));
    flashToolbar("Saved");
  } catch {
    flashToolbar("Save failed");
  }
}

/** Load the quick-save, rebuilding the session around the restored game. */
function loadGame(): void {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw === null) {
    flashToolbar("No save");
    return;
  }
  let game: Game;
  try {
    game = Game.deserialize(JSON.parse(raw) as GameSnapshot);
  } catch {
    flashToolbar("Load failed");
    return;
  }

  // Keep the existing camera if we were mid-match, else centre on the human base.
  const camera = session?.camera ?? new Camera();
  camera.setViewport(renderer.cssWidth, renderer.cssHeight);
  if (session === null) {
    const c = game.playerCenterWorld(PLAYER_ID);
    camera.x = c.x;
    camera.y = c.y;
  }
  const b = game.worldBounds();
  camera.clampToBounds(b.minX, b.minY, b.maxX, b.maxY);

  session = {
    game,
    camera,
    selection: new SelectionController(),
    placement: new PlacementController(),
    attackMoveArmed: false,
  };
  lobby.hide();
  gameover.hidden = true;
  appState = "playing";
  if (loop.paused) loop.togglePause();
  exposeDebug(session);
  flashToolbar("Loaded");
}

// Listeners added below are collected here so hot-reload can remove them and
// not stack duplicates on the persistent DOM/window across dev reloads.
const hotDisposers: Array<() => void> = [];

// Toolbar: Save / Load / Menu.
if (toolbar instanceof HTMLElement) {
  const onToolbarClick = (ev: MouseEvent): void => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("[data-action]");
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.getAttribute("data-action");
    if (action === "mute") {
      toggleMute();
    } else {
      sound.play("ui");
      if (action === "save") saveGame();
      else if (action === "load") loadGame();
      else if (action === "menu" && session !== null) backToMenu();
    }
    if (btn instanceof HTMLButtonElement) btn.blur();
  };
  toolbar.addEventListener("click", onToolbarClick);
  hotDisposers.push(() => toolbar.removeEventListener("click", onToolbarClick));
}

// Minimap: click / drag to recentre the camera on the clicked world point.
if (minimapCanvas !== null) {
  const mm = minimapCanvas;
  let minimapDragging = false;
  const recentre = (ev: MouseEvent): void => {
    if (session === null || appState !== "playing") return;
    const rect = mm.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const mx = (ev.clientX - rect.left) * (mm.width / rect.width);
    const my = (ev.clientY - rect.top) * (mm.height / rect.height);
    const w = minimapToWorld(mx, my, mm.width, mm.height, session.game.map);
    session.camera.x = w.x;
    session.camera.y = w.y;
    const b = session.game.worldBounds();
    session.camera.clampToBounds(b.minX, b.minY, b.maxX, b.maxY);
  };
  const onDown = (ev: MouseEvent): void => {
    minimapDragging = true;
    recentre(ev);
    ev.preventDefault();
  };
  const onMove = (ev: MouseEvent): void => {
    if (minimapDragging) recentre(ev);
  };
  const onUp = (): void => {
    minimapDragging = false;
  };
  mm.addEventListener("mousedown", onDown);
  mm.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  hotDisposers.push(() => {
    mm.removeEventListener("mousedown", onDown);
    mm.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  });
}

// WebAudio can't start until a user gesture; resume the context on the first
// interaction (the lobby's Start click satisfies this before any match begins).
const resumeAudio = (): void => sound.resume();
window.addEventListener("pointerdown", resumeAudio, { once: true });
window.addEventListener("keydown", resumeAudio, { once: true });
hotDisposers.push(() => {
  window.removeEventListener("pointerdown", resumeAudio);
  window.removeEventListener("keydown", resumeAudio);
});
updateMuteButton();

// Start at the lobby.
lobby.show();
loop.start();

/** Expose the current session for debugging in the browser console. */
function exposeDebug(s: Session): void {
  Object.assign(window as unknown as Record<string, unknown>, {
    game: s.game,
    camera: s.camera,
    loop,
    selection: s.selection,
    placement: s.placement,
    getPlayer: () => getPlayerState(s.game.world, PLAYER_ID),
    spawn: (kind: "villager" | "spearman" | "archer", tx: number, ty: number, owner: number) =>
      spawnUnit(s.game.world, kind, tx, ty, owner),
    spawnBuilding: (kind: BuildingKind, owner: number, tx: number, ty: number) => {
      const e = spawnBuilding(s.game.world, kind, owner, tx, ty);
      const b = s.game.world.get(e, CBuilding);
      if (b !== undefined) s.game.setBuildingOccupancy(b, true);
      return e;
    },
  });
}

// On hot-reload, tear down the loop + listeners so we don't stack duplicates.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    loop.stop();
    input.dispose();
    window.removeEventListener("resize", syncViewport);
    for (const d of hotDisposers) d();
  });
}
