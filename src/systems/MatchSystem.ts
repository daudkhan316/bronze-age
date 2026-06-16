import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import { CPlayer, CBuilding, CMatch } from "@/game/components";

/**
 * Decides the match outcome each tick: a player is defeated once they own no
 * buildings (foundations count — you're alive while any structure stands). When
 * at most one of two-or-more players still has buildings, the match is over and
 * the survivor (or null, on a mutual wipe) is latched into the singleton Match
 * component. Latches once decided so the result never flickers.
 *
 * Runs AFTER DeathSystem so a building destroyed this tick is already reaped.
 * Deterministic: pure counts over the world, no RNG, stable iteration.
 */
export class MatchSystem implements System {
  readonly name = "match";

  update(world: World, _dt: number): void {
    const match = firstMatch(world);
    if (match === null || match.over) return; // no match entity yet, or already decided

    // Count buildings per owner in one pass.
    const buildings = new Map<number, number>();
    for (const [, b] of world.query(CBuilding)) {
      buildings.set(b.owner, (buildings.get(b.owner) ?? 0) + 1);
    }

    const players = [...world.query(CPlayer)].map(([, p]) => p);
    const stillAlive: number[] = [];
    for (const p of players) {
      const count = buildings.get(p.id) ?? 0;
      if (count === 0) {
        p.defeated = true;
      } else {
        stillAlive.push(p.id);
      }
    }

    // Only conclude a real contest (≥2 players) once at most one survives.
    if (players.length >= 2 && stillAlive.length <= 1) {
      match.over = true;
      match.winner = stillAlive.length === 1 ? (stillAlive[0] ?? null) : null;
    }
  }
}

/** The singleton Match component, or null if none exists yet. */
function firstMatch(world: World): { over: boolean; winner: number | null } | null {
  for (const [, m] of world.query(CMatch)) return m;
  return null;
}
