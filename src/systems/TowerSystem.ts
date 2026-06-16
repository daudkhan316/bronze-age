import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import { CTower, CBuilding, CTransform, BUILDING_DEFS } from "@/game/components";
import { findNearestEnemy } from "@/game/combat";
import { spawnProjectile } from "@/game/spawn";
import { towerAttack } from "@/game/tech";

/**
 * Buildings that fight (Phase 6): a complete Watch Tower auto-fires an arrow at
 * the nearest enemy within its range on a cooldown — the building-attacker
 * analogue of CombatSystem. Runs right after CombatSystem so its projectiles fly
 * the same tick (ProjectileSystem runs later). Deterministic: cooldown counts
 * down by the fixed `dt`, target is the nearest enemy (stable tie-break in
 * findNearestEnemy), no RNG.
 *
 * The tower shoots as an `archer` projectile (it fires arrows), so the effective
 * tower attack picks up ranged-attack research (Fletching) and the arrow resolves
 * against the defender's pierce-armor at impact.
 */
export class TowerSystem implements System {
  readonly name = "tower";

  update(world: World, dt: number): void {
    for (const [e, t] of world.query(CTower)) {
      const b = world.get(e, CBuilding);
      const tr = world.get(e, CTransform);
      if (b === undefined || tr === undefined || !b.complete) continue;

      t.cooldown = Math.max(0, t.cooldown - dt);
      if (t.cooldown > 0) continue;

      const def = BUILDING_DEFS[b.kind];
      const range = def.range ?? 0;
      if (range <= 0) continue;

      const hit = findNearestEnemy(world, b.owner, tr.x, tr.y, range);
      if (hit === null) continue;

      // Fires as a "tower" projectile: ranged (pierce-armor) resolution but no
      // unit counter-bonus (it's a building, not an archer).
      spawnProjectile(world, tr.x, tr.y, hit.entity, hit.x, hit.y, towerAttack(world, b.owner), "tower", b.owner);
      t.cooldown = def.attackCooldown ?? 2;
    }
  }
}
