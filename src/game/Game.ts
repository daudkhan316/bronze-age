import { World } from "@/ecs/World";
import type { WorldSnapshot } from "@/ecs/World";
import type { System } from "@/ecs/System";
import { GameMap } from "@/map/GameMap";
import type { Terrain } from "@/map/Terrain";
import { generateMap } from "@/map/generate";
import { Random } from "@/core/Random";
import { gridToWorld } from "@/math/iso";
import type { Vec2 } from "@/math/Vec2";
import { DEFAULT_MAP_W, DEFAULT_MAP_H, SIM_SEED_OFFSET } from "@/config";

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Complete, JSON-safe snapshot of the simulation for save/load. */
export interface GameSnapshot {
  seed: number;
  tick: number;
  /** Simulation RNG state (single uint32). */
  rng: number;
  world: WorldSnapshot;
  map: { width: number; height: number; tiles: Terrain[] };
}

/** Pre-built pieces used to restore a Game without regenerating the map. */
interface GameRestore {
  rng: Random;
  map: GameMap;
  world: World;
  tick: number;
}

/**
 * Owns everything in the deterministic simulation: the ECS world, the map, the
 * seeded RNG, the ordered system list, and the authoritative tick counter. The
 * render/camera/input layers live outside and only read from here.
 *
 * Map generation and the simulation use SEPARATE RNG streams (derived from the
 * same seed). This matters: generation consumes a data-dependent number of
 * draws, so sharing one stream would make the sim's randomness depend on map
 * geometry and tangle save/load. Keeping them independent lets a save serialize
 * the sim RNG state cleanly (and optionally regenerate the map from `seed`).
 *
 * Phase 0 has no systems or entities yet — this is the seam Phase 1 plugs units
 * and movement into.
 */
export class Game {
  readonly world: World;
  readonly map: GameMap;
  readonly seed: number;
  /** Simulation RNG — never use Math.random() in sim code, draw from this. */
  readonly rng: Random;
  /** Authoritative simulation time, in ticks. Part of the save snapshot. */
  tick = 0;
  private readonly systems: System[];

  constructor(seed: number, restore?: GameRestore) {
    this.seed = seed;
    if (restore !== undefined) {
      this.rng = restore.rng;
      this.map = restore.map;
      this.world = restore.world;
      this.tick = restore.tick;
    } else {
      const genRng = new Random(seed);
      this.map = generateMap(DEFAULT_MAP_W, DEFAULT_MAP_H, genRng);
      this.rng = new Random((seed ^ SIM_SEED_OFFSET) >>> 0);
      this.world = new World();
    }
    this.systems = [];
  }

  /** Run one fixed simulation tick: every system in order, then advance time. */
  fixedUpdate(dt: number): void {
    for (const system of this.systems) {
      system.update(this.world, dt);
    }
    this.tick++;
  }

  serialize(): GameSnapshot {
    return {
      seed: this.seed,
      tick: this.tick,
      rng: this.rng.save(),
      world: this.world.serialize(),
      map: {
        width: this.map.width,
        height: this.map.height,
        tiles: [...this.map.data],
      },
    };
  }

  static deserialize(snap: GameSnapshot): Game {
    return new Game(snap.seed, {
      rng: Random.restore(snap.rng),
      map: new GameMap(snap.map.width, snap.map.height, [...snap.map.tiles]),
      world: World.deserialize(snap.world),
      tick: snap.tick,
    });
  }

  /** World-space point at the centre of the map (initial camera target). */
  centerWorld(): Vec2 {
    return gridToWorld(this.map.width / 2, this.map.height / 2);
  }

  /** World-space bounding box of the map's four corners (for camera clamping). */
  worldBounds(): WorldBounds {
    const corners = [
      gridToWorld(0, 0),
      gridToWorld(this.map.width, 0),
      gridToWorld(0, this.map.height),
      gridToWorld(this.map.width, this.map.height),
    ];
    return {
      minX: Math.min(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxX: Math.max(...corners.map((c) => c.x)),
      maxY: Math.max(...corners.map((c) => c.y)),
    };
  }
}
