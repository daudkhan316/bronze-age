import { World } from "@/ecs/World";
import type { WorldSnapshot } from "@/ecs/World";
import type { System } from "@/ecs/System";
import { GameMap } from "@/map/GameMap";
import type { Terrain } from "@/map/Terrain";
import { generateMap } from "@/map/generate";
import { Random } from "@/core/Random";
import { gridToWorld } from "@/math/iso";
import type { GridPoint } from "@/math/iso";
import type { Vec2 } from "@/math/Vec2";
import { DEFAULT_MAP_W, DEFAULT_MAP_H, SIM_SEED_OFFSET } from "@/config";
import { Occupancy } from "@/map/Occupancy";
import { MovementSystem } from "@/systems/MovementSystem";
import { GatherSystem } from "@/systems/GatherSystem";
import { EconomySystem } from "@/systems/EconomySystem";
import { spawnUnit, spawnResourceNode, spawnBuilding, spawnPlayer } from "@/game/spawn";
import { canStand } from "@/pathfinding/astar";
import { PLAYER_ID, CBuilding, type ResourceKind } from "@/game/components";

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
 * occupancy grid, the seeded RNG, the ordered system list, and the tick counter.
 * The render/camera/input layers live outside and only read from here.
 *
 * Map generation and the simulation use SEPARATE RNG streams (derived from the
 * same seed) so the sim's randomness doesn't depend on map geometry — see the
 * note in the constructor.
 */
export class Game {
  readonly world: World;
  readonly map: GameMap;
  readonly seed: number;
  /** Tiles blocked by buildings (rebuilt on load; not serialized). */
  readonly occ: Occupancy;
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
      this.occ = new Occupancy(this.map.width, this.map.height);
      this.rebuildOccupancy();
    } else {
      const genRng = new Random(seed);
      this.map = generateMap(DEFAULT_MAP_W, DEFAULT_MAP_H, genRng);
      this.rng = new Random((seed ^ SIM_SEED_OFFSET) >>> 0);
      this.world = new World();
      this.occ = new Occupancy(this.map.width, this.map.height);
      this.setupEconomy();
    }
    // Systems are logic, not state — recreated on load, never serialized.
    // Order: gather (sets paths, harvests, deposits) → movement (consumes
    // paths) → economy (population recount + training).
    this.systems = [
      new GatherSystem(this.map, this.occ),
      new MovementSystem(this.map, this.occ),
      new EconomySystem(this.map, this.occ),
    ];
  }

  /** Rebuild the occupancy grid from the world's building footprints. */
  private rebuildOccupancy(): void {
    this.occ.clear();
    for (const [, b] of this.world.query(CBuilding)) {
      this.occ.setRect(b.tx, b.ty, b.w, b.h, true);
    }
  }

  // --- initial economy setup (fresh game only) ----------------------------

  private setupEconomy(): void {
    const map = this.map;
    const cx = Math.floor(map.width / 2);
    const cy = Math.floor(map.height / 2);

    spawnPlayer(this.world, PLAYER_ID);

    // Turn resource terrain into harvestable nodes (trees / gold / stone).
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const t = map.get(tx, ty);
        const kind: ResourceKind | null =
          t === "forest" ? "wood" : t === "gold" ? "gold" : t === "stone" ? "stone" : null;
        if (kind !== null) spawnResourceNode(this.world, kind, tx, ty);
      }
    }

    // Town Center on a clear 3×3 area near the centre.
    const tc = this.findClearArea(cx, cy, 3, 3) ?? { tx: cx, ty: cy };
    spawnBuilding(this.world, "town_center", PLAYER_ID, tc.tx, tc.ty);
    this.occ.setRect(tc.tx, tc.ty, 3, 3, true);

    // Two houses on nearby clear 2×2 areas.
    let houses = 0;
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [-3, 0],
      [4, 0],
      [0, -3],
      [-3, 4],
      [4, 4],
      [0, 5],
    ];
    for (const [ox, oy] of offsets) {
      if (houses >= 2) break;
      const hx = tc.tx + ox;
      const hy = tc.ty + oy;
      if (this.areaClear(hx, hy, 2, 2)) {
        spawnBuilding(this.world, "house", PLAYER_ID, hx, hy);
        this.occ.setRect(hx, hy, 2, 2, true);
        houses++;
      }
    }

    // Guarantee a starting wood grove and food bushes near the Town Center.
    this.scatterNodes(tc.tx - 6, tc.ty - 1, "wood", 10, true);
    this.scatterNodes(tc.tx + 2, tc.ty + 6, "food", 6, false);

    // Three starting villagers on standable tiles ringing the Town Center.
    const spots = this.tilesAround(tc.tx, tc.ty, 3, 3, 3);
    for (const s of spots) spawnUnit(this.world, "villager", s.tx, s.ty, PLAYER_ID);
  }

  /** All tiles of a w×h block are in-bounds, standable, and unoccupied. */
  private areaClear(tx: number, ty: number, w: number, h: number): boolean {
    for (let y = ty; y < ty + h; y++) {
      for (let x = tx; x < tx + w; x++) {
        if (!canStand(this.map, x, y, this.occ)) return false;
      }
    }
    return true;
  }

  /** Nearest clear w×h block origin to (cx, cy), or null. */
  private findClearArea(cx: number, cy: number, w: number, h: number): GridPoint | null {
    for (let r = 0; r <= 16; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.areaClear(cx + dx, cy + dy, w, h)) return { tx: cx + dx, ty: cy + dy };
        }
      }
    }
    return null;
  }

  /**
   * Place up to `count` resource nodes of `kind` on grass tiles spiralling out
   * from (cx, cy). `asForest` also flips the terrain to forest (a planted grove)
   * so the wood is visible and blocks like real trees.
   */
  private scatterNodes(
    cx: number,
    cy: number,
    kind: ResourceKind,
    count: number,
    asForest: boolean,
  ): void {
    let placed = 0;
    for (let r = 0; r <= 14 && placed < count; r++) {
      for (let dy = -r; dy <= r && placed < count; dy++) {
        for (let dx = -r; dx <= r && placed < count; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = cx + dx;
          const ty = cy + dy;
          if (!this.map.inBounds(tx, ty)) continue;
          if (this.map.get(tx, ty) !== "grass" || this.occ.isBlocked(tx, ty)) continue;
          if (asForest) this.map.set(tx, ty, "forest");
          spawnResourceNode(this.world, kind, tx, ty);
          placed++;
        }
      }
    }
  }

  /** Up to `want` standable tiles on the perimeter rings around a building box. */
  private tilesAround(tx: number, ty: number, w: number, h: number, want: number): GridPoint[] {
    const out: GridPoint[] = [];
    for (let r = 1; r <= 6 && out.length < want; r++) {
      const x0 = tx - r;
      const x1 = tx + w - 1 + r;
      const y0 = ty - r;
      const y1 = ty + h - 1 + r;
      for (let y = y0; y <= y1 && out.length < want; y++) {
        for (let x = x0; x <= x1 && out.length < want; x++) {
          if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue; // perimeter only
          if (canStand(this.map, x, y, this.occ)) out.push({ tx: x, ty: y });
        }
      }
    }
    return out;
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
