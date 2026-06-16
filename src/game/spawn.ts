import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import {
  CTransform,
  CMovement,
  CUnit,
  CResourceNode,
  CBuilding,
  CConstruction,
  CPlayer,
  CTrainQueue,
  UNIT_STATS,
  NODE_AMOUNT,
  BUILDING_DEFS,
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
  world.add(e, CUnit, { kind, owner, radius: stats.radius, hp: stats.hp, maxHp: stats.hp });
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

/**
 * Create a building with footprint origin at (tx, ty). Pass `foundation: true`
 * to place it under construction (a BuildSystem completes it as villagers
 * build); otherwise it spawns complete and functional.
 */
export function spawnBuilding(
  world: World,
  kind: BuildingKind,
  owner: number,
  tx: number,
  ty: number,
  opts?: { foundation?: boolean },
): Entity {
  const e = world.createEntity();
  const def = BUILDING_DEFS[kind];
  const { w, h } = def;
  // Transform = footprint centre in world space (for rendering).
  const centre = gridToWorld(tx + w / 2, ty + h / 2);
  world.add(e, CTransform, { x: centre.x, y: centre.y });

  const foundation = opts?.foundation === true && def.buildTicks > 0;
  world.add(e, CBuilding, {
    kind,
    owner,
    tx,
    ty,
    w,
    h,
    complete: !foundation,
    // A foundation starts with a sliver of HP that ramps to maxHp as it builds.
    hp: foundation ? Math.max(1, Math.round(def.maxHp * 0.05)) : def.maxHp,
    maxHp: def.maxHp,
  });
  if (foundation) {
    world.add(e, CConstruction, { progress: 0, required: def.buildTicks });
  }
  // Trainable buildings get a queue (only used once complete).
  if (def.trains !== null) world.add(e, CTrainQueue, { queued: 0, progress: 0 });
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
