import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import {
  CTransform,
  CMovement,
  CUnit,
  CResourceNode,
  CBuilding,
  CPlayer,
  CTrainQueue,
  UNIT_STATS,
  NODE_AMOUNT,
  BUILDING_SIZE,
  type UnitKind,
  type ResourceKind,
  type BuildingKind,
} from "@/game/components";
import { tileCenterWorld, gridToWorld } from "@/math/iso";

/**
 * Create a unit on tile (tx, ty) for `owner`, positioned at the tile centre in
 * world space and idle (no path). Returns the new entity id.
 */
export function spawnUnit(
  world: World,
  kind: UnitKind,
  tx: number,
  ty: number,
  owner: number,
): Entity {
  const e = world.createEntity();
  const centre = tileCenterWorld(tx, ty);
  const stats = UNIT_STATS[kind];
  world.add(e, CTransform, { x: centre.x, y: centre.y });
  world.add(e, CUnit, { kind, owner, radius: stats.radius });
  world.add(e, CMovement, { speed: stats.speed, path: [], goal: null, stuck: 0 });
  return e;
}

/** Create a resource node (tree, bush, mine) on tile (tx, ty). */
export function spawnResourceNode(
  world: World,
  kind: ResourceKind,
  tx: number,
  ty: number,
): Entity {
  const e = world.createEntity();
  const centre = tileCenterWorld(tx, ty);
  world.add(e, CTransform, { x: centre.x, y: centre.y });
  world.add(e, CResourceNode, { kind, amount: NODE_AMOUNT[kind], tx, ty });
  return e;
}

/** Create a building with its footprint origin at tile (tx, ty). */
export function spawnBuilding(
  world: World,
  kind: BuildingKind,
  owner: number,
  tx: number,
  ty: number,
): Entity {
  const e = world.createEntity();
  const { w, h } = BUILDING_SIZE[kind];
  // Transform = footprint centre in world space (for rendering).
  const centre = gridToWorld(tx + w / 2, ty + h / 2);
  world.add(e, CTransform, { x: centre.x, y: centre.y });
  world.add(e, CBuilding, { kind, owner, tx, ty, w, h });
  // Town Centers can train villagers.
  if (kind === "town_center") world.add(e, CTrainQueue, { queued: 0, progress: 0 });
  return e;
}

/** Create a player-economy entity with starting resources. */
export function spawnPlayer(world: World, id: number): Entity {
  const e = world.createEntity();
  world.add(e, CPlayer, {
    id,
    food: 200,
    wood: 200,
    gold: 100,
    stone: 100,
    popUsed: 0,
    popCap: 0,
  });
  return e;
}
