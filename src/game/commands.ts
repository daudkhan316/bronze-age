/**
 * Per-tick command buffer (Phase 5).
 *
 * Every gameplay intent — from the human's input handlers AND from the AI brain
 * — is expressed as a plain, JSON-safe `Command` and pushed into a shared
 * `CommandBuffer`. `Game.fixedUpdate` drains the buffer at the START of each
 * tick and applies each command via `executeCommand`, so EVERY simulation write
 * lands on the deterministic tick (not in a render-rate input handler). This is
 * the foundation that makes the sim replay-/AI-safe.
 *
 * `executeCommand` is the single authoritative place that mutates units/
 * buildings for an order: it re-validates ownership, liveness, affordability and
 * placement at execution time (state may have changed in the ~1 tick since the
 * command was queued), so a stale command simply no-ops instead of corrupting
 * state. The view layer only builds command objects; it never touches the world.
 */

import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import type { GameMap } from "@/map/GameMap";
import type { Occupancy } from "@/map/Occupancy";
import {
  CTransform,
  CMovement,
  CUnit,
  CGather,
  CBuild,
  CCombat,
  CBuilding,
  CResourceNode,
  CTrainQueue,
  BUILDING_DEFS,
  UNIT_STATS,
  RESOURCE_KINDS,
  type BuildingKind,
  type UnitKind,
  type ResourceKind,
  type PlayerState,
} from "@/game/components";
import { getPlayerState } from "@/game/economy";
import { spawnBuilding } from "@/game/spawn";
import { worldToTile } from "@/math/iso";
import type { GridPoint } from "@/math/iso";
import { findPath, canStand } from "@/pathfinding/astar";
import { TERRAIN } from "@/map/Terrain";

/**
 * A single ordered intent. `owner` scopes the command to that player's units so
 * one player can never command another's (defensive against bad input/AI). All
 * entity references are plain ids; the executor re-checks they still exist.
 */
export type Command =
  | { type: "move"; owner: number; units: number[]; tx: number; ty: number }
  | { type: "attackMove"; owner: number; units: number[]; tx: number; ty: number }
  | { type: "attack"; owner: number; units: number[]; target: number }
  | { type: "gather"; owner: number; units: number[]; node: number }
  | { type: "build"; owner: number; kind: BuildingKind; tx: number; ty: number; builders: number[] }
  | { type: "assignBuild"; owner: number; villagers: number[]; target: number }
  | { type: "train"; owner: number; building: number; unit: UnitKind }
  | { type: "stop"; owner: number; units: number[] };

/** FIFO buffer of pending commands, drained once per tick. */
export class CommandBuffer {
  private queue: Command[] = [];

  enqueue(cmd: Command): void {
    this.queue.push(cmd);
  }

  /** Return and clear all queued commands (called at the start of a tick). */
  drain(): Command[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** Deep copy for the save snapshot (commands hold arrays, so clone them). */
  serialize(): Command[] {
    return structuredClone(this.queue);
  }

  /** Replace the queue from a restored snapshot. */
  restore(cmds: Command[]): void {
    this.queue = structuredClone(cmds);
  }
}

// --- shared helpers --------------------------------------------------------

/** The Unit of `e` if it is alive and owned by `owner`, else undefined. */
function ownedUnit(world: World, e: Entity, owner: number): { kind: UnitKind } | undefined {
  if (!world.isAlive(e)) return undefined;
  const u = world.get(e, CUnit);
  return u !== undefined && u.owner === owner ? u : undefined;
}

/** Halt a unit's walk (clears path/goal and the stuck counter). */
function stopMovement(mv: { path: GridPoint[]; goal: GridPoint | null; stuck: number }): void {
  mv.path = [];
  mv.goal = null;
  mv.stuck = 0;
}

/** Drop a unit's gather/build economy tasks. */
function dropEconomyTasks(world: World, e: Entity): void {
  if (world.has(e, CGather)) world.remove(e, CGather);
  if (world.has(e, CBuild)) world.remove(e, CBuild);
}

/** Clear a unit's combat order (target + attack-move). */
function clearCombat(world: World, e: Entity): void {
  const cb = world.get(e, CCombat);
  if (cb !== undefined) {
    cb.target = null;
    cb.ordered = false;
    cb.attackMove = null;
  }
}

/** True if `ps` can pay `cost`. */
function canAfford(ps: PlayerState, cost: Partial<Record<ResourceKind, number>>): boolean {
  for (const k of RESOURCE_KINDS) {
    if ((cost[k] ?? 0) > ps[k]) return false;
  }
  return true;
}

/** Deduct `cost` from `ps` (assumes affordability already checked). */
function payCost(ps: PlayerState, cost: Partial<Record<ResourceKind, number>>): void {
  for (const k of RESOURCE_KINDS) ps[k] -= cost[k] ?? 0;
}

/** Total units queued across all of a player's training buildings. */
function queuedForPlayer(world: World, owner: number): number {
  let total = 0;
  for (const [e, b] of world.query(CBuilding)) {
    if (b.owner !== owner) continue;
    const tq = world.get(e, CTrainQueue);
    if (tq !== undefined) total += tq.queued;
  }
  return total;
}

/**
 * Up to `count` distinct standable tiles spiralling out from `center`, so a
 * group order spreads instead of every unit contending for one tile. Mirrors the
 * old `collectDestinations` in main.ts (now sim-side).
 */
function spreadDestinations(
  map: GameMap,
  occ: Occupancy,
  center: GridPoint,
  count: number,
): GridPoint[] {
  const out: GridPoint[] = [];
  for (let r = 0; r <= 24 && out.length < count; r++) {
    for (let dy = -r; dy <= r && out.length < count; dy++) {
      for (let dx = -r; dx <= r && out.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = center.tx + dx;
        const ty = center.ty + dy;
        if (canStand(map, tx, ty, occ)) out.push({ tx, ty });
      }
    }
  }
  return out;
}

/**
 * Whether a `kind` footprint at (tx,ty) is a legal build spot: every tile
 * in-bounds, on buildable terrain, unoccupied, and clear of resource nodes.
 * Mirrors PlacementController.evaluate's terrain/occupancy rule (the view) so the
 * authoritative check here can't diverge from the ghost the player saw.
 */
export function footprintPlaceable(
  world: World,
  map: GameMap,
  occ: Occupancy,
  kind: BuildingKind,
  tx: number,
  ty: number,
): boolean {
  const def = BUILDING_DEFS[kind];
  for (let y = ty; y < ty + def.h; y++) {
    for (let x = tx; x < tx + def.w; x++) {
      if (!map.inBounds(x, y)) return false;
      const terrain = map.get(x, y);
      if (terrain === undefined || !TERRAIN[terrain].buildable) return false;
      if (occ.isBlocked(x, y)) return false;
      // A resource node sitting on the tile blocks construction.
      for (const [, n] of world.query(CResourceNode)) {
        if (n.tx === x && n.ty === y && n.amount > 0) return false;
      }
    }
  }
  return true;
}

// --- the executor ----------------------------------------------------------

/** Apply one command to the world. Silently no-ops on stale/invalid input. */
export function executeCommand(
  world: World,
  map: GameMap,
  occ: Occupancy,
  cmd: Command,
): void {
  switch (cmd.type) {
    case "move": {
      const units = cmd.units.filter((e) => ownedUnit(world, e, cmd.owner) !== undefined);
      const dests = spreadDestinations(map, occ, { tx: cmd.tx, ty: cmd.ty }, units.length);
      for (let i = 0; i < units.length; i++) {
        const e = units[i];
        if (e === undefined) continue;
        const tr = world.get(e, CTransform);
        const mv = world.get(e, CMovement);
        if (tr === undefined || mv === undefined) continue;
        dropEconomyTasks(world, e);
        clearCombat(world, e);
        const dest = dests[i] ?? { tx: cmd.tx, ty: cmd.ty };
        const path = findPath(map, worldToTile(tr.x, tr.y), dest, occ);
        mv.path = path;
        mv.goal = path.length > 0 ? (path[path.length - 1] ?? null) : null;
        mv.stuck = 0;
      }
      return;
    }

    case "attackMove": {
      const goal: GridPoint = { tx: cmd.tx, ty: cmd.ty };
      for (const e of cmd.units) {
        if (ownedUnit(world, e, cmd.owner) === undefined) continue;
        const mv = world.get(e, CMovement);
        const cb = world.get(e, CCombat);
        if (mv === undefined || cb === undefined) continue;
        dropEconomyTasks(world, e);
        stopMovement(mv);
        cb.target = null;
        cb.ordered = false;
        cb.attackMove = { tx: goal.tx, ty: goal.ty };
      }
      return;
    }

    case "attack": {
      if (!world.isAlive(cmd.target)) return;
      for (const e of cmd.units) {
        if (ownedUnit(world, e, cmd.owner) === undefined) continue;
        const mv = world.get(e, CMovement);
        const cb = world.get(e, CCombat);
        if (mv === undefined || cb === undefined) continue;
        dropEconomyTasks(world, e);
        stopMovement(mv);
        cb.target = cmd.target;
        cb.ordered = true;
        cb.attackMove = null;
      }
      return;
    }

    case "gather": {
      const node = world.get(cmd.node, CResourceNode);
      if (node === undefined || node.amount <= 0) return;
      const kind = node.kind;
      for (const e of cmd.units) {
        const u = ownedUnit(world, e, cmd.owner);
        if (u === undefined || u.kind !== "villager") continue;
        const mv = world.get(e, CMovement);
        if (mv === undefined) continue;
        stopMovement(mv);
        if (world.has(e, CBuild)) world.remove(e, CBuild);
        clearCombat(world, e);
        const existing = world.get(e, CGather);
        if (existing !== undefined) {
          existing.node = cmd.node;
          existing.resourceKind = kind;
          existing.carrying = 0;
          existing.state = "toNode";
        } else {
          world.add(e, CGather, { node: cmd.node, resourceKind: kind, carrying: 0, state: "toNode" });
        }
      }
      return;
    }

    case "build": {
      const ps = getPlayerState(world, cmd.owner);
      if (ps === undefined) return;
      const def = BUILDING_DEFS[cmd.kind];
      if (!footprintPlaceable(world, map, occ, cmd.kind, cmd.tx, cmd.ty)) return;
      if (!canAfford(ps, def.cost)) return;
      payCost(ps, def.cost);
      const be = spawnBuilding(world, cmd.kind, cmd.owner, cmd.tx, cmd.ty, { foundation: true });
      const b = world.get(be, CBuilding);
      if (b !== undefined) occ.setRect(b.tx, b.ty, b.w, b.h, true);
      // Optionally send villagers to construct it immediately (AI convenience;
      // the human places first, then assigns via a right-click → assignBuild).
      for (const e of cmd.builders) {
        const u = ownedUnit(world, e, cmd.owner);
        if (u === undefined || u.kind !== "villager") continue;
        const mv = world.get(e, CMovement);
        if (mv === undefined) continue;
        stopMovement(mv);
        if (world.has(e, CGather)) world.remove(e, CGather);
        clearCombat(world, e);
        const existing = world.get(e, CBuild);
        if (existing !== undefined) {
          existing.target = be;
          existing.state = "toSite";
        } else {
          world.add(e, CBuild, { target: be, state: "toSite" });
        }
      }
      return;
    }

    case "assignBuild": {
      const target = world.get(cmd.target, CBuilding);
      if (target === undefined || target.owner !== cmd.owner || target.complete) return;
      for (const e of cmd.villagers) {
        const u = ownedUnit(world, e, cmd.owner);
        if (u === undefined || u.kind !== "villager") continue;
        const mv = world.get(e, CMovement);
        if (mv === undefined) continue;
        stopMovement(mv);
        if (world.has(e, CGather)) world.remove(e, CGather);
        clearCombat(world, e);
        const existing = world.get(e, CBuild);
        if (existing !== undefined) {
          existing.target = cmd.target;
          existing.state = "toSite";
        } else {
          world.add(e, CBuild, { target: cmd.target, state: "toSite" });
        }
      }
      return;
    }

    case "train": {
      const b = world.get(cmd.building, CBuilding);
      if (b === undefined || b.owner !== cmd.owner || !b.complete) return;
      const trains = BUILDING_DEFS[b.kind].trains;
      if (trains === null || trains !== cmd.unit) return;
      const tq = world.get(cmd.building, CTrainQueue);
      const ps = getPlayerState(world, cmd.owner);
      if (tq === undefined || ps === undefined) return;
      const cost = UNIT_STATS[trains].cost;
      // Pop is gated on used + already-queued so we never pre-pay over the cap.
      if (!canAfford(ps, cost)) return;
      if (ps.popUsed + queuedForPlayer(world, cmd.owner) >= ps.popCap) return;
      payCost(ps, cost);
      tq.queued += 1;
      return;
    }

    case "stop": {
      for (const e of cmd.units) {
        if (ownedUnit(world, e, cmd.owner) === undefined) continue;
        const mv = world.get(e, CMovement);
        if (mv !== undefined) stopMovement(mv);
        dropEconomyTasks(world, e);
        clearCombat(world, e);
      }
      return;
    }
  }
}
