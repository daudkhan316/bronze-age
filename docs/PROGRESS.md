# Progress

Living status ledger. **Update this at the end of every phase** (and whenever the
backlog changes), commit it, and push. A fresh session should be able to read this
file + `PLAN.md` and continue with no other context.

Last updated: end of **Phase 2**.

## Phase status

| Phase | Title | Status | Commit |
| --- | --- | --- | --- |
| 0 | Skeleton | ✅ Done | `96c4544` |
| 1 | Units & movement | ✅ Done | `53f665d` |
| 2 | Economy | ✅ Done | `6b29895` |
| 3 | Buildings & construction | ⬜ **Next** | — |
| 4 | Combat | ⬜ Todo | — |
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

## Carried-over / deferred backlog

Track these so they're not lost. Each notes the phase it should land in.

- **[Phase 3] Building construction.** Phase 2 pre-places the Town Center + houses;
  Phase 3 adds placement preview + validity check + villager-built foundations.
- **[Phase 3] Building selection + command panel.** Buildings aren't selectable
  yet; training uses a global `Q`/button. Make buildings selectable and move
  train/build actions to a per-building panel.
- **[Phase 3] Cross-type isometric depth-sort.** Resources / buildings / units are
  drawn in separate passes (units self-sort), so a unit behind a building can draw
  in front of it. Fold all world drawables into one depth-keyed draw list. Cosmetic
  today; do it alongside dynamic building rendering.
- **[Phase 5] Player commands via a per-tick command buffer.** `trainVillager`
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
- A unit walking behind a building may briefly draw on top of it (see depth-sort).

## Next up — Phase 3: Buildings & construction

Goal: **build a base and an army.** Suggested task breakdown (refine at start):

- [ ] **Building catalog & costs.** Define placeable building types (House,
      Barracks, Lumber Camp, Mining Camp, Mill, plus existing Town Center) with
      footprints, costs, pop/drop-off roles, and build time. Extend `components.ts`.
- [ ] **Placement mode (view layer).** Enter via a build menu / hotkey → ghost
      preview follows the cursor, snaps to tiles, validity check (clear footprint,
      buildable terrain, affordable). Left-click places a foundation (deduct cost,
      `refund on cancel`); Esc/right-click cancels.
- [ ] **Foundation + construction (sim).** A placed building starts as a foundation
      with build progress; villagers assigned to it (right-click) walk over and add
      progress over time; on completion it becomes functional. Health/progress bar.
      A `BuildSystem` drives this. Dynamic occupancy updates on place/complete/cancel.
- [ ] **Drop-off buildings.** Lumber/Mining Camps + Mill act as nearer drop-off
      points (GatherSystem already finds the nearest drop-off — generalize beyond
      Town Center). Buildable houses raise pop cap dynamically.
- [ ] **Barracks → infantry.** Barracks trains an infantry unit type (e.g. militia/
      spearman) with stats fields ready for Phase 4 combat (the unit moves/exists
      now; actual fighting is Phase 4).
- [ ] **Building selection + panel.** Make buildings selectable; selected building
      shows a command panel (train / set rally / etc.), replacing the global `Q`.
- [ ] **Cross-type render depth-sort** (carried over) — unify world drawables.
- [ ] **Save/load** still round-trips with the new components; occupancy rebuilds.
- [ ] Review workflow → fix findings → verify in browser → README + this file →
      commit → push → stop for review.

## How to update this file

At the end of a phase: flip its row to ✅ with the commit SHA, add a "what shipped"
entry, move newly-deferred items into the backlog, refresh "Known limitations", and
write the next phase's task list under "Next up". Then commit (`docs: update
progress for Phase N`) and push.
