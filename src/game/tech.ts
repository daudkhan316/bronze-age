/**
 * Tech / age helpers (Phase 6). One place to ask "what does this player's
 * researched tech actually change?" so the combat, gather, tower and UI code can
 * read EFFECTIVE stats without each re-deriving the upgrade math.
 *
 * Per-player tech lives on the `Player` component (`age` + `techs: string[]`);
 * everything here is a pure read over that plus the `UPGRADE_DEFS` table, so it's
 * deterministic and JSON-safe (no state of its own).
 */

import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import {
  CBuilding,
  CResearch,
  UNIT_STATS,
  BUILDING_DEFS,
  UPGRADE_DEFS,
  type UnitKind,
  type UpgradeId,
  type UpgradeStat,
  type UpgradeScope,
} from "@/game/components";
import { getPlayerState } from "@/game/economy";

/** Combat categories an upgrade scope can target. */
type Category = "melee" | "ranged" | "villager" | "tower";

/** Which combat category a unit kind falls into. */
function unitCategory(kind: UnitKind): Category {
  if (kind === "spearman") return "melee";
  if (kind === "archer") return "ranged";
  return "villager";
}

/** Does an upgrade `scope` apply to a given combat `category`? */
function appliesTo(scope: UpgradeScope, category: Category): boolean {
  if (scope === "all") return true;
  switch (category) {
    case "melee":
      return scope === "melee" || scope === "military";
    case "ranged":
      return scope === "ranged" || scope === "military";
    // The tower shoots arrows, so ranged-attack research (fletching) lifts it too.
    case "tower":
      return scope === "ranged" || scope === "tower";
    case "villager":
      return scope === "villager";
  }
}

/** Sum the `stat` addends from this player's researched techs whose scope passes `accept`. */
function sumEffects(
  world: World,
  owner: number,
  stat: UpgradeStat,
  accept: (scope: UpgradeScope) => boolean,
): number {
  const ps = getPlayerState(world, owner);
  if (ps === undefined) return 0;
  let total = 0;
  for (const id of ps.techs) {
    const def = UPGRADE_DEFS[id as UpgradeId];
    if (def === undefined) continue;
    for (const eff of def.effects) {
      if (eff.stat === stat && accept(eff.scope)) total += eff.add;
    }
  }
  return total;
}

/** A unit's effective attack = base + researched attack upgrades for its category. */
export function effectiveAttack(world: World, owner: number, kind: UnitKind): number {
  const cat = unitCategory(kind);
  return UNIT_STATS[kind].attack + sumEffects(world, owner, "attack", (s) => appliesTo(s, cat));
}

/** A unit's effective armor (or pierce-armor, when `ranged`) = base + researched bonus. */
export function effectiveArmor(world: World, owner: number, kind: UnitKind, ranged: boolean): number {
  const cat = unitCategory(kind);
  const def = UNIT_STATS[kind];
  const base = ranged ? def.pierceArmor : def.armor;
  const stat: UpgradeStat = ranged ? "pierceArmor" : "armor";
  return base + sumEffects(world, owner, stat, (s) => appliesTo(s, cat));
}

/** The watch tower's effective attack for `owner` (base + ranged-attack research). */
export function towerAttack(world: World, owner: number): number {
  const base = BUILDING_DEFS.watch_tower.attack ?? 0;
  return base + sumEffects(world, owner, "attack", (s) => appliesTo(s, "tower"));
}

/** Gather-rate multiplier (1.0 = base) from researched economy upgrades. */
export function gatherMultiplier(world: World, owner: number): number {
  return 1 + sumEffects(world, owner, "gatherRate", (s) => s === "gather" || s === "all");
}

/** A player's current age (1 if no player). */
export function playerAge(world: World, owner: number): number {
  return getPlayerState(world, owner)?.age ?? 1;
}

/** Has `owner` researched `id`? */
export function hasTech(world: World, owner: number, id: UpgradeId): boolean {
  return getPlayerState(world, owner)?.techs.includes(id) ?? false;
}

/** Is `owner` already researching `id` at any of their buildings? */
function isResearching(world: World, owner: number, id: UpgradeId): boolean {
  for (const [e, r] of world.query(CResearch)) {
    if (r.id !== id) continue;
    if (world.get(e, CBuilding)?.owner === owner) return true;
  }
  return false;
}

/**
 * Can `owner` start researching `id` at `buildingEntity` right now? Checks the
 * building kind/ownership/completion, the age requirement, the prerequisite tech,
 * that it isn't already done or in progress (here or elsewhere for this owner).
 * Affordability is the executor's job (re-checked at apply time).
 */
export function canResearch(
  world: World,
  owner: number,
  buildingEntity: Entity,
  id: UpgradeId,
): boolean {
  const def = UPGRADE_DEFS[id];
  const b = world.get(buildingEntity, CBuilding);
  const ps = getPlayerState(world, owner);
  if (def === undefined || b === undefined || ps === undefined) return false;
  if (b.owner !== owner || !b.complete || b.kind !== def.building) return false;
  if (ps.age < def.ageRequired) return false;
  if (def.requires !== null && !ps.techs.includes(def.requires)) return false;
  if (ps.techs.includes(id)) return false; // already researched
  if (def.setsAge !== undefined && ps.age >= def.setsAge) return false; // already that age
  if (world.has(buildingEntity, CResearch)) return false; // this building is busy
  if (isResearching(world, owner, id)) return false; // already in progress elsewhere
  return true;
}

/** The upgrades `owner` can research at `buildingEntity` right now (eligibility only). */
export function availableResearch(world: World, owner: number, buildingEntity: Entity): UpgradeId[] {
  const out: UpgradeId[] = [];
  for (const id of Object.keys(UPGRADE_DEFS) as UpgradeId[]) {
    if (canResearch(world, owner, buildingEntity, id)) out.push(id);
  }
  return out;
}

/** Apply a completed upgrade to `owner`: record the tech and advance the age if it's an age tech. */
export function applyUpgrade(world: World, owner: number, id: UpgradeId): void {
  const def = UPGRADE_DEFS[id];
  const ps = getPlayerState(world, owner);
  if (def === undefined || ps === undefined) return;
  if (!ps.techs.includes(id)) ps.techs.push(id);
  if (def.setsAge !== undefined && ps.age < def.setsAge) ps.age = def.setsAge;
}
