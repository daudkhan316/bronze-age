import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import {
  CGather,
  CMovement,
  CTransform,
  CUnit,
  CResourceNode,
  CARRY_CAPACITY,
  GATHER_RATE,
  INTERACT_RANGE,
  NODE_SEARCH_RADIUS,
} from "@/game/components";
import {
  findNearestDropoff,
  findNearestNodeOfKind,
  getPlayerState,
  tileRangeToBuilding,
  approachTileForBuilding,
} from "@/game/economy";
import { gatherMultiplier } from "@/game/tech";
import type { GridPoint } from "@/math/iso";
import { worldToTile } from "@/math/iso";
import type { GameMap } from "@/map/GameMap";
import type { Occupancy } from "@/map/Occupancy";
import { findPath, standableTileNear } from "@/pathfinding/astar";

/** Chebyshev (king-move) tile distance — the metric INTERACT_RANGE is measured in. */
function cheb(a: GridPoint, b: GridPoint): number {
  return Math.max(Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty));
}

/**
 * Drives every gathering villager through a four-state economy loop:
 *
 *   toNode → gathering → toDrop → depositing → (back to a fresh node)
 *
 * This system only ever sets *intent*: it picks a target tile and seeds the
 * Movement component's path (when empty) — the MovementSystem does the actual
 * walking. It harvests/deposits when the villager is already in INTERACT_RANGE.
 * Removing the Gather component drops the villager to idle (no target found).
 *
 * Loop pattern: snapshot nothing — we mutate the live Gather/Movement/Transform
 * components in place. We never re-path while a walk is in progress (only seed
 * `mv.path` when it's empty) so we don't thrash an active route. All decisions
 * derive from component state + the fixed `dt`, so the system is deterministic.
 *
 * Note on iteration safety: depleting a node calls `world.destroyEntity` on the
 * *node* entity (which carries no Gather component), so it never perturbs the
 * Gather query we're iterating.
 */
export class GatherSystem implements System {
  readonly name = "gather";

  constructor(
    private readonly map: GameMap,
    private readonly occ: Occupancy,
  ) {}

  update(world: World, dt: number): void {
    for (const [e, g] of world.query(CGather)) {
      const tr = world.get(e, CTransform);
      const mv = world.get(e, CMovement);
      const unit = world.get(e, CUnit);
      if (tr === undefined || mv === undefined || unit === undefined) continue;

      const owner = unit.owner;
      const here = worldToTile(tr.x, tr.y);

      switch (g.state) {
        case "toNode": {
          // Validate the assigned node; if it's gone/empty, try to re-task to
          // another node of the same kind nearby.
          let node = g.node === null ? undefined : world.get(g.node, CResourceNode);
          if (node === undefined || node.amount <= 0) {
            if (g.resourceKind === null) {
              world.remove(e, CGather);
              continue;
            }
            const hit = findNearestNodeOfKind(
              world,
              g.resourceKind,
              tr.x,
              tr.y,
              NODE_SEARCH_RADIUS,
            );
            if (hit === null) {
              world.remove(e, CGather); // nothing left to gather — go idle.
              continue;
            }
            g.node = hit.entity;
            g.resourceKind = hit.node.kind;
            node = hit.node;
          } else {
            // Keep the carried kind in sync with the live node.
            g.resourceKind = node.kind;
          }

          const nodeTile: GridPoint = { tx: node.tx, ty: node.ty };
          if (cheb(here, nodeTile) <= INTERACT_RANGE) {
            g.state = "gathering";
            mv.path.length = 0;
            mv.goal = null;
          } else if (mv.path.length === 0) {
            // The approach tile must be ADJACENT to the node (within
            // INTERACT_RANGE) — a bounded search. If the node is walled in
            // (no standable neighbour) or that tile is unreachable, abandon the
            // task rather than re-deriving the same dead end every tick (which
            // would soft-lock the villager: an empty path defeats the mover's
            // stuck-detector too).
            const stand = standableTileNear(this.map, node.tx, node.ty, this.occ, INTERACT_RANGE);
            const path = stand === null ? [] : findPath(this.map, here, stand, this.occ);
            if (path.length === 0) {
              world.remove(e, CGather);
              continue;
            }
            mv.path = path;
            mv.goal = stand;
          }
          break;
        }

        case "gathering": {
          const node = g.node === null ? undefined : world.get(g.node, CResourceNode);
          if (node === undefined || node.amount <= 0) {
            // Node vanished/emptied out from under us.
            g.node = null;
            g.state = g.carrying > 0 ? "toDrop" : "toNode";
            break;
          }

          const nodeTile: GridPoint = { tx: node.tx, ty: node.ty };
          if (cheb(here, nodeTile) > INTERACT_RANGE) {
            g.state = "toNode"; // drifted out of range — walk back.
            break;
          }

          // Effective rate folds in the owner's researched gather upgrades (Phase 6).
          const rate = GATHER_RATE * gatherMultiplier(world, owner);
          const take = Math.min(
            rate * dt,
            CARRY_CAPACITY - g.carrying,
            node.amount,
          );
          g.carrying += take;
          node.amount -= take;
          g.resourceKind = node.kind;

          if (node.amount <= 0) {
            // Deplete: destroy the node and open up its tile if it was a
            // resource-bearing terrain feature (forest/gold/stone -> grass).
            const terrain = this.map.get(node.tx, node.ty);
            if (terrain === "forest" || terrain === "gold" || terrain === "stone") {
              this.map.set(node.tx, node.ty, "grass");
            }
            if (g.node !== null) world.destroyEntity(g.node);
            g.node = null;
          }

          if (g.carrying >= CARRY_CAPACITY) {
            g.state = "toDrop";
          } else if (g.node === null) {
            g.state = g.carrying > 0 ? "toDrop" : "toNode";
          }
          break;
        }

        case "toDrop": {
          if (g.resourceKind === null) {
            world.remove(e, CGather);
            continue;
          }
          const drop = findNearestDropoff(world, owner, g.resourceKind, tr.x, tr.y);
          if (drop === null) {
            world.remove(e, CGather); // nowhere to deposit — give up.
            continue;
          }

          if (tileRangeToBuilding(here.tx, here.ty, drop.building) <= INTERACT_RANGE) {
            g.state = "depositing";
            mv.path.length = 0;
            mv.goal = null;
          } else if (mv.path.length === 0) {
            // Walk to a tile on the drop-off's adjacency ring (provably within
            // INTERACT_RANGE, so arrival lets us deposit).
            const stand = approachTileForBuilding(this.map, this.occ, drop.building);
            if (stand !== null) {
              mv.path = findPath(this.map, here, stand, this.occ);
              mv.goal = stand;
            }
          }
          break;
        }

        case "depositing": {
          const ps = getPlayerState(world, owner);
          if (ps !== undefined && g.carrying > 0 && g.resourceKind !== null) {
            ps[g.resourceKind] += g.carrying;
          }
          g.carrying = 0;

          // Head back to a fresh node of the same kind if one is in range;
          // otherwise the villager has no more work — go idle.
          if (g.resourceKind !== null) {
            const hit = findNearestNodeOfKind(
              world,
              g.resourceKind,
              tr.x,
              tr.y,
              NODE_SEARCH_RADIUS,
            );
            if (hit !== null) {
              g.node = hit.entity;
              g.state = "toNode";
              break;
            }
          }
          world.remove(e, CGather);
          break;
        }

        default:
          break;
      }
    }
  }
}
