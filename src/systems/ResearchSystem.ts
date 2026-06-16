import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import { CResearch, CBuilding, type UpgradeId } from "@/game/components";
import { applyUpgrade } from "@/game/tech";

/**
 * Advances each building's in-progress research one tick. On completion it
 * applies the upgrade to the building's owner (records the tech and, for an age
 * advance, bumps the player's age) and clears the `Research` component.
 *
 * Tick-based like training (one progress point per tick); no RNG, no clocks.
 * Collects finished researches first, then applies/removes them, so we never
 * mutate the query mid-iteration.
 */
export class ResearchSystem implements System {
  readonly name = "research";

  update(world: World, _dt: number): void {
    const done: Array<{ e: Entity; owner: number; id: UpgradeId }> = [];
    for (const [e, r] of world.query(CResearch)) {
      const b = world.get(e, CBuilding);
      if (b === undefined) continue; // research only lives on buildings
      r.progress++;
      if (r.progress >= r.required) done.push({ e, owner: b.owner, id: r.id });
    }
    for (const d of done) {
      applyUpgrade(world, d.owner, d.id);
      world.remove(d.e, CResearch);
    }
  }
}
