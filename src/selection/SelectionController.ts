import type { Entity } from "@/ecs/types";
import type { World } from "@/ecs/World";
import type { Camera } from "@/render/Camera";
import type { Input } from "@/input/Input";
import { CUnit, CTransform, PLAYER_ID, type Transform, type Unit } from "@/game/components";

/**
 * Normalized marquee rectangle in screen-space CSS pixels (x0<=x1, y0<=y1),
 * for the renderer to draw the selection box. Screen-space because the marquee
 * is a fixed-size overlay on the viewport, not a world object.
 */
export interface DragBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Squared screen-pixel distance past which a press is treated as a box drag. */
const DRAG_THRESHOLD_PX = 6;
const DRAG_THRESHOLD_SQ = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;

/** Max gap (ms) between two clicks for the second to count as a double-click. */
const DOUBLE_CLICK_MS = 300;
/** Max screen-pixel travel between two clicks for them to count as a double. */
const DOUBLE_CLICK_PX = 6;
const DOUBLE_CLICK_SQ = DOUBLE_CLICK_PX * DOUBLE_CLICK_PX;

/**
 * Owns the player's current unit selection — pure VIEW state, deliberately NOT
 * stored in the ECS world (it isn't part of the simulation and is never saved).
 * Handles LEFT mouse only: single-click, shift-click toggle, drag-box marquee,
 * and double-click "select all of kind". Right-click move orders live elsewhere.
 *
 * Call `update` once per rendered frame, after `Input` has been polled but
 * before `Input.endFrame()`.
 */
export class SelectionController {
  /** Currently selected entities (owner 0 only). The renderer reads this. */
  readonly selected = new Set<Entity>();

  /** Screen-space pos of the active left-press, or null when no press is live. */
  private pressX = 0;
  private pressY = 0;
  private pressActive = false;
  /** Once true for the current press, it's a box drag (sticky until release). */
  private boxDragging = false;
  /** Live cursor pos, captured each frame so getDragBox() reflects "now". */
  private currentX = 0;
  private currentY = 0;

  /** Timestamp + screen pos of the previous click, for double-click detection. */
  private lastClickTime = Number.NEGATIVE_INFINITY;
  private lastClickX = 0;
  private lastClickY = 0;

  update(input: Input, camera: Camera, world: World): void {
    // Prune dead entities every frame: a unit can be destroyed by the sim
    // between frames, and stale ids would otherwise leak into hit-tests/render.
    for (const e of this.selected) {
      if (!world.isAlive(e)) this.selected.delete(e);
    }

    // Track the live cursor so getDragBox() can report the marquee this frame.
    this.currentX = input.mouseX;
    this.currentY = input.mouseY;

    const shift = input.isKeyDown("ShiftLeft") || input.isKeyDown("ShiftRight");

    // Press: latch the drag-start so we can later distinguish click vs box.
    if (input.wasButtonPressed(0)) {
      this.pressActive = true;
      this.boxDragging = false;
      this.pressX = input.mouseX;
      this.pressY = input.mouseY;
    }

    // Promote a held press to a box drag once the cursor has moved far enough.
    // Sticky: a wobble back under the threshold stays a box drag, matching the
    // intuition that once you start a marquee you're committed to it.
    if (this.pressActive && input.isButtonDown(0) && !this.boxDragging) {
      const dx = input.mouseX - this.pressX;
      const dy = input.mouseY - this.pressY;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_SQ) this.boxDragging = true;
    }

    if (input.wasButtonReleased(0) && this.pressActive) {
      if (this.boxDragging) {
        this.applyBoxSelection(input, camera, world, shift);
      } else {
        this.applyClick(input, camera, world, shift);
      }
      // Reset drag state for the next gesture.
      this.pressActive = false;
      this.boxDragging = false;
    } else if (this.pressActive && !input.isButtonDown(0)) {
      // Button went up without a release event (e.g. the window lost focus
      // mid-drag — blur clears buttons but fires no mouseup). Abort the gesture
      // so the marquee clears, without committing a selection.
      this.pressActive = false;
      this.boxDragging = false;
    }
  }

  /** Clear the whole selection. A hook for the future load/reset path. */
  clear(): void {
    this.selected.clear();
  }

  /**
   * Current marquee rect for rendering, normalized so x0<=x1 / y0<=y1; null
   * unless a box drag is in progress this frame.
   */
  getDragBox(): DragBox | null {
    if (!this.boxDragging || !this.pressActive) return null;
    return {
      x0: Math.min(this.pressX, this.currentX),
      y0: Math.min(this.pressY, this.currentY),
      x1: Math.max(this.pressX, this.currentX),
      y1: Math.max(this.pressY, this.currentY),
    };
  }

  /**
   * Select all player units whose SCREEN position falls inside the marquee.
   * shift => add to the current selection; otherwise => replace it.
   */
  private applyBoxSelection(input: Input, camera: Camera, world: World, shift: boolean): void {
    const x0 = Math.min(this.pressX, input.mouseX);
    const y0 = Math.min(this.pressY, input.mouseY);
    const x1 = Math.max(this.pressX, input.mouseX);
    const y1 = Math.max(this.pressY, input.mouseY);

    if (!shift) this.selected.clear();

    for (const [e, unit] of world.query(CUnit)) {
      if (unit.owner !== PLAYER_ID) continue;
      const tr = world.get(e, CTransform);
      if (tr === undefined) continue; // a unit without a Transform isn't placeable
      const { sx, sy } = camera.worldToScreen(tr.x, tr.y);
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) this.selected.add(e);
    }

    // An intervening drag must break any double-click chain, so a click after
    // the box isn't mistaken for a double of the click before it.
    this.lastClickTime = Number.NEGATIVE_INFINITY;
  }

  /**
   * A click (press+release with little movement). Hit-test the topmost player
   * unit under the cursor, then branch on double-click / shift / plain click.
   */
  private applyClick(input: Input, camera: Camera, world: World, shift: boolean): void {
    const hit = this.pickUnitAt(input.mouseX, input.mouseY, camera, world);

    // Double-click test: a second click soon after the first, near the same
    // screen point, that landed on a unit. Recorded BEFORE early-returns so the
    // timestamp/pos always advance for the next gesture.
    const now = performance.now();
    const ddx = input.mouseX - this.lastClickX;
    const ddy = input.mouseY - this.lastClickY;
    const isDoubleClick =
      hit !== null &&
      now - this.lastClickTime <= DOUBLE_CLICK_MS &&
      ddx * ddx + ddy * ddy <= DOUBLE_CLICK_SQ;
    this.lastClickTime = now;
    this.lastClickX = input.mouseX;
    this.lastClickY = input.mouseY;

    if (hit === null) {
      // Click on empty ground: plain click clears; shift-click leaves as-is.
      if (!shift) this.selected.clear();
      return;
    }

    if (isDoubleClick) {
      // Select every on-screen player unit of the same kind. shift => add.
      this.selectAllOfKindOnScreen(hit.unit.kind, camera, world, shift);
      return;
    }

    if (shift) {
      // Shift single-click toggles just this unit in/out of the selection.
      if (this.selected.has(hit.entity)) this.selected.delete(hit.entity);
      else this.selected.add(hit.entity);
    } else {
      // Plain single-click selects only this unit.
      this.selected.clear();
      this.selected.add(hit.entity);
    }
  }

  /**
   * Topmost player unit under a screen point, or null. The hit area is matched
   * to the drawn silhouette (a screen-space box spanning the unit's feet up
   * through its head), not the tiny world-space collision radius — otherwise
   * clicking the visible torso/head would miss and feel unresponsive. Sizes are
   * the drawUnits body proportions scaled by zoom. When several overlap we pick
   * the one drawn on top: greatest tr.y (units lower on the iso plane render in
   * front).
   */
  private pickUnitAt(
    cursorX: number,
    cursorY: number,
    camera: Camera,
    world: World,
  ): { entity: Entity; unit: Unit; tr: Transform } | null {
    let best: { entity: Entity; unit: Unit; tr: Transform } | null = null;

    for (const [e, unit] of world.query(CUnit)) {
      if (unit.owner !== PLAYER_ID) continue;
      const tr = world.get(e, CTransform);
      if (tr === undefined) continue;

      const { sx, sy } = camera.worldToScreen(tr.x, tr.y);
      const r = unit.radius * camera.zoom;
      // Silhouette box: full ring width, head-top down to the shadow.
      const halfW = r * 1.35;
      const top = sy - r * 2.2;
      const bottom = sy + r * 0.5;
      if (cursorX < sx - halfW || cursorX > sx + halfW || cursorY < top || cursorY > bottom) {
        continue;
      }
      // Tie-break toward the front-most (greatest tr.y) of the overlapping hits.
      if (best === null || tr.y > best.tr.y) best = { entity: e, unit, tr };
    }
    return best;
  }

  /**
   * Replace (or, with shift, extend) the selection with every on-screen player
   * unit sharing `kind`. "On-screen" = its screen position lies within the
   * viewport rect, so double-click never grabs units the player can't see.
   */
  private selectAllOfKindOnScreen(
    kind: Unit["kind"],
    camera: Camera,
    world: World,
    shift: boolean,
  ): void {
    if (!shift) this.selected.clear();

    for (const [e, unit] of world.query(CUnit)) {
      if (unit.owner !== PLAYER_ID || unit.kind !== kind) continue;
      const tr = world.get(e, CTransform);
      if (tr === undefined) continue;
      const { sx, sy } = camera.worldToScreen(tr.x, tr.y);
      if (sx >= 0 && sx <= camera.viewW && sy >= 0 && sy <= camera.viewH) {
        this.selected.add(e);
      }
    }
  }
}
