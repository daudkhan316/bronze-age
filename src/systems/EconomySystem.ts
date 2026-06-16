import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import {
  CUnit,
  CBuilding,
  CPlayer,
  CTrainQueue,
  POP_PROVIDED,
  MAX_POP,
  VILLAGER_TRAIN_TICKS,
} from "@/game/components";
import { getPlayerState } from "@/game/economy";
import { spawnUnit } from "@/game/spawn";
import { standableTileNear } from "@/pathfinding/astar";
import type { GameMap } from "@/map/GameMap";
import type { Occupancy } from "@/map/Occupancy";

/**
 * Per-tick economy bookkeeping: keeps every player's population counters in
 * sync, then advances each Town Center's villager training queue.
 *
 * Two phases run in a fixed order each tick so the result is deterministic:
 *   1. Population — recompute popUsed (units owned) and popCap (Σ building
 *      headroom, clamped to MAX_POP) for every player.
 *   2. Training  — count down each Town Center's in-progress villager and spawn
 *      it on completion, subject to the live population cap.
 *
 * All counters are integers advanced on the fixed tick (no wall-clock, no RNG),
 * and every world.get is guarded under noUncheckedIndexedAccess /
 * strictNullChecks. The villager resource cost is charged by the UI at enqueue
 * time, so this system only decrements `queued` and spawns.
 */
export class EconomySystem implements System {
  readonly name = "economy";

  /**
   * Map + occupancy are needed to pick a free spawn tile beside a Town Center
   * (standableTileNear) so a finished villager never lands on an unwalkable tile
   * or another building's footprint.
   */
  constructor(
    private readonly map: GameMap,
    private readonly occ: Occupancy,
  ) {}

  update(world: World, _dt: number): void {
    const popUsed = this.recomputePopulation(world);
    this.processTraining(world, popUsed);
  }

  /**
   * Tally popUsed (units owned) and popCap (Σ POP_PROVIDED over owned buildings,
   * clamped to MAX_POP) per owner in one pass each, then write the totals back
   * onto every player state (0 where a player owns nothing of that kind).
   *
   * Returns the live popUsed tally so the training phase can reuse and locally
   * increment it as it spawns — avoiding a second full unit count and ensuring
   * multiple Town Centers completing the same tick can't jointly overshoot cap.
   */
  private recomputePopulation(world: World): Map<number, number> {
    const popUsed = new Map<number, number>();
    for (const [, unit] of world.query(CUnit)) {
      popUsed.set(unit.owner, (popUsed.get(unit.owner) ?? 0) + 1);
    }

    const popCap = new Map<number, number>();
    for (const [, b] of world.query(CBuilding)) {
      const provided = POP_PROVIDED[b.kind];
      popCap.set(b.owner, (popCap.get(b.owner) ?? 0) + provided);
    }

    for (const [, ps] of world.query(CPlayer)) {
      ps.popUsed = popUsed.get(ps.id) ?? 0;
      const cap = popCap.get(ps.id) ?? 0;
      ps.popCap = cap > MAX_POP ? MAX_POP : cap;
    }

    return popUsed;
  }

  /**
   * Advance each Town Center's training queue by one tick. A finished villager
   * (progress >= VILLAGER_TRAIN_TICKS) only spawns when the owner is below their
   * population cap; otherwise progress is CLAMPED at VILLAGER_TRAIN_TICKS so the
   * villager is HELD at the door (not lost, not re-trained) until a unit dies or
   * a house is built and pop frees up. We read popUsed/popCap from the player
   * state but track spawns this tick in the passed-in `popUsed` tally so several
   * Town Centers completing together honour the shared cap.
   */
  private processTraining(world: World, popUsed: Map<number, number>): void {
    for (const [e, b] of world.query(CBuilding)) {
      if (b.kind !== "town_center") continue;

      const tq = world.get(e, CTrainQueue);
      if (tq === undefined || tq.queued <= 0) continue;

      const ps = getPlayerState(world, b.owner);
      // popCap is authoritative from the recomputed player state; popUsed is the
      // live tally so in-tick spawns from sibling Town Centers are counted.
      const cap = ps !== undefined ? ps.popCap : 0;
      const used = popUsed.get(b.owner) ?? 0;

      tq.progress++;
      if (tq.progress < VILLAGER_TRAIN_TICKS) continue;

      // Pop full: hold the finished villager — clamp (don't keep incrementing).
      if (ps === undefined || used >= cap) {
        tq.progress = VILLAGER_TRAIN_TICKS;
        continue;
      }

      // Find a free tile beside the footprint centre to drop the new villager.
      const spot = standableTileNear(
        this.map,
        b.tx + (b.w >> 1),
        b.ty + (b.h >> 1),
        this.occ,
      );
      // No standable tile right now: leave progress maxed and retry next tick.
      if (spot === null) {
        tq.progress = VILLAGER_TRAIN_TICKS;
        continue;
      }

      spawnUnit(world, "villager", spot.tx, spot.ty, b.owner);
      tq.queued--;
      tq.progress = 0;
      // Count the new villager locally so a sibling Town Center this same tick
      // sees the higher popUsed and won't push the player over popCap.
      popUsed.set(b.owner, used + 1);
    }
  }
}
