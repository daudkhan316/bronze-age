# Progress

Living status ledger. **Update this at the end of every phase** (and whenever the
backlog changes), commit it, and push. A fresh session should be able to read this
file + `PLAN.md` and continue with no other context.

Last updated: end of **Phase 3**.

## Phase status

| Phase | Title | Status | Commit |
| --- | --- | --- | --- |
| 0 | Skeleton | ✅ Done | `96c4544` |
| 1 | Units & movement | ✅ Done | `53f665d` |
| 2 | Economy | ✅ Done | `6b29895` |
| 3 | Buildings & construction | ✅ Done | `9b3ba20` |
| 4 | Combat | ⬜ **Next** | — |
| 5 | Enemy AI + match flow | ⬜ Todo | — |
| 6 | Depth (tech/ages/minimap/audio/save UI) | ⬜ Todo | — |

## Completed phases — what shipped

### Phase 0 — Skeleton (`96c4544`)
Vite + TS (full strict), fixed-timestep loop (accumulator + interpolation alpha),
ECS core (`World`/`System`/`defineComponent`), seeded `Random`, isometric
projection + renderer with viewport culling + HiDPI, camera (pan/edge-scroll/
middle-drag/wheel-zoom/bounds-clamp), terrain map + deterministic generator,
JSON save/load of the world. Review: 12 findings, all fixed.

### Phase 1 — Units & movement (`53f665d`)
Components (Transform/Movement/Unit). A* (8-connected, octile heuristic, no
corner-cutting, binary heap, blocked-goal retarget). MovementSystem (waypoint
follow + local separation + stuck-detection). SelectionController (view-state:
click / shift-toggle / drag-box / double-click-type; silhouette hit-test).
Unit + selection-ring rendering. Group move orders spread across distinct tiles.
Built by 4 parallel subagents. Review: 9 findings; major fix = separation could
strand a unit on unwalkable terrain.

### Phase 2 — Economy (`6b29895`)
Resource nodes (food/wood/gold/stone; deplete + reopen terrain). GatherSystem
(toNode → gathering → toDrop → depositing). Player economy entity (resources +
population). EconomySystem (pop recount + Town Center training). Occupancy grid
(buildings block tiles; occupancy-aware `canStand`; rebuilt on load). Pre-placed
Town Center + 2 houses + 3 villagers. Resource HUD + train button/`Q`. Building +
resource sprites. Built by 3 parallel subagents. Review: 6 findings; majors fixed
= gather soft-lock on unreachable nodes, and train over-queue burning food past cap.

### Phase 3 — Buildings & construction (`9b3ba20`)
Data-driven `BUILDING_DEFS` (Town Center, House, Barracks, Lumber/Mining Camp,
Mill) + `UNIT_STATS` (villager, spearman; combat stats ready for Phase 4).
Construction: `Building.complete` + `Construction` + a villager `Build` task;
`BuildSystem` walks builders in and pours build points → promotes the building
(incomplete ones give no pop / don't train / aren't drop-offs). `PlacementController`
(pure view) ghost + validity; `main` commits (pay + spawn foundation + occupancy).
Building single-select + a context command panel (build menu / train) replacing the
global hotkey. Generalized drop-offs (camps/mill) and training (any complete
trainable building). Unified depth-sorted `drawWorld` (the carried-over fix) +
`drawPlacement` ghost; old per-type draw modules deleted. Built by 3 parallel
subagents. Review: 7 findings; major fix = building depth-key occluded units in
front of buildings (now keyed by front-tile centre).

## Carried-over / deferred backlog

Track these so they're not lost. Each notes the phase it should land in.

- **[later, render] Per-row building depth banding.** The unified depth sort keys a
  building by its front-tile centre — correct for the common cases, but a single
  scalar can't perfectly order against a multi-tile diamond footprint (a unit at the
  far-west front tile of a 3×3 can still mis-sort). Split a building into per-row
  depth slices if it becomes noticeable.
- **[Phase 4+] Cancel/refund a placed foundation + building destruction.** No way to
  cancel after placing (cost is spent); destruction will need to clear the footprint
  via `Game.setBuildingOccupancy` (occupancy is owned by placement/Game, not BuildSystem).
- **[Phase 5] Owner-gate BuildSystem.** `BuildSystem` doesn't check unit/target
  ownership (only the single producer `assignBuild` filters to own villagers). Add a
  guard when AI/enemy players land so a stray `Build` can't help an enemy.
- **[Phase 5] Player commands via a per-tick command buffer.** `trainFromSelectedBuilding`
  (and other UI actions) mutate sim state from the render-rate frame callback.
  Fine for single-player today, but route intents through a command buffer consumed
  inside `fixedUpdate` before AI/replay/networking land, so all sim writes stay on
  the deterministic tick.
- **[later, perf] A* scratch-array pooling.** `findPath` allocates four full-map
  typed arrays per call. Negligible at 64×64; pool them when maps/armies grow.
- **[later, perf] Spatial grid for separation.** MovementSystem separation is
  O(n²); replace with a uniform-grid hash once crowds grow.
- **[later, feel] True formation movement.** Group moves currently spread onto
  distinct tiles; replace with real formations if it matters.

## Known limitations (current build)

- Enemy units from Phase 1 were removed in Phase 2; no opponent until Phase 5.
- No fog of war yet (Phase 4).
- No combat yet — the spearman exists and moves but can't fight until Phase 4.
- No cancel-after-place: placing a foundation spends the cost with no refund.

## Next up — Phase 4: Combat

Goal: **two armies can fight.** Suggested task breakdown (refine at start):

- [ ] **Combat components & stats.** Use the existing `UNIT_STATS` combat fields
      (attack / armor / pierceArmor / range / attackCooldown / hp). Add a `Combat`
      component (target, cooldown) and an `Attackable` notion for units + buildings
      (buildings already have hp/maxHp). Add a ranged unit (archer) trained at an
      Archery Range building.
- [ ] **CombatSystem.** Acquire targets in range, melee + ranged attacks on cooldown,
      damage = max(1, attack − armor) (pierce-armor for ranged); death removes the
      entity (and frees occupancy for buildings). Deterministic, fixed-tick.
- [ ] **Projectiles.** Ranged attacks spawn a projectile entity that travels and
      applies damage on arrival (interpolated render); arrow/spear sprite.
- [ ] **Orders: attack & attack-move.** Right-click an enemy = attack it; an
      attack-move order walks toward a point but engages enemies en route. Units
      auto-retaliate when idle and attacked.
- [ ] **Unit counters (rock-paper-scissors).** Bonus-damage table (e.g. spearman vs
      cavalry) wired through the damage calc.
- [ ] **Fog of war + explored memory.** Per-player visibility grid from unit/building
      line-of-sight; unexplored = black, explored-but-not-visible = dimmed with last-
      seen buildings. This is sim-adjacent (deterministic) but rendered in the view.
- [ ] **Death + feedback.** Death animation/fade, HP bars already exist; selection
      cleanup on death already handled by SelectionController pruning.
- [ ] **Save/load** still round-trips (new components JSON-plain); review → fix →
      verify in browser → update README + this file → commit → push → stop.

> Note: a second player (owner 1) and AI come in Phase 5, but Phase 4 can spawn a
> few enemy (owner-1) units via a debug hook to test fighting two-sided.

## How to update this file

At the end of a phase: flip its row to ✅ with the commit SHA, add a "what shipped"
entry, move newly-deferred items into the backlog, refresh "Known limitations", and
write the next phase's task list under "Next up". Then commit (`docs: update
progress for Phase N`) and push.
