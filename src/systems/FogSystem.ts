import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import { CUnit, CBuilding, CTransform, UNIT_STATS, BUILDING_DEFS } from "@/game/components";
import { worldToTile } from "@/math/iso";
import type { Fog } from "@/map/Fog";

/**
 * Recomputes the viewing player's visibility each tick: clears the visible set,
 * then reveals a circle of `sight` tiles around every unit and building owned by
 * the viewer. Deterministic (reads positions + static sight radii only).
 *
 * Recomputing every tick is wasteful but cheap at this map size; throttle later
 * if needed.
 */
export class FogSystem implements System {
  readonly name = "fog";

  constructor(
    private readonly fog: Fog,
    private readonly viewer: number,
  ) {}

  update(world: World, _dt: number): void {
    this.fog.clearVisible();

    for (const [e, u] of world.query(CUnit)) {
      if (u.owner !== this.viewer) continue;
      const tr = world.get(e, CTransform);
      if (tr === undefined) continue;
      const t = worldToTile(tr.x, tr.y);
      this.revealCircle(t.tx, t.ty, UNIT_STATS[u.kind].sight);
    }

    for (const [e, b] of world.query(CBuilding)) {
      if (b.owner !== this.viewer) continue;
      const tr = world.get(e, CTransform);
      if (tr === undefined) continue;
      // Reveal from the footprint centre with the kind's sight plus its half-extent.
      const cx = b.tx + (b.w >> 1);
      const cy = b.ty + (b.h >> 1);
      this.revealCircle(cx, cy, BUILDING_DEFS[b.kind].sight + Math.max(b.w, b.h) / 2);
    }
  }

  /** Reveal every tile whose centre is within `radius` tiles of (cx, cy). */
  private revealCircle(cx: number, cy: number, radius: number): void {
    const r = Math.ceil(radius);
    const r2 = radius * radius;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r2) this.fog.reveal(cx + dx, cy + dy);
      }
    }
  }
}
