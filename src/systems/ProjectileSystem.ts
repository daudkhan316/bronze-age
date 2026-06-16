import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import { CProjectile, CTransform, PROJECTILE_HIT_DIST } from "@/game/components";
import { applyDamage, computeDamage, entityPos, isAttackable } from "@/game/combat";

/**
 * Advances in-flight projectiles toward their aim point and resolves impacts.
 *
 * Each tick every projectile homes on its target's *live* position so a moving
 * unit can't outrun an arrow, but a target that died or became invalid
 * mid-flight is dropped: the arrow instead flies to the snapshot point
 * (gx, gy) captured at fire time and fizzles on arrival (no damage). This keeps
 * the sim deterministic — only fixed-tick `dt`, no clocks or RNG — and avoids
 * arrows curving onto whatever happens to occupy the target slot next.
 *
 * Iteration safety: `World.query` walks the component store (a Map) filtered by
 * the living set, so destroying the *current* projectile entity mid-loop only
 * deletes the key we're already past visiting — never disturbing later keys.
 */
export class ProjectileSystem implements System {
  readonly name = "projectile";

  update(world: World, dt: number): void {
    for (const [e, p] of world.query(CProjectile)) {
      const tr = world.get(e, CTransform);
      if (tr === undefined) {
        // A projectile with no body can't fly; reap it.
        world.destroyEntity(e);
        continue;
      }

      // Aim at the target's current position while it's still a valid enemy;
      // otherwise fall back to the snapshot impact point and fizzle there.
      let aimX = p.gx;
      let aimY = p.gy;
      let targetable = p.target !== null && isAttackable(world, p.target, p.owner);
      if (targetable && p.target !== null) {
        const tpos = entityPos(world, p.target);
        if (tpos !== null) {
          aimX = tpos.x;
          aimY = tpos.y;
        } else {
          // Attackable but bodyless (shouldn't happen): treat as fizzle.
          targetable = false;
        }
      }

      const step = p.speed * dt;
      const dx = aimX - tr.x;
      const dy = aimY - tr.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= step || dist <= PROJECTILE_HIT_DIST) {
        // Impact: only deal damage if the target is (still) a valid enemy.
        if (targetable && p.target !== null && isAttackable(world, p.target, p.owner)) {
          const dmg = computeDamage(world, p.target, p.attack, p.attackerKind, true);
          applyDamage(world, p.target, dmg);
        }
        world.destroyEntity(e);
        continue;
      }

      // Still in flight: advance along the unit direction (dist > 0 here).
      tr.x += (dx / dist) * step;
      tr.y += (dy / dist) * step;
    }
  }
}
