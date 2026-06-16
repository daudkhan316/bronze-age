import type { World } from "@/ecs/World";
import type { Camera } from "@/render/Camera";
import type { Input } from "@/input/Input";
import type { GameMap } from "@/map/GameMap";
import type { Occupancy } from "@/map/Occupancy";
import {
  BUILDING_DEFS,
  PLAYER_ID,
  type BuildingKind,
  type ResourceKind,
} from "@/game/components";
import { getPlayerState, resourceNodeAtTile } from "@/game/economy";
import { worldToTile } from "@/math/iso";
import { TERRAIN } from "@/map/Terrain";

/** The four gatherable resources, named so we can iterate a building's cost. */
const COST_KINDS: readonly ResourceKind[] = ["food", "wood", "gold", "stone"];

/**
 * The previewed placement of a building this frame: its footprint origin (tx,ty)
 * and size, plus whether dropping it there is legal. `reason` is a short human
 * label the HUD/renderer can show ("ok" when valid). Screen-agnostic — it's
 * expressed in tile coordinates so the renderer can project it however it likes.
 */
export interface PlacementGhost {
  kind: BuildingKind;
  tx: number;
  ty: number;
  w: number;
  h: number;
  valid: boolean;
  reason: string;
}

/**
 * Owns "build placement mode" — pure VIEW state, deliberately NOT part of the
 * ECS world or the fixed simulation. While active it tracks the cursor and each
 * frame recomputes where the pending building would land and whether that's a
 * legal spot (in-bounds + buildable terrain + unoccupied + no resource node, and
 * the player can afford it). It NEVER mutates the world: the integrator reads
 * `getGhost()`, and on a valid left-click commits the building itself; on
 * right-click / Esc it calls `cancel()`.
 *
 * Call `update` once per rendered frame, after `Input` has been polled.
 */
export class PlacementController {
  /** The kind being placed, or null when not in placement mode. */
  private kind: BuildingKind | null = null;
  /** The preview computed by the last `update`, or null when inactive. */
  private ghost: PlacementGhost | null = null;

  /** True while a building kind is pending placement. */
  isActive(): boolean {
    return this.kind !== null;
  }

  /** The kind currently being placed, or null when inactive. */
  pendingKind(): BuildingKind | null {
    return this.kind;
  }

  /** Enter placement mode for `kind`. The ghost appears on the next `update`. */
  begin(kind: BuildingKind): void {
    this.kind = kind;
    // Stale ghost cleared so getGhost() can't briefly report the old kind.
    this.ghost = null;
  }

  /** Leave placement mode (right-click / Esc / after a committed placement). */
  cancel(): void {
    this.kind = null;
    this.ghost = null;
  }

  /** The current preview, or null when inactive. */
  getGhost(): PlacementGhost | null {
    return this.ghost;
  }

  /**
   * Recompute the ghost for this frame. No-op (ghost = null) when inactive.
   * Reads only the cursor position + camera — never input buttons — so click
   * handling stays entirely with the integrator.
   */
  update(input: Input, camera: Camera, world: World, map: GameMap, occ: Occupancy): void {
    const kind = this.kind;
    if (kind === null) {
      this.ghost = null;
      return;
    }

    const def = BUILDING_DEFS[kind];

    // Centre the footprint on the cursor tile: origin = cursor − half the size.
    // (>>1 floors the half-extent, matching AoE's "centre on cursor" feel.)
    const { wx, wy } = camera.screenToWorld(input.mouseX, input.mouseY);
    const cursor = worldToTile(wx, wy);
    const tx = cursor.tx - (def.w >> 1);
    const ty = cursor.ty - (def.h >> 1);

    const reason = this.evaluate(kind, tx, ty, world, map, occ);
    this.ghost = {
      kind,
      tx,
      ty,
      w: def.w,
      h: def.h,
      valid: reason === "ok",
      reason,
    };
  }

  /**
   * Why the footprint at (tx,ty) is/ isn't a legal spot. Returns "ok" when
   * valid, else a short label. Terrain/occupancy is checked first (a bad spot is
   * the common case and reads more naturally than "can't afford" when the cursor
   * is off the map), then affordability.
   */
  private evaluate(
    kind: BuildingKind,
    tx: number,
    ty: number,
    world: World,
    map: GameMap,
    occ: Occupancy,
  ): string {
    const def = BUILDING_DEFS[kind];

    for (let y = ty; y < ty + def.h; y++) {
      for (let x = tx; x < tx + def.w; x++) {
        if (!map.inBounds(x, y)) return "off-map";
        const terrain = map.get(x, y);
        // get() can only be undefined off-map, already handled — guard for strict.
        if (terrain === undefined || !TERRAIN[terrain].buildable) return "blocked";
        if (occ.isBlocked(x, y)) return "blocked";
        if (resourceNodeAtTile(world, x, y) !== null) return "blocked";
      }
    }

    if (!this.canAfford(def.cost, world)) return "can't afford";

    return "ok";
  }

  /** True if the human player has at least the resources in `cost`. */
  private canAfford(cost: Partial<Record<ResourceKind, number>>, world: World): boolean {
    const ps = getPlayerState(world, PLAYER_ID);
    if (ps === undefined) return false; // no player economy ⇒ can't pay
    for (const k of COST_KINDS) {
      const need = cost[k] ?? 0;
      if (need > ps[k]) return false;
    }
    return true;
  }
}
