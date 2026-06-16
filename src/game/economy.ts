import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import {
  CPlayer,
  CBuilding,
  CResourceNode,
  CTransform,
} from "@/game/components";
import type { PlayerState, Building, ResourceNode, ResourceKind } from "@/game/components";
import { worldToTile } from "@/math/iso";

/** The player-economy entity for `owner`, or undefined. */
export function getPlayerState(world: World, owner: number): PlayerState | undefined {
  for (const [, ps] of world.query(CPlayer)) {
    if (ps.id === owner) return ps;
  }
  return undefined;
}

/** Chebyshev (king-move) distance in tiles from a tile to a building's footprint box. */
export function tileRangeToBuilding(tx: number, ty: number, b: Building): number {
  const dx = Math.max(b.tx - tx, 0, tx - (b.tx + b.w - 1));
  const dy = Math.max(b.ty - ty, 0, ty - (b.ty + b.h - 1));
  return Math.max(dx, dy);
}

export interface BuildingHit {
  entity: Entity;
  building: Building;
}

/** Nearest Town Center owned by `owner` to world point (x, y), or null. */
export function findNearestDropoff(
  world: World,
  owner: number,
  x: number,
  y: number,
): BuildingHit | null {
  let best: BuildingHit | null = null;
  let bestD = Infinity;
  for (const [e, b] of world.query(CBuilding)) {
    if (b.owner !== owner || b.kind !== "town_center") continue;
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;
    const d = (tr.x - x) * (tr.x - x) + (tr.y - y) * (tr.y - y);
    if (d < bestD) {
      bestD = d;
      best = { entity: e, building: b };
    }
  }
  return best;
}

export interface NodeHit {
  entity: Entity;
  node: ResourceNode;
}

/** Resource node sitting exactly on tile (tx, ty), or null. */
export function resourceNodeAtTile(world: World, tx: number, ty: number): NodeHit | null {
  for (const [e, n] of world.query(CResourceNode)) {
    if (n.tx === tx && n.ty === ty && n.amount > 0) return { entity: e, node: n };
  }
  return null;
}

/**
 * Nearest non-empty resource node of `kind` to world point (x, y) within
 * `maxTiles` (Chebyshev), or null. Used to re-task a gatherer when its node
 * runs dry.
 */
export function findNearestNodeOfKind(
  world: World,
  kind: ResourceKind,
  x: number,
  y: number,
  maxTiles: number,
): NodeHit | null {
  const from = worldToTile(x, y);
  let best: NodeHit | null = null;
  let bestD = Infinity;
  for (const [e, n] of world.query(CResourceNode)) {
    if (n.kind !== kind || n.amount <= 0) continue;
    const cheb = Math.max(Math.abs(n.tx - from.tx), Math.abs(n.ty - from.ty));
    if (cheb > maxTiles) continue;
    if (cheb < bestD) {
      bestD = cheb;
      best = { entity: e, node: n };
    }
  }
  return best;
}
