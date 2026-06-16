# Plan & status

The single living reference: design principles, how we work, architecture
invariants, the phase roadmap **with current status**, the deferred backlog, and
the next phase's task list. The original brief is in [`PROMPT.md`](PROMPT.md).
**Update this file at the end of every phase**, commit, and push. It is written
to be self-sufficient so work resumes cleanly in a fresh context.

Last updated: end of **Phase 3**.

## Status

| Phase | Title | Status | Commit |
| --- | --- | --- | --- |
| 0 | Skeleton | ✅ | `96c4544` |
| 1 | Units & movement | ✅ | `53f665d` |
| 2 | Economy | ✅ | `6b29895` |
| 3 | Buildings & construction | ✅ | `9b3ba20` |
| 4 | Combat | ⬜ **in progress** | — |
| 5 | Enemy AI + match flow | ⬜ | — |
| 6 | Depth (tech/ages/minimap/audio/save UI) | ⬜ | — |

## Commands

`npm run dev` (http://localhost:5173) · `npm run typecheck` (tsc, full strict;
must be clean) · `npm run build` (typecheck + bundle).

## Design principles

1. **Deterministic 20Hz simulation, decoupled from rendering.** Fixed tick loop
   advances the ECS world; rendering runs at display rate and only reads sim state.
2. **Sim vs view is a hard boundary.** Sim = the ECS world (`Game.ts` owns world +
   map + occupancy + systems + tick + seeded RNG). View = camera, selection,
   placement, input, HUD, rendering — never serialized, never authoritative.
3. **Plain, JSON-safe serializable state.** Components are data objects (no Map/Set/
   NaN/Infinity); the whole world round-trips via `World.serialize()`. No
   `Math.random`/`Date.now` in sim code — only the seeded `Random` (`game.rng`).
4. **Pragmatic ECS.** Per-type component stores, stateless systems (`update(world,dt)`).
5. **Strict typing as a safety net** (strict + noUncheckedIndexedAccess +
   exactOptionalPropertyTypes + noUnused* + noImplicitReturns; zero `any`).
6. **CC0 / original assets only**, credited in `ASSETS.md`.
7. **Diverge from AoE when right — and say so** (recorded in README + here).

## How we work (the method — also what keeps the context window manageable)

- **One phase at a time.** Each phase is independently playable and committed.
  **Stop after each phase, show the user, wait for review** before the next.
- **Lead owns the seams; subagents do the volume.** The lead designs the data model
  + shared contracts (component shapes, signatures, file layout) and gets them
  compiling; independent algorithm-heavy modules fan out to **parallel subagents**
  (the `Workflow` tool) against those contracts; the lead integrates. Subagent work
  stays in their contexts — only summaries return.
- **Adversarial review before every commit:** a multi-agent review workflow over the
  phase's code; each finding independently verified; fix the real ones; re-verify.
- **Verify in a real browser** (Playwright): drive the UI and assert on
  `game.serialize()` — prove behaviour, don't just trust types.
- **Commit per phase** (message ends with the `Co-Authored-By` trailer), update this
  file, push, then stop.

## Architecture invariants (do not break)

- The deterministic sim is the ECS world; the view layer lives outside and never
  mutates it. Only sim state serializes for save/load.
- Systems run in `Game.fixedUpdate(dt)`; rendering reads sim state at rAF rate.
- Components are plain JSON-safe data; define with `defineComponent<T>(name)` in
  `src/game/components.ts`. Systems hold no state.
- Pathfinding & movement consult terrain AND occupancy via `canStand(map,tx,ty,occ)`.
  Building footprints block tiles (`src/map/Occupancy.ts`, derived, rebuilt on load).
- Per-phase loop: read this file → design contracts (compile green) → fan modules to
  subagents → integrate (typecheck + build) → verify in browser → adversarial review
  → fix → update README + this file → commit → push → stop.

## Phase roadmap

### Phase 0 — Skeleton ✅ (`96c4544`)
Vite+TS strict, fixed-timestep loop, ECS core, seeded RNG, iso renderer + culling +
HiDPI, camera (pan/edge/middle-drag/wheel-zoom/clamp), terrain map + generator, JSON
save/load. Review: 12 findings fixed.

### Phase 1 — Units & movement ✅ (`53f665d`)
Transform/Movement/Unit. A* (8-connected, octile, no corner-cutting, binary heap,
blocked-goal retarget). MovementSystem (waypoint follow + separation + stuck-detect).
SelectionController (click/shift/box/double-click-type, silhouette hit-test). Group
moves spread across tiles. Review: 9 findings; major = separation stranding fix.

### Phase 2 — Economy ✅ (`6b29895`)
Resource nodes (deplete + reopen terrain); GatherSystem (toNode→gathering→toDrop→
depositing); Player economy entity; EconomySystem (pop + training); Occupancy grid;
resource HUD. Review: 6 findings; majors = gather soft-lock, train over-queue.

### Phase 3 — Buildings & construction ✅ (`9b3ba20`)
Data-driven `BUILDING_DEFS` + `UNIT_STATS` (incl. spearman + combat stats). Building
`complete` + `Construction` + villager `Build` task; `BuildSystem`. `PlacementController`
(pure view) ghost + validity; `main` commits. Building single-select + context command
panel. Generalized drop-offs + training. Unified depth-sorted `drawWorld` + placement
ghost. Review: 7 findings; major = building depth-key occluded units in front.

### Phase 4 — Combat (next; deliverable: two armies can fight)
HP/armor/pierce-armor/attack stats (already in `UNIT_STATS`); melee + ranged; an
Archer + Archery Range; projectiles; attack & attack-move orders + auto-retaliate;
unit counters (bonus-damage table); death; fog of war + explored memory.

### Phase 5 — Enemy AI + match flow
Rule-based AI (build-order state machine) that economies up + attacks; difficulty;
win/lose (all buildings destroyed); match-setup screen.

### Phase 6 — Depth
Tech tree + ages; more units/buildings/upgrades; minimap; control groups (Ctrl+1–9);
save/load UI; audio (CC0); balance pass.

## Deferred backlog (carry-over)

- **[render]** Per-row building depth banding — the single front-tile-centre depth key
  can still mis-sort a unit at the far-west front tile of a 3×3; split into per-row
  slices if noticeable.
- **[Phase 4+]** Cancel/refund a placed foundation + building destruction (must clear
  the footprint via `Game.setBuildingOccupancy`; occupancy owned by placement/Game).
- **[Phase 5]** Owner-gate `BuildSystem` (only the producer `assignBuild` filters to
  own villagers today). Route player UI commands through a per-tick command buffer so
  all sim writes land on the deterministic tick (needed for AI/replay/networking).
- **[perf]** A* scratch-array pooling; spatial-grid separation (both fine until crowds
  grow). **[feel]** true formation movement (vs current distinct-tile spread).

## Next up — Phase 4 task breakdown

Goal: **two armies can fight.** Refine at start.

- [ ] **Combat data + components.** Use existing `UNIT_STATS` combat fields. Add an
      `Archer` unit + `Archery Range` building (data edits). Add a `Combat` component
      (target entity, attack cooldown timer) and a `Projectile` component
      (pos/target/damage/speed). Optionally an `AttackOrder`/`AttackMove` task.
- [ ] **CombatSystem (sim).** Acquire nearest enemy (unit or building) in aggro range;
      melee when adjacent, ranged when within `range`; attack on cooldown; damage =
      `max(1, attack − armor)` (melee) / `− pierceArmor` (ranged); apply a counter
      bonus table. Death = `destroyEntity` (free occupancy for buildings). Deterministic.
- [ ] **Projectiles.** Ranged attack spawns a projectile that travels and applies
      damage on arrival (interpolated render); arrow sprite.
- [ ] **Orders.** Right-click enemy = attack; attack-move walks to a point but engages
      en route; idle units auto-retaliate when hit. Wire into `main` right-click +
      hotkey; movement integrates with `CombatSystem`.
- [ ] **Fog of war + explored memory.** Per-player visibility grid (deterministic, sim
      state) from unit/building line-of-sight; render: unexplored = black,
      explored-but-not-visible = dimmed with last-seen buildings.
- [ ] **Two-sided test hook.** Spawn a few owner-1 enemy units (debug) so combat is
      testable before Phase 5's AI; HP bars already exist.
- [ ] **Save/load** round-trips the new components; review → fix → verify in browser →
      update README + this file → commit → push → stop.
