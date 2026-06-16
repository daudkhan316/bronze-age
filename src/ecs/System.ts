import type { World } from "@/ecs/World";

/**
 * A system advances the world by one fixed simulation tick. Systems hold no
 * game state of their own (so the world stays the single serializable source
 * of truth); they read and mutate components via the world.
 *
 * `dt` is always the fixed tick delta (see TICK_DT) — never a variable frame
 * delta — which is what keeps the simulation deterministic.
 */
export interface System {
  readonly name: string;
  update(world: World, dt: number): void;
}
