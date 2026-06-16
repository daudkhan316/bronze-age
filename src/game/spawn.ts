import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import { CTransform, CMovement, CUnit, UNIT_STATS, type UnitKind } from "@/game/components";
import { tileCenterWorld } from "@/math/iso";

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
