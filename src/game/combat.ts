import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import {
  CUnit,
  CBuilding,
  CTransform,
  DAMAGE_BONUS,
  type AttackerKind,
} from "@/game/components";
import { effectiveArmor } from "@/game/tech";
import type { Occupancy } from "@/map/Occupancy";
import { worldToTile } from "@/math/iso";

/** A candidate attack target with its world position and kind. */
export interface TargetHit {
  entity: Entity;
  x: number;
  y: number;
  kind: "unit" | "building";
}

/** Chebyshev tile distance between two world points (the metric ranges use). */
export function tileCheb(ax: number, ay: number, bx: number, by: number): number {
  const a = worldToTile(ax, ay);
  const b = worldToTile(bx, by);
  return Math.max(Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty));
}

/** World position of an entity (its Transform), or null. */
export function entityPos(world: World, e: Entity): { x: number; y: number } | null {
  const tr = world.get(e, CTransform);
  return tr === undefined ? null : { x: tr.x, y: tr.y };
}

/**
 * Attack-range distance (Chebyshev tiles) from world point (x, y) to a target.
 * For a BUILDING this measures to the nearest footprint tile, not the centre —
 * a melee attacker stands outside a multi-tile footprint, so centre-distance
 * would never reach hit range and the unit would orbit forever. For a unit it's
 * just the tile distance.
 */
export function rangeToTarget(world: World, x: number, y: number, target: Entity): number {
  const here = worldToTile(x, y);
  const b = world.get(target, CBuilding);
  if (b !== undefined) {
    const dx = Math.max(b.tx - here.tx, 0, here.tx - (b.tx + b.w - 1));
    const dy = Math.max(b.ty - here.ty, 0, here.ty - (b.ty + b.h - 1));
    return Math.max(dx, dy);
  }
  const tr = world.get(target, CTransform);
  if (tr === undefined) return Infinity;
  return tileCheb(x, y, tr.x, tr.y);
}

/** Is `e` a living, attackable enemy of `owner` (an enemy unit or building)? */
export function isAttackable(world: World, e: Entity, owner: number): boolean {
  if (!world.isAlive(e)) return false;
  const u = world.get(e, CUnit);
  if (u !== undefined) return u.owner !== owner;
  const b = world.get(e, CBuilding);
  if (b !== undefined) return b.owner !== owner;
  return false;
}

/**
 * Nearest enemy of `owner` within `maxTiles` (Chebyshev) of world point (x, y).
 * Units are preferred over buildings at equal range (so troops fight troops
 * before sieging). Returns null if nothing in range.
 */
export function findNearestEnemy(
  world: World,
  owner: number,
  x: number,
  y: number,
  maxTiles: number,
): TargetHit | null {
  let best: TargetHit | null = null;
  let bestD = Infinity;

  for (const [e, u] of world.query(CUnit)) {
    if (u.owner === owner) continue;
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;
    const d = tileCheb(x, y, tr.x, tr.y);
    if (d <= maxTiles && d < bestD) {
      bestD = d;
      best = { entity: e, x: tr.x, y: tr.y, kind: "unit" };
    }
  }
  if (best !== null) return best; // prefer a unit target

  for (const [e, b] of world.query(CBuilding)) {
    if (b.owner === owner) continue;
    const tr = world.get(e, CTransform);
    if (tr === undefined) continue;
    const d = tileCheb(x, y, tr.x, tr.y);
    if (d <= maxTiles && d < bestD) {
      bestD = d;
      best = { entity: e, x: tr.x, y: tr.y, kind: "building" };
    }
  }
  return best;
}

/**
 * Final damage from an attacker's stats against a defender: base attack minus
 * the relevant armor (pierce-armor for ranged), floored at 1, plus any
 * counter-bonus. Buildings have no armor and take no counter bonus.
 */
export function computeDamage(
  world: World,
  target: Entity,
  attack: number,
  attackerKind: AttackerKind,
  ranged: boolean,
): number {
  const u = world.get(target, CUnit);
  let mitigation = 0;
  let bonus = 0;
  if (u !== undefined) {
    // Effective armor includes the defender's researched armor upgrades (Phase 6).
    mitigation = effectiveArmor(world, u.owner, u.kind, ranged);
    bonus = DAMAGE_BONUS[attackerKind]?.[u.kind] ?? 0;
  }
  return Math.max(1, attack - mitigation) + bonus;
}

/**
 * Subtract `dmg` from a target's hit points. Does NOT destroy the entity — a
 * DeathSystem reaps hp<=0 entities after all damage for the tick is applied, so
 * mid-iteration destruction can't disrupt the systems doing the damage. Returns
 * true if this hit dropped it to 0 (purely informational).
 */
export function applyDamage(world: World, target: Entity, dmg: number): boolean {
  const u = world.get(target, CUnit);
  if (u !== undefined) {
    u.hp -= dmg;
    return u.hp <= 0;
  }
  const b = world.get(target, CBuilding);
  if (b !== undefined) {
    b.hp -= dmg;
    return b.hp <= 0;
  }
  return false;
}

/**
 * Reap entities at or below 0 hp: free any building footprint in `occ`, then
 * destroy. Collects first, then destroys, so it's safe regardless of iteration.
 */
export function reapDead(world: World, occ: Occupancy): void {
  const dead: Entity[] = [];
  for (const [e, u] of world.query(CUnit)) {
    if (u.hp <= 0) dead.push(e);
  }
  for (const [e, b] of world.query(CBuilding)) {
    if (b.hp <= 0) {
      occ.setRect(b.tx, b.ty, b.w, b.h, false);
      dead.push(e);
    }
  }
  for (const e of dead) world.destroyEntity(e);
}
