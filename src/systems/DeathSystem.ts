import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import type { Occupancy } from "@/map/Occupancy";
import { reapDead } from "@/game/combat";

/**
 * Removes entities reduced to 0 hp, after all of the tick's damage has been
 * applied (so combat/projectile systems never destroy entities mid-iteration).
 * Frees a destroyed building's footprint in the occupancy grid.
 */
export class DeathSystem implements System {
  readonly name = "death";

  constructor(private readonly occ: Occupancy) {}

  update(world: World, _dt: number): void {
    reapDead(world, this.occ);
  }
}
