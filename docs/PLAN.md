# Plan & status

The single living reference: design principles, how we work, architecture
invariants, the phase roadmap **with current status**, the deferred backlog, and
the next phase's task list. The original brief is in [`PROMPT.md`](PROMPT.md).
**Update this file at the end of every phase**, commit, and push. It is written
to be self-sufficient so work resumes cleanly in a fresh context.

Last updated: end of **Phase 4**.

## Status

| Phase | Title | Status | Commit |
| --- | --- | --- | --- |
| 0 | Skeleton | ✅ | `96c4544` |
| 1 | Units & movement | ✅ | `53f665d` |
| 2 | Economy | ✅ | `6b29895` |
| 3 | Buildings & construction | ✅ | `9b3ba20` |
| 4 | Combat | ✅ | `af42910` |
| 5 | Enemy AI + match flow | ⬜ **Next** | — |
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

### Phase 4 — Combat ✅ (`af42910`)
Archer + Archery Range. `Combat` + `Projectile` components (every unit has Combat).
`CombatSystem` (validate/auto-acquire/chase/attack, melee + ranged, attack-move).
`ProjectileSystem` (homing arrows + impact). `DeathSystem` (reaps 0-hp after the
tick; frees occupancy). Damage = `max(1, attack − armor/pierce)` + `DAMAGE_BONUS`
counters. Per-player `Fog` + `FogSystem` (visible/explored, derived); renderer fog-
gates enemies + `drawFog` veil. Orders: right-click attack (fog-gated), `F` attack-
move; manual orders cancel combat. Debug enemy squad + console spawn hooks. Built
by parallel subagents (render agent's connection dropped — finished by hand).
Review: 5 findings; major = melee couldn't reach a building's attack range (now
measured to the nearest footprint tile).

### Phase 5 — Enemy AI + match flow
Rule-based AI (build-order state machine) that economies up + attacks; difficulty;
win/lose (all buildings destroyed); match-setup screen.

### Phase 6 — Depth
Tech tree + ages; more units/buildings/upgrades; minimap; control groups (Ctrl+1–9);
save/load UI; audio (CC0); balance pass.

## Deferred backlog (carry-over)

- **[Phase 5]** **Win/lose + match setup** (player defeated when all buildings
  destroyed). **Replace the debug enemy squad / console spawn hooks** with a real
  owner-1 player + AI. **Owner-gate `CombatSystem` & `BuildSystem`** stances (e.g. a
  move-only stance vs the current aggressive default) once a second player exists.
  Route player UI commands through a per-tick command buffer so all sim writes land
  on the deterministic tick (needed for AI/replay).
- **[Phase 4+]** Cancel/refund a placed foundation + building destruction UX (combat
  already destroys buildings + frees occupancy; no player-driven demolish/refund).
- **[render]** Per-row building depth banding (single front-tile-centre key can mis-
  sort a unit at a 3×3's far front tile); enemy-building fog gate uses one centre tile
  rather than the whole footprint (cosmetic, sight ≫ footprint so near-unreachable).
- **[Phase 6]** Projectiles snapshot `attack` only and resolve armor/counters vs the
  defender's live stats at impact — revisit if mutable/tech-modified armor lands.
- **[perf]** A* scratch-array pooling; spatial-grid separation (both fine until crowds
  grow). **[feel]** true formation movement (vs current distinct-tile spread).

## Next up — Phase 5: Enemy AI + match flow

Goal: **a full, beatable match.** Refine at start.

- [ ] **Second player + match setup.** Replace the debug enemy squad with a real
      owner-1 player (its own `Player` entity, Town Center, starting villagers). A
      match-setup screen (map size, AI difficulty, starting resources) before the game.
- [ ] **Rule-based AI (build-order state machine).** Per AI player: gather → build
      houses/military buildings → train an army → attack the human. Difficulty tiers
      tune timings/army size. Deterministic — draws from the sim RNG, runs in a system
      (or per-tick), no `Math.random`. Reuse the existing order helpers (gather/build/
      train/attack-move) rather than poking components directly where possible.
- [ ] **Per-tick command buffer (foundation).** Route both player and AI intents
      through a buffer consumed inside `fixedUpdate`, so every sim write is on the tick
      (clears the deferred determinism item, enables replay later).
- [ ] **Win/lose.** A player is defeated when all their buildings are destroyed; show a
      victory/defeat overlay; end/restart flow.
- [ ] **Fog/AI interaction.** The AI should act on its own visibility (or omniscient at
      first, scouting later). Keep fog per-player (currently only the human's is built).
- [ ] **Stances** (optional): a move-only vs aggressive toggle now that a real enemy
      exists, so move orders don't always auto-divert.
- [ ] **Save/load** round-trips; review → fix → verify in browser → update README +
      this file → commit → push → stop.
