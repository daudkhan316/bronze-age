import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import {
  CCombat,
  CUnit,
  CTransform,
  CMovement,
  CGather,
  CBuild,
  UNIT_STATS,
  AGGRO_RANGE,
  INTERACT_RANGE,
} from "@/game/components";
import {
  entityPos,
  isAttackable,
  findNearestEnemy,
  computeDamage,
  applyDamage,
  rangeToTarget,
} from "@/game/combat";
import { spawnProjectile } from "@/game/spawn";
import { worldToTile } from "@/math/iso";
import type { GameMap } from "@/map/GameMap";
import type { Occupancy } from "@/map/Occupancy";
import { findPath } from "@/pathfinding/astar";

/**
 * Drives every unit's Combat component through the acquire → engage flow:
 *
 *   validate → (auto-)acquire → chase / attack → attack-move fallback
 *
 * Like the other sim systems, this one only sets *intent*: it seeds the
 * Movement component's path/goal toward whatever it wants to reach, and the
 * MovementSystem (which runs AFTER this one) does the actual walking and
 * consumes `mv.path`. Combat itself just resolves cooldowns, spawns projectiles
 * (ranged) or applies damage in place (melee), and decides what to walk toward.
 *
 * Determinism: every decision derives from live component state plus the fixed
 * `dt`; the query order is stable; no RNG. We mutate the live Combat / Movement
 * / Transform / Unit components in place. Damage never destroys an entity here —
 * `applyDamage` only drops hp, and a separate DeathSystem reaps 0-hp entities
 * after the tick — so nothing can perturb the query we're iterating.
 */
export class CombatSystem implements System {
  readonly name = "combat";

  constructor(
    private readonly map: GameMap,
    private readonly occ: Occupancy,
  ) {}

  update(world: World, dt: number): void {
    for (const [e, cb] of world.query(CCombat)) {
      const unit = world.get(e, CUnit);
      const tr = world.get(e, CTransform);
      const mv = world.get(e, CMovement);
      if (unit === undefined || tr === undefined || mv === undefined) continue;

      const owner = unit.owner;
      const def = UNIT_STATS[unit.kind];
      const ranged = def.range > 0;
      const hitRange = Math.max(1, def.range); // melee (range 0) still hits at 1.

      // Tick the attack cooldown down toward ready (clamped at 0).
      cb.cooldown = Math.max(0, cb.cooldown - dt);

      // 1) VALIDATE: drop a target that died or is no longer an enemy. A target
      //    that becomes invalid also clears the explicit-order flag.
      if (cb.target !== null && !isAttackable(world, cb.target, owner)) {
        cb.target = null;
        cb.ordered = false;
      }

      // 2) ACQUIRE: with no target, military units that aren't busy gathering or
      //    building (and any unit currently on attack-move) auto-pick the nearest
      //    enemy in aggro range. Villagers never auto-fight. Auto-acquired
      //    targets keep `ordered` as-is (false) so they stay droppable in step 3.
      if (cb.target === null) {
        const canAutoAcquire =
          cb.attackMove !== null ||
          (unit.kind !== "villager" &&
            !world.has(e, CGather) &&
            !world.has(e, CBuild));
        if (canAutoAcquire) {
          const hit = findNearestEnemy(world, owner, tr.x, tr.y, AGGRO_RANGE);
          if (hit !== null) cb.target = hit.entity;
        }
      }

      // 3) ENGAGE: chase a target until in range, then attack on cooldown.
      if (cb.target !== null) {
        const tpos = entityPos(world, cb.target);
        if (tpos === null) {
          // Target has no body (already gone) — clear and fall through to step 4.
          cb.target = null;
        } else {
          // Range to a building is measured to its nearest footprint tile (a
          // melee attacker can only stand outside the footprint).
          const cheb = rangeToTarget(world, tr.x, tr.y, cb.target);

          if (!cb.ordered && cheb > AGGRO_RANGE * 2) {
            // Auto-acquired target ran far away — give up rather than chase
            // forever. (Explicitly-ordered targets are chased without limit.)
            cb.target = null;
          } else if (cheb <= hitRange) {
            // IN RANGE: stop walking and attack when the cooldown is ready.
            mv.path.length = 0;
            mv.goal = null;
            if (cb.cooldown <= 0) {
              if (ranged) {
                // Fire a homing arrow; it resolves damage on impact.
                spawnProjectile(
                  world,
                  tr.x,
                  tr.y,
                  cb.target,
                  tpos.x,
                  tpos.y,
                  def.attack,
                  unit.kind,
                  owner,
                );
              } else {
                // Melee: apply damage immediately (DeathSystem reaps later).
                applyDamage(
                  world,
                  cb.target,
                  computeDamage(world, cb.target, def.attack, unit.kind, false),
                );
              }
              cb.cooldown = def.attackCooldown;
            }
          } else if (mv.path.length === 0) {
            // OUT OF RANGE: re-path toward the target, but only when we aren't
            // already walking — re-pathing every tick would thrash the route.
            // findPath retargets an unwalkable building tile to its nearest
            // standable approach; [] means unreachable, so we just stay put.
            const here = worldToTile(tr.x, tr.y);
            const targetTile = worldToTile(tpos.x, tpos.y);
            mv.path = findPath(this.map, here, targetTile, this.occ);
            const last = mv.path[mv.path.length - 1];
            mv.goal = last ?? null;
          }
          continue; // Handled a target this tick — skip the attack-move step.
        }
      }

      // 4) ATTACK-MOVE: no target. Advance toward the attack-move destination,
      //    auto-acquiring enemies met en route (handled by step 2 next ticks).
      if (cb.attackMove !== null) {
        const here = worldToTile(tr.x, tr.y);
        const dest = cb.attackMove;
        const arrived =
          Math.max(Math.abs(here.tx - dest.tx), Math.abs(here.ty - dest.ty)) <=
          INTERACT_RANGE;
        if (arrived) {
          cb.attackMove = null; // reached the destination — drop the order.
        } else if (mv.path.length === 0) {
          mv.path = findPath(this.map, here, dest, this.occ);
          if (mv.path.length === 0) {
            // Destination unreachable — give up rather than re-pathing every tick.
            cb.attackMove = null;
          } else {
            mv.goal = dest;
          }
        }
      }
      // Else fully idle: leave Movement / Gather / Build to their own systems.
    }
  }
}
