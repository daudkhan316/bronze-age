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
import { SIM_SEED_OFFSET } from "@/config";
import { Occupancy } from "@/map/Occupancy";
import { Fog } from "@/map/Fog";
import { MovementSystem } from "@/systems/MovementSystem";
import { GatherSystem } from "@/systems/GatherSystem";
import { BuildSystem } from "@/systems/BuildSystem";
import { CombatSystem } from "@/systems/CombatSystem";
import { ProjectileSystem } from "@/systems/ProjectileSystem";
import { EconomySystem } from "@/systems/EconomySystem";
import { DeathSystem } from "@/systems/DeathSystem";
import { FogSystem } from "@/systems/FogSystem";
import { MatchSystem } from "@/systems/MatchSystem";
import { ResearchSystem } from "@/systems/ResearchSystem";
import { TowerSystem } from "@/systems/TowerSystem";
import { AiSystem } from "@/systems/AiSystem";
import { spawnUnit, spawnResourceNode, spawnBuilding, spawnPlayer } from "@/game/spawn";
import { canStand } from "@/pathfinding/astar";
import { CommandBuffer, executeCommand } from "@/game/commands";
import { EventBuffer } from "@/game/events";
import {
  PLAYER_ID,
  AI_ID,
  CBuilding,
  CTransform,
  CPlayer,
  CAiMemory,
  CMatch,
  BUILDING_DEFS,
  type Building,
  type ResourceKind,
} from "@/game/components";
import type { MatchConfig } from "@/game/match";

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Save-format version. Bump when the snapshot shape changes so `deserialize`
 * rejects an incompatible save cleanly rather than silently restoring garbage.
 */
export const SAVE_VERSION = 1;

/** Complete, JSON-safe snapshot of the simulation for save/load. */
export interface GameSnapshot {
  /** Save-format version (see SAVE_VERSION). */
  version: number;
  seed: number;
  tick: number;
  /** Simulation RNG state (single uint32). */
  rng: number;
  world: WorldSnapshot;
  map: { width: number; height: number; tiles: Terrain[] };
  /** Pending command buffer (intents queued but not yet applied). */
  commands: ReturnType<CommandBuffer["serialize"]>;
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
 * occupancy grid, per-player fog, the seeded RNG, the per-tick command buffer,
 * the ordered system list, and the tick counter. The render/camera/input layers
 * live outside and only read from here (and enqueue commands).
 *
 * Map generation and the simulation use SEPARATE RNG streams (derived from the
 * same seed) so the sim's randomness doesn't depend on map geometry.
 */
export class Game {
  readonly world: World;
  readonly map: GameMap;
  readonly seed: number;
  /** Tiles blocked by buildings (rebuilt on load; not serialized). */
  readonly occ: Occupancy;
  /** Per-player fog of war (derived, recomputed each tick; not serialized). */
  private readonly fogs = new Map<number, Fog>();
  /** Pending player + AI intents, applied at the start of each tick. */
  readonly commands = new CommandBuffer();
  /**
   * View-facing simulation events emitted during the tick (deaths, arrows,
   * completions). The view drains these each frame for feedback (audio). NOT
   * serialized and never read by sim code, so it can't affect determinism.
   */
  readonly events = new EventBuffer();
  /** Simulation RNG — never use Math.random() in sim code, draw from this. */
  readonly rng: Random;
  /** Authoritative simulation time, in ticks. Part of the save snapshot. */
  tick = 0;
  private readonly systems: System[];

  constructor(config: MatchConfig, restore?: GameRestore) {
    this.seed = config.seed;
    if (restore !== undefined) {
      this.rng = restore.rng;
      this.map = restore.map;
      this.world = restore.world;
      this.tick = restore.tick;
      this.occ = new Occupancy(this.map.width, this.map.height);
      this.rebuildOccupancy();
    } else {
      const genRng = new Random(config.seed);
      this.map = generateMap(config.mapW, config.mapH, genRng);
      this.rng = new Random((config.seed ^ SIM_SEED_OFFSET) >>> 0);
      this.world = new World();
      this.occ = new Occupancy(this.map.width, this.map.height);
      this.setupMatch(config);
    }

    // One fog + FogSystem per player present in the world (fresh or restored).
    const fogSystems: FogSystem[] = [];
    for (const [, p] of this.world.query(CPlayer)) {
      const fog = new Fog(this.map.width, this.map.height);
      this.fogs.set(p.id, fog);
      fogSystems.push(new FogSystem(fog, p.id));
    }

    // System order each tick: gather/build → combat → movement → projectiles →
    // death (reap 0-hp) → match (win/lose) → economy (pop + training) → fog
    // (vision) → ai (decides on fresh fog, enqueues for next tick).
    this.systems = [
      new GatherSystem(this.map, this.occ),
      new BuildSystem(this.map, this.occ, this.events),
      new CombatSystem(this.map, this.occ, this.events),
      new TowerSystem(this.events), // building-attackers fire after units; arrows fly this tick
      new MovementSystem(this.map, this.occ),
      new ProjectileSystem(),
      // Research before Death so a tech completing on the same tick its building
      // is destroyed still applies (Death reaps the building + its components).
      new ResearchSystem(), // advance tech + apply upgrades/age
      new DeathSystem(this.occ, this.events),
      new MatchSystem(),
      new EconomySystem(this.map, this.occ, this.events),
      ...fogSystems,
      new AiSystem(this.map, this.occ, this.commands, this.rng, (owner) => this.fogs.get(owner)),
    ];

    // Populate fog once now so the first rendered frame (which runs before the
    // first fixed tick) isn't a black flash over our own town.
    for (const fs of fogSystems) fs.update(this.world, 0);
  }

  /** The human player's fog (always present). */
  get fog(): Fog {
    const f = this.fogs.get(PLAYER_ID);
    if (f === undefined) throw new Error("Game: human fog missing");
    return f;
  }

  /** A given player's fog, or undefined. */
  fogFor(owner: number): Fog | undefined {
    return this.fogs.get(owner);
  }

  /** Rebuild the occupancy grid from the world's building footprints. */
  private rebuildOccupancy(): void {
    this.occ.clear();
    for (const [, b] of this.world.query(CBuilding)) {
      this.occ.setRect(b.tx, b.ty, b.w, b.h, true);
    }
  }

  /** Block (or clear) a building's footprint — call when placing/removing one. */
  setBuildingOccupancy(b: Building, blocked: boolean): void {
    this.occ.setRect(b.tx, b.ty, b.w, b.h, blocked);
  }

  // --- initial match setup (fresh game only) -------------------------------

  private setupMatch(config: MatchConfig): void {
    const map = this.map;

    // Turn resource terrain into harvestable nodes across the whole map.
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const t = map.get(tx, ty);
        const kind: ResourceKind | null =
          t === "forest" ? "wood" : t === "gold" ? "gold" : t === "stone" ? "stone" : null;
        if (kind !== null) spawnResourceNode(this.world, kind, tx, ty);
      }
    }

    // Human and AI start on a diagonal (opposite quadrants), away from edges.
    spawnPlayer(this.world, PLAYER_ID, config.startResources, { isAI: false });
    this.setupBase(PLAYER_ID, Math.round(map.width * 0.3), Math.round(map.height * 0.3));

    const aiEntity = spawnPlayer(this.world, AI_ID, config.startResources, {
      isAI: true,
      difficulty: config.difficulty,
    });
    this.world.add(aiEntity, CAiMemory, {
      owner: AI_ID,
      ticks: 0,
      stage: "boot",
      attacking: false,
      rallyTx: -1,
      rallyTy: -1,
    });
    this.setupBase(AI_ID, Math.round(map.width * 0.7), Math.round(map.height * 0.7));

    // Singleton match-state (decided by MatchSystem).
    const m = this.world.createEntity();
    this.world.add(m, CMatch, { over: false, winner: null });
  }

  /** Lay down one player's starting base: Town Center, two houses, guaranteed
   *  wood/food nearby, and three villagers around the Town Center. */
  private setupBase(owner: number, cx: number, cy: number): void {
    const tcDef = BUILDING_DEFS.town_center;
    const tc = this.findClearArea(cx, cy, tcDef.w, tcDef.h) ?? { tx: cx, ty: cy };
    spawnBuilding(this.world, "town_center", owner, tc.tx, tc.ty);
    this.occ.setRect(tc.tx, tc.ty, tcDef.w, tcDef.h, true);

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
        spawnBuilding(this.world, "house", owner, hx, hy);
        this.occ.setRect(hx, hy, 2, 2, true);
        houses++;
      }
    }

    // Guarantee a starting wood grove and food bushes near the Town Center.
    this.scatterNodes(tc.tx - 6, tc.ty - 1, "wood", 10, true);
    this.scatterNodes(tc.tx + 2, tc.ty + 6, "food", 6, false);

    // Three starting villagers on standable tiles ringing the Town Center.
    const spots = this.tilesAround(tc.tx, tc.ty, 3, 3, 3);
    for (const s of spots) spawnUnit(this.world, "villager", s.tx, s.ty, owner);
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

  /** Run one fixed simulation tick: drain queued commands, then every system. */
  fixedUpdate(dt: number): void {
    for (const cmd of this.commands.drain()) {
      executeCommand(this.world, this.map, this.occ, cmd);
    }
    for (const system of this.systems) {
      system.update(this.world, dt);
    }
    this.tick++;
  }

  serialize(): GameSnapshot {
    return {
      version: SAVE_VERSION,
      seed: this.seed,
      tick: this.tick,
      rng: this.rng.save(),
      world: this.world.serialize(),
      map: {
        width: this.map.width,
        height: this.map.height,
        tiles: [...this.map.data],
      },
      commands: this.commands.serialize(),
    };
  }

  static deserialize(snap: GameSnapshot): Game {
    if (snap === null || typeof snap !== "object" || snap.version !== SAVE_VERSION) {
      throw new Error(`Incompatible save (version ${snap?.version}, expected ${SAVE_VERSION})`);
    }
    const game = new Game(
      {
        seed: snap.seed,
        mapW: snap.map.width,
        mapH: snap.map.height,
        difficulty: "medium",
        startResources: { food: 0, wood: 0, gold: 0, stone: 0 },
      },
      {
        rng: Random.restore(snap.rng),
        map: new GameMap(snap.map.width, snap.map.height, [...snap.map.tiles]),
        world: World.deserialize(snap.world),
        tick: snap.tick,
      },
    );
    game.commands.restore(snap.commands);
    return game;
  }

  /** World-space point at the centre of the map (camera fallback). */
  centerWorld(): Vec2 {
    return gridToWorld(this.map.width / 2, this.map.height / 2);
  }

  /** World point of a player's Town Center (for centring the camera), or map centre. */
  playerCenterWorld(owner: number): Vec2 {
    for (const [e, b] of this.world.query(CBuilding)) {
      if (b.owner === owner && b.kind === "town_center") {
        const tr = this.world.get(e, CTransform);
        if (tr !== undefined) return { x: tr.x, y: tr.y };
      }
    }
    return this.centerWorld();
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
