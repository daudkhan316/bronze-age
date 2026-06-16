# Bronze Age — project guide for Claude Code

Browser RTS inspired by **Age of Empires II**. TypeScript (strict) + Vite + HTML5
Canvas 2D, a small custom ECS, and a fixed-timestep deterministic simulation. No
game engine, no backend. Built in **phases (0–6)**, one at a time.

> **Read first, every session:** [`docs/PROGRESS.md`](docs/PROGRESS.md) (what's
> done + the next tasks) and [`docs/PLAN.md`](docs/PLAN.md) (phase scope + how we
> work). [`docs/PROMPT.md`](docs/PROMPT.md) is the original brief. These are
> written to be self-sufficient so work resumes cleanly in a fresh context.

## Commands

- `npm install` — once.
- `npm run dev` — Vite dev server at http://localhost:5173.
- `npm run typecheck` — `tsc --noEmit` (full strict; must be clean before commit).
- `npm run build` — typecheck + production bundle.

## Architecture invariants (do not break)

- **Sim vs view split.** The deterministic simulation is the ECS world —
  `src/game/Game.ts` owns the world + map + occupancy + systems + tick + sim RNG.
  The view layer (camera, selection, input, HUD, rendering) lives OUTSIDE the sim
  and never mutates it. Only sim state is serialized for save/load.
- **Fixed 20Hz simulation, decoupled render.** Loop in `src/core/Loop.ts`;
  systems run in `Game.fixedUpdate(dt)`. Rendering runs at requestAnimationFrame
  rate and only reads sim state.
- **Determinism.** No `Math.random` / `Date.now` / `performance.now` in sim code —
  draw from the seeded `Random` (`game.rng`). View code may use them freely.
- **Components are plain JSON-safe data** (no Map/Set/NaN/Infinity). The whole
  world round-trips via `World.serialize()`/`deserialize()`. Define components with
  `defineComponent<T>(name)` in `src/game/components.ts`.
- **Systems implement `System`** (`update(world, dt)`) and hold no state of their
  own; the world is the single source of truth.
- **Strict TS everywhere:** strict + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` + `noUnusedLocals/Parameters` + `noImplicitReturns`.
  Zero `any`. Guard every array/Map index for `undefined`.
- **Pathfinding & movement consult terrain AND occupancy** via
  `canStand(map, tx, ty, occ)`. Building footprints block tiles via
  `src/map/Occupancy.ts` (derived state, rebuilt from buildings on load).

## How we work (the method that keeps context manageable)

- **One phase at a time. Stop after each phase, show the user, wait for review.**
  Each phase is independently playable and committed.
- **Subagent orchestration** — this is how we avoid blowing the context window:
  the lead owns the shared contracts + integration and fans the heavy, independent
  modules out to parallel subagents (the `Workflow` tool) against fixed interface
  contracts. The subagents' work stays in their contexts; only summaries return.
- **Adversarial review before every commit:** run a multi-agent review workflow
  over the phase's code; each finding is independently verified by a skeptic; fix
  the real ones; re-verify; then commit.
- **Verify in a real browser** (Playwright): drive the actual UI and assert on
  `game.serialize()` state — not just that it typechecks.
- **Commit per phase**, message ending with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  trailer. Then update `docs/PROGRESS.md`, commit that, and push.
- Flag any divergence from Age of Empires and explain why.
- Assets must be CC0 / original — track every source in `ASSETS.md`.

## Per-phase loop (operational checklist)

1. Read `docs/PROGRESS.md` → confirm the current phase and its task list.
2. Design the data model / contracts yourself; get them compiling green.
3. Fan independent modules out to subagents against those contracts.
4. Integrate; `npm run typecheck` + `npm run build` green.
5. Verify in-browser (spawn, drive, assert on serialized state).
6. Run the adversarial review workflow; fix confirmed findings; re-verify.
7. Update README controls + `docs/PROGRESS.md`; commit; push; **stop for review.**

## Current status

Phases **0, 1, 2, 3 complete**. **Next: Phase 4 — Combat.**
See `docs/PROGRESS.md` for the Phase 4 task breakdown and carried-over backlog.
