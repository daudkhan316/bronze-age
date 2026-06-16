import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import {
  CPlayer,
  CBuilding,
  CResourceNode,
  CTransform,
  CMatch,
  BUILDING_DEFS,
} from "@/game/components";
import type { PlayerState, MatchState, Building, ResourceNode, ResourceKind } from "@/game/components";
import { worldToTile } from "@/math/iso";
import type { GridPoint } from "@/math/iso";
import type { GameMap } from "@/map/GameMap";
import { canStand } from "@/pathfinding/grid";
import type { BlockedQuery } from "@/pathfinding/grid";

/** The player-economy entity for `owner`, or undefined. */
export function getPlayerState(world: World, owner: number): PlayerState | undefined {
  for (const [, ps] of world.query(CPlayer)) {
    if (ps.id === owner) return ps;
  }
  return undefined;
}

/** The singleton match-state, or undefined before one is created. */
export function getMatchState(world: World): MatchState | undefined {
  for (const [, m] of world.query(CMatch)) return m;
  return undefined;
}

/**
 * Nearest standable tile on the ring immediately surrounding a building's
 * footprint — every such tile is exactly INTERACT_RANGE (1) from the box, so a
 * unit sent here is provably "adjacent". Returns null only when the whole ring
 * is blocked (the building is genuinely unreachable). Use this rather than
 * standableTileNear(centre), which can return a far tile when the adjacent ring
 * is blocked and make a builder/gatherer give up on a reachable target.
 */
export function approachTileForBuilding(
  map: GameMap,
  occ: BlockedQuery,
  b: Building,
): GridPoint | null {
  const x0 = b.tx - 1;
  const x1 = b.tx + b.w;
  const y0 = b.ty - 1;
  const y1 = b.ty + b.h;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue; // perimeter only
      if (canStand(map, x, y, occ)) return { tx: x, ty: y };
    }
  }
  return null;
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

/**
 * Nearest COMPLETE building owned by `owner` that accepts `kind` as a drop-off
 * (Town Center accepts all; Lumber/Mining Camps and Mill accept their kinds),
 * to world point (x, y). Returns null if there's nowhere to deposit.
 */
export function findNearestDropoff(
  world: World,
  owner: number,
  kind: ResourceKind,
  x: number,
  y: number,
): BuildingHit | null {
  let best: BuildingHit | null = null;
  let bestD = Infinity;
  for (const [e, b] of world.query(CBuilding)) {
    if (b.owner !== owner || !b.complete) continue;
    if (!BUILDING_DEFS[b.kind].accepts.includes(kind)) continue;
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
