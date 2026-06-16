import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import {
  CBuild,
  CBuilding,
  CConstruction,
  CMovement,
  CTransform,
  CUnit,
  BUILD_RATE,
  INTERACT_RANGE,
} from "@/game/components";
import { tileRangeToBuilding, approachTileForBuilding } from "@/game/economy";
import { worldToTile } from "@/math/iso";
import type { GameMap } from "@/map/GameMap";
import type { Occupancy } from "@/map/Occupancy";
import { findPath } from "@/pathfinding/astar";

/**
 * Drives every constructing villager through a two-state build loop:
 *
 *   toSite → building → (foundation completes; villager drops to idle)
 *
 * Like the GatherSystem this only sets *intent*: it seeds the Movement
 * component's path (when empty) toward a standable tile adjacent to the target
 * foundation, and once the villager is within INTERACT_RANGE it pours build
 * points into the foundation's Construction component. The MovementSystem does
 * the actual walking.
 *
 * Each builder adds BUILD_RATE * dt build points per tick, so N villagers on the
 * same foundation finish it ~N× faster (their contributions simply sum into the
 * shared Construction.progress). We only seed `mv.path` when it's empty so we
 * never thrash an in-progress route. All decisions derive from component state +
 * the fixed `dt`, so the system is deterministic.
 *
 * Iteration safety: the only structural mutations are `world.remove(target,
 * CConstruction)` — the target is a Building entity, never in the CBuild query —
 * and `world.remove(e, CBuild)` on the CURRENT entity. Neither perturbs the
 * CBuild query we're iterating. When a foundation completes, any OTHER builders
 * still pointed at it will observe `con === undefined` on their next tick and
 * cleanly drop their own CBuild (going idle).
 */
export class BuildSystem implements System {
  readonly name = "build";

  constructor(
    private readonly map: GameMap,
    private readonly occ: Occupancy,
  ) {}

  update(world: World, dt: number): void {
    for (const [e, bd] of world.query(CBuild)) {
      const tr = world.get(e, CTransform);
      const mv = world.get(e, CMovement);
      const unit = world.get(e, CUnit);
      if (tr === undefined || mv === undefined || unit === undefined) continue;

      const building = world.get(bd.target, CBuilding);
      const con = world.get(bd.target, CConstruction);
      // Foundation gone or already complete (Construction removed) — nothing to
      // build; release the villager to idle.
      if (building === undefined || con === undefined) {
        world.remove(e, CBuild);
        continue;
      }

      const here = worldToTile(tr.x, tr.y);
      const adjacent = tileRangeToBuilding(here.tx, here.ty, building) <= INTERACT_RANGE;

      switch (bd.state) {
        case "toSite": {
          if (adjacent) {
            // Arrived: stop walking and start hammering.
            bd.state = "building";
            mv.path.length = 0;
            mv.goal = null;
          } else if (mv.path.length === 0) {
            // Path to a tile on the footprint's adjacency ring (provably within
            // INTERACT_RANGE, so arrival guarantees `adjacent`). If the ring is
            // fully blocked or unreachable, abandon the task rather than
            // re-deriving the same dead end every tick (an empty path also
            // defeats the mover's stuck-detector, which would soft-lock us).
            const stand = approachTileForBuilding(this.map, this.occ, building);
            const path = stand === null ? [] : findPath(this.map, here, stand, this.occ);
            if (path.length === 0) {
              world.remove(e, CBuild);
              continue;
            }
            mv.path = path;
            mv.goal = stand;
          }
          break;
        }

        case "building": {
          if (!adjacent) {
            // Drifted (or got shoved) out of range — walk back to the site.
            bd.state = "toSite";
            break;
          }
          // This builder's contribution for the tick.
          con.progress += BUILD_RATE * dt;
          // Ramp visible HP with construction progress.
          building.hp = Math.max(
            building.hp,
            Math.round(building.maxHp * Math.min(1, con.progress / con.required)),
          );
          if (con.progress >= con.required) {
            // Foundation finished: promote it to a functional building. Other
            // builders on this target will see `con === undefined` next tick and
            // drop their CBuild. Occupancy is intentionally left untouched — the
            // footprint stays blocked for the building's whole life; any future
            // cancel/destroy path must clear it via Game.setBuildingOccupancy.
            building.complete = true;
            building.hp = building.maxHp;
            world.remove(bd.target, CConstruction);
            world.remove(e, CBuild);
          }
          break;
        }

        default:
          break;
      }
    }
  }
}
