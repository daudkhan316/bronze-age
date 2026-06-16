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
  CCombat,
  CProjectile,
  UNIT_STATS,
  NODE_AMOUNT,
  BUILDING_DEFS,
  PROJECTILE_SPEED,
  type UnitKind,
  type ResourceKind,
  type BuildingKind,
} from "@/game/components";
import type { StartResources, Difficulty } from "@/game/match";
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
  world.add(e, CCombat, { cooldown: 0, target: null, ordered: false, attackMove: null });
  return e;
}

/** Spawn an arrow projectile at (x, y) flying toward `target` (fallback gx,gy). */
export function spawnProjectile(
  world: World,
  x: number,
  y: number,
  target: Entity | null,
  gx: number,
  gy: number,
  attack: number,
  attackerKind: UnitKind,
  owner: number,
): Entity {
  const e = world.createEntity();
  world.add(e, CTransform, { x, y });
  world.add(e, CProjectile, {
    target,
    gx,
    gy,
    speed: PROJECTILE_SPEED,
    attack,
    attackerKind,
    owner,
  });
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

/** Create a player-economy entity with the given starting resources. */
export function spawnPlayer(
  world: World,
  id: number,
  start: StartResources,
  opts?: { isAI?: boolean; difficulty?: Difficulty | null },
): Entity {
  const e = world.createEntity();
  world.add(e, CPlayer, {
    id,
    food: start.food,
    wood: start.wood,
    gold: start.gold,
    stone: start.stone,
    popUsed: 0,
    popCap: 0,
    isAI: opts?.isAI ?? false,
    difficulty: opts?.difficulty ?? null,
    defeated: false,
  });
  return e;
}
