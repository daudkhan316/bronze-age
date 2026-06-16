# Plan

The stable reference: design principles, how we work, and the phase roadmap with
per-phase scope. The original brief is in [`PROMPT.md`](PROMPT.md); live status and
the next-up task list are in [`PROGRESS.md`](PROGRESS.md).

## Design principles

1. **Deterministic simulation, decoupled from rendering.** A fixed 20Hz tick loop
   advances the ECS world; rendering runs at the display's refresh rate and only
   reads sim state. This is what makes the game pauseable, save/load-able, and
   AI-inspectable.
2. **Sim vs view is a hard boundary.** The sim = the ECS world (units, buildings,
   resources, player economy, tick, seeded RNG). The view = camera, selection,
   input, HUD, rendering — never serialized, never authoritative. Anything that
   must survive save/load or replay lives in the sim.
3. **Plain, serializable state.** Components are JSON-safe data objects; the world
   serializes with no custom logic. No `Math.random`/`Date.now` in sim code — only
   the seeded `Random`.
4. **Pragmatic ECS, not dogmatic.** Per-type component stores, stateless systems.
   No archetype/bitset machinery until something demands it.
5. **Strict typing as a safety net.** Full strict TS + `noUncheckedIndexedAccess`
   + `exactOptionalPropertyTypes` + `noUnused*` + `noImplicitReturns`. The build
   fails on any type error.
6. **CC0 / original assets only**, credited in `ASSETS.md`.
7. **Diverge from AoE when it's the right call — and say so.** Divergences are
   recorded in the README and `PROGRESS.md`.

## How we work (the method)

This method is also what keeps the **context window manageable** across a large
project: the heavy lifting happens in subagent contexts, not the main thread.

- **One phase at a time.** Each phase is independently playable and committed.
  **Stop after each phase, show the user, wait for review** before starting the next.
- **Lead owns the seams; subagents do the volume.** For each phase the lead
  designs the data model + shared contracts (component shapes, function
  signatures, file layout) and gets them compiling. Then independent, algorithm-
  heavy modules are fanned out to **parallel subagents** (via the `Workflow` tool)
  against those fixed contracts. The lead integrates the results.
- **Adversarial review before commit.** A multi-agent review workflow inspects the
  phase's code across dimensions (correctness, determinism, forward-compat, …);
  every finding is independently verified by a skeptic before it's accepted; the
  lead fixes the confirmed ones and re-verifies.
- **Verify in a real browser.** Use Playwright to drive the actual UI and assert on
  `game.serialize()` — prove the behavior, don't just trust types.
- **Commit + document + push, then stop.** Update the README controls and
  `PROGRESS.md`; commit with the standard trailer; push; hand back to the user.

## Phase roadmap

Each phase lists its **deliverable** and the **scope** (what's in vs. explicitly
deferred). Status and detail for completed phases are in `PROGRESS.md`.

### Phase 0 — Skeleton ✅
Vite + TS project, fixed-timestep loop, ECS core, isometric grid renderer, camera
pan/zoom/edge-scroll, seeded RNG, serializable world. *Deliverable: scrollable map.*

### Phase 1 — Units & movement ✅
Villagers; selection (click / shift / drag-box / double-click-type); A* pathfinding
(8-connected, no corner-cutting); move orders with group spreading + stuck
detection; unit rendering + selection rings. *Deliverable: select and move units.*

### Phase 2 — Economy ✅
Four resources; resource nodes (deplete + reopen terrain); gather → carry → drop-off
state machine; player economy entity; Town Center training queue; houses → pop cap;
occupancy grid (buildings block tiles); resource HUD. *Deliverable: economy loop.*
Deferred to Phase 3: building **construction** (Phase 2 pre-places the TC + houses).

### Phase 3 — Buildings & construction (next)
Placement UI (ghost preview + validity check), foundations built over time by
villagers, dynamic occupancy, building selection + per-building command panel,
Barracks training infantry, dynamically-buildable houses/economy drop-offs.
**Also fold in the carried-over cross-type render depth-sort.**
*Deliverable: build a base and an army.* (See `PROGRESS.md` for the task list.)

### Phase 4 — Combat
HP / armor / pierce-armor / attack stats; melee + ranged; projectiles; attack-move;
death; unit counters; fog of war + explored memory. *Deliverable: armies fight.*

### Phase 5 — Enemy AI + match flow
Rule-based AI (build-order state machine) that economies up, expands, and attacks;
difficulty levels; win/lose (all buildings destroyed); match-setup screen.
*Deliverable: a full beatable match.* (Also: route player commands through a
per-tick command buffer so the sim stays deterministic for AI/replay — see backlog.)

### Phase 6 — Depth
Tech tree + ages; more units/buildings/upgrades; minimap; control groups (Ctrl+1–9);
save/load UI; audio (CC0 SFX + ambient); balance pass. *Deliverable: full game.*
