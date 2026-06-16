import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import { CMovement, CTransform, CUnit } from "@/game/components";
import type { Transform } from "@/game/components";
import { tileCenterWorld, worldToTile } from "@/math/iso";
import type { GameMap } from "@/map/GameMap";
import { isWalkable } from "@/pathfinding/astar";

/** Ticks of near-zero net progress before a pathing unit gives up (≈1.5s @20Hz). */
const STUCK_LIMIT = 30;
/** A tick counts as "progress" if net movement exceeds this fraction of a step. */
const PROGRESS_FRACTION = 0.2;

/**
 * Advances every mover one tile-waypoint at a time, then resolves overlaps
 * between unit bodies with a single local-separation pass.
 *
 * Two phases run in a fixed order each tick so the result is deterministic:
 *   1. Path following — integrate position toward the next waypoint.
 *   2. Separation     — push overlapping units apart (without leaving the map).
 *
 * Keeping separation as a *post-pass* (rather than steering during step 1)
 * means a mover that walks into a stationary unit still reaches its waypoint
 * centre, and the idle unit simply gets nudged aside — which is the "crowd
 * shuffles out of the way" feel we want without any steering/avoidance search.
 */
export class MovementSystem implements System {
  readonly name = "movement";

  /** The map is needed so separation never shoves a unit onto unwalkable terrain. */
  constructor(private readonly map: GameMap) {}

  update(world: World, dt: number): void {
    // Snapshot pre-tick positions of active movers so we can measure NET
    // progress after both phases (path-following can step a unit forward only
    // for separation to shove it back — that nets to zero and means "stuck").
    const before = new Map<Entity, { x: number; y: number }>();
    for (const [e, mv] of world.query(CMovement)) {
      if (mv.path.length === 0) continue;
      const tr = world.get(e, CTransform);
      if (tr !== undefined) before.set(e, { x: tr.x, y: tr.y });
    }

    this.followPaths(world, dt);
    this.separate(world);

    this.detectStuck(world, dt, before);
  }

  /**
   * Give up on a path that's making no headway. A unit wedged in a crowd that
   * can't all reach the destination would otherwise oscillate forever (path
   * never empties); after STUCK_LIMIT ticks of near-zero net movement we clear
   * its path so it settles where it is. Deterministic: the counter lives on the
   * Movement component and advances on the fixed tick.
   */
  private detectStuck(
    world: World,
    dt: number,
    before: Map<Entity, { x: number; y: number }>,
  ): void {
    for (const [e, mv] of world.query(CMovement)) {
      if (mv.path.length === 0) {
        mv.stuck = 0;
        continue;
      }
      const prev = before.get(e);
      const tr = world.get(e, CTransform);
      if (prev === undefined || tr === undefined) continue;

      const net = Math.hypot(tr.x - prev.x, tr.y - prev.y);
      if (net < mv.speed * dt * PROGRESS_FRACTION) {
        mv.stuck++;
        if (mv.stuck >= STUCK_LIMIT) {
          mv.path.length = 0;
          mv.goal = null;
          mv.stuck = 0;
        }
      } else {
        mv.stuck = 0;
      }
    }
  }

  /**
   * Walk each mover toward `path[0]`, consuming a per-tick distance budget that
   * carries across waypoints — so arriving early at one waypoint doesn't waste
   * the leftover distance and the unit holds its true average speed. On arrival
   * we snap exactly onto the tile centre (no fractional drift) and pop the
   * waypoint; clearing `goal` on the final pop marks the unit idle.
   */
  private followPaths(world: World, dt: number): void {
    for (const [e, mv] of world.query(CMovement)) {
      // Guard: a mover with no body can't move; an empty path is already idle.
      const tr = world.get(e, CTransform);
      if (tr === undefined || mv.path.length === 0) continue;

      let budget = mv.speed * dt;
      while (budget > 0 && mv.path.length > 0) {
        const next = mv.path[0];
        if (next === undefined) break; // noUncheckedIndexedAccess narrowing.

        const target = tileCenterWorld(next.tx, next.ty);
        const dx = target.x - tr.x;
        const dy = target.y - tr.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= budget || dist === 0) {
          // Reach this waypoint: snap, consume the distance, keep the remainder
          // for the next waypoint this same tick.
          tr.x = target.x;
          tr.y = target.y;
          mv.path.shift();
          if (mv.path.length === 0) mv.goal = null;
          budget -= dist;
        } else {
          // Advance along the unit direction; the whole budget is spent.
          const inv = budget / dist;
          tr.x += dx * inv;
          tr.y += dy * inv;
          budget = 0;
        }
      }
    }
  }

  /**
   * One O(n^2) separation pass over all unit bodies. For each overlapping
   * unordered pair, split the correction evenly so both move — letting a mover
   * displace an idle unit. A push is only applied if it keeps the unit's centre
   * on a walkable tile, so crowding at a shoreline/forest edge can never strand
   * a unit on water/forest (which would make it permanently un-pathable, since
   * A* refuses to path from an unwalkable start). O(n^2) is acceptable at Phase 1
   * unit counts; replace with a spatial grid (uniform hash) once crowds grow.
   */
  private separate(world: World): void {
    // Snapshot to a stable array so the i<j double loop visits each unordered
    // pair exactly once in deterministic (query insertion) order.
    const movers: Array<{ e: Entity; tr: Transform; radius: number }> = [];
    for (const [e, unit] of world.query(CUnit)) {
      const tr = world.get(e, CTransform);
      if (tr === undefined) continue;
      movers.push({ e, tr, radius: unit.radius });
    }

    for (let i = 0; i < movers.length; i++) {
      const a = movers[i];
      if (a === undefined) continue; // narrowing under noUncheckedIndexedAccess.
      for (let j = i + 1; j < movers.length; j++) {
        const b = movers[j];
        if (b === undefined) continue;

        const minDist = a.radius + b.radius;
        let dx = b.tr.x - a.tr.x;
        let dy = b.tr.y - a.tr.y;
        let dist = Math.hypot(dx, dy);

        if (dist >= minDist) continue; // Not overlapping.

        if (dist === 0) {
          // Exactly coincident: deterministically derive a separation axis from
          // the entity ids (lower id pushed one way, higher the other) so the
          // result is identical across runs — no Math.random.
          dx = b.e - a.e >= 0 ? 1 : -1;
          dy = 0;
          dist = 1;
        }

        // Move each centre half the overlap apart along the contact normal,
        // but only onto walkable ground.
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        const half = overlap / 2;
        this.pushIfWalkable(a.tr, -nx * half, -ny * half);
        this.pushIfWalkable(b.tr, nx * half, ny * half);
      }
    }
  }

  /** Apply a positional nudge only if it keeps the unit on a walkable tile. */
  private pushIfWalkable(tr: Transform, ddx: number, ddy: number): void {
    const nx = tr.x + ddx;
    const ny = tr.y + ddy;
    const tile = worldToTile(nx, ny);
    if (isWalkable(this.map, tile.tx, tile.ty)) {
      tr.x = nx;
      tr.y = ny;
    }
  }
}
