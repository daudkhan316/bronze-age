# Bronze Age

A browser-based real-time strategy game in the spirit of **Age of Empires II** — TypeScript + Vite + HTML5 Canvas 2D, no game engine. Built in phases; each phase is independently playable.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts:

```bash
npm run typecheck   # tsc --noEmit (full strict mode)
npm run build       # typecheck + production bundle into dist/
npm run preview     # serve the production build
```

Requires Node 18+ (developed on Node 20). A modern desktop browser (Chrome/Safari/Firefox). Best with a mouse — the camera uses wheel-zoom and edge-scroll.

---

## Current status — Phase 3: Buildings & construction ✅

Build a base and an army: place buildings (ghost preview + validity + cost), have
villagers construct them over time, then use completed buildings — houses raise
the population cap, the Barracks trains infantry — on top of the Phase 0–2
economy.

### Controls

| Input | Action |
| --- | --- |
| **Left-click** unit / building | Select unit, or single-select a building |
| **Left-drag** a box | Select all your units in the box |
| **Double-click** unit | Select all on-screen units of that type |
| **Shift** + click/drag | Add to / toggle current selection |
| Select a villager → **Build** menu | Pick a building to place |
| During placement: **left-click** | Place the foundation (Shift = place several) |
| During placement: **right-click** / `Esc` | Cancel placement |
| **Right-click** a foundation | Send selected villagers to construct it |
| **Right-click** a resource | Send selected villagers to gather it |
| **Right-click** ground | Move selected units there (A\* path) |
| Select a building → panel / `Q` | Train its unit (Town Center → villager, Barracks → spearman) |
| `W` `A` `S` `D` / Arrows / edge / middle-drag | Pan camera · wheel: zoom |
| `Space` pause · `G` grid · `Esc` clear selection | |

You start with **3 villagers**, a **Town Center** and **2 houses** (pop cap 15).
Gather wood, select a villager to open the **Build** menu, drop a **House**
foundation, right-click it to construct it (pop cap rises), then build a
**Barracks** and train spearmen. Lumber/Mining Camps and a Mill act as nearer
resource drop-offs.

> **Buildings:** Town Center (3×3, drop-off all, trains villagers), House (2×2,
> +5 pop), Barracks (3×3, trains spearman), Lumber/Mining Camp & Mill (2×2, nearer
> drop-offs). A foundation blocks its tiles immediately and is built up by any
> villagers assigned to it; multiple builders finish faster. Cost is refunded
> only by not building — there is no cancel-after-place yet.

---

## Architecture

Deliberate separation between the **deterministic simulation** and the **view**:

```
src/
  config.ts            All tuning constants (tick rate, tile size, zoom, pan…).
  core/
    Loop.ts            Fixed-timestep loop: 20Hz sim + uncapped render, accumulator + alpha.
    Random.ts          Seeded PRNG (mulberry32) — serializable state, deterministic.
  ecs/
    types.ts           Entity = number; typed component descriptors.
    World.ts           Entity lifecycle, component stores, queries, JSON (de)serialize.
    System.ts          System interface (advances the world one fixed tick).
  math/
    Vec2.ts            Plain 2D vector value + helpers.
    iso.ts             Grid <-> world iso projection, tile picking, tile centres.
  map/
    Terrain.ts         Terrain types + walkable/buildable/resource table.
    GameMap.ts         Flat row-major terrain grid with bounds-checked access.
    generate.ts        Deterministic placeholder map generator (seeded blobs).
    Occupancy.ts       Building-footprint blocked-tile grid (derived; rebuilt on load).
  pathfinding/
    astar.ts           8-connected A* (octile heuristic, no corner-cutting, binary heap).
    grid.ts            Walkability/standability (terrain + occupancy) + helpers.
  systems/
    MovementSystem.ts  Path-following + occupancy-aware separation; stuck-detection.
    GatherSystem.ts    Villager gather state machine (toNode/gathering/toDrop/depositing).
    BuildSystem.ts     Villager construction state machine (toSite/building → complete).
    EconomySystem.ts   Population recount + building training queues.
  selection/
    SelectionController.ts  VIEW-state selection: units (click/box/double-click) + 1 building.
  placement/
    PlacementController.ts  VIEW-state build placement: ghost tile + validity (no mutation).
  render/
    Camera.ts          VIEW state only: world<->screen transform, pan/zoom/clamp.
    Renderer.ts        Canvas 2D context, HiDPI scaling, frame orchestration + overlay hook.
    drawMap.ts         Viewport-culled iso tile drawing.
    drawWorld.ts       ONE depth-sorted pass: resources + buildings + units (+ rings, HP/build bars).
    drawPlacement.ts   The build placement ghost (green/red footprint).
    colors.ts          Terrain palette.
  input/
    Input.ts           Keyboard/mouse/wheel state, per-frame deltas, edge-scroll.
  game/
    components.ts      All components + unit/building data tables (plain, JSON-safe).
    spawn.ts           Factories: unit / resource node / building (foundation) / player.
    economy.ts         Domain helpers: player lookup, drop-off / node search.
    Game.ts            Owns world + map + occupancy + systems + tick; setup; save/load.
  main.ts              Bootstraps everything; wires loop, input, orders, placement, HUD/panel.
```

### Key design decisions (and where we diverge from AoE)

- **Camera is view state, not game state.** Pan/zoom update at render framerate (smooth) and never enter the ECS world or save games. Only deterministic sim state is serializable.
- **Fixed 20Hz simulation, decoupled render.** An accumulator drives discrete sim ticks; the render loop carries an interpolation `alpha` (unused in Phase 0, ready for smooth unit movement later). This is what makes the game pauseable, deterministic, and save/load-friendly.
- **Seeded PRNG everywhere in the sim.** No `Math.random()` in simulation code — determinism is a first-class requirement, not an afterthought.
- **Pragmatic ECS, not dogmatic.** Components are plain serializable objects in per-type maps; systems are stateless. Good enough for an RTS without archetype/bitset machinery.
- **Phase 0 isn't literally blank:** the spec lists terrain types under rendering, so the skeleton already renders grass/water/forest/hills/stone/gold instead of an empty grid, to make panning testable and front-load the terrain pipeline.
- **Selection is view state, like the camera.** Which units are selected lives in `SelectionController`, not the ECS world — it's player intent, not simulation state, so it never touches save games or determinism. Unit positions/movement *are* in the sim.
- **A\*: 8-connected, octile heuristic, no corner-cutting**, with a blocked-goal retarget to the nearest walkable tile (right-clicking water/forest still does something sensible). Diverges from AoE's flow-field-ish group movement — fine at this scale; revisit if large armies stutter.
- **Local collision avoidance is simple pair separation** (O(n²) over a handful of units), now terrain/occupancy-aware so it can't shove a unit into water or a building; a spatial-grid replacement is flagged for later.
- **Player economy lives in the ECS as a `Player` entity** (resources + population), so it serializes and is reachable by systems with no special global state. Selection/HUD are still pure view.
- **Resource nodes are entities on the terrain.** Forest/gold/stone tiles get a node entity; depleting one removes it and reopens the tile to grass. Food has no terrain, so berry bushes are entity-only sprites. The Town Center is the universal drop-off (Lumber/Mining camps + Mill come with Phase 3 buildings).
- **Occupancy is derived, not serialized.** Building footprints block tiles via a separate grid that pathfinding/movement consult alongside terrain; it's rebuilt from the building entities on load, so saves stay small and can't drift out of sync.
- **Group move orders spread across distinct tiles** and a stuck-detector lets crowds settle — a lightweight stand-in for AoE formations.
- **Data-driven units & buildings.** `UNIT_STATS` and `BUILDING_DEFS` tables hold footprint/cost/HP/build-time/pop/drop-off/training per kind, so adding a building or unit is a data edit, not new code paths. Unit combat stats (attack/armor/range) are defined now, used in Phase 4.
- **Construction is its own system + components.** A placed building is a `Building{complete:false}` + `Construction{progress,required}`; villagers carry a `Build` task; `BuildSystem` pours build points in and flips `complete` (removing `Construction`). Incomplete buildings don't provide pop, train, or accept drop-offs.
- **Placement is pure view state.** `PlacementController` computes the ghost tile + validity (buildable terrain, clear footprint, affordable) and never mutates the world; `main` commits the placement (pay + spawn foundation + block occupancy) as a player command — same view/sim split as selection.
- **One depth-sorted render pass (carried-over fix, now done).** Resources, buildings and units are merged into a single list keyed by world-Y (buildings by their front-tile centre) and drawn back-to-front, so a unit in front of a building draws in front and one behind is occluded. A single scalar key can't perfectly order against a multi-tile diamond footprint — good enough here; per-row banding is a later refinement if needed.
- **Divergence — defensive structures & Archery Range deferred.** Phase 3 ships the economy buildings + Barracks/infantry per its deliverable ("build a base and an army"); Walls/Gates/Towers/Archery Range come with the combat/depth phases. There's also no cancel-after-place refund yet.

### Strictness / quality bar

Full TypeScript strict mode, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `noImplicitReturns`. `npm run build` runs the typecheck and fails the build on any error.

---

## Roadmap

- **Phase 0 — Skeleton** ✅
- **Phase 1 — Units & movement** ✅ (selection, A* pathfinding, move orders)
- **Phase 2 — Economy** ✅ (resources, gathering, drop-off, train villagers, pop cap)
- **Phase 3 — Buildings & construction** ✅ (placement UI, villager-built, Barracks + infantry)
- Phase 4 — Combat (HP/armor, melee + ranged, projectiles, fog of war)
- Phase 5 — Enemy AI, win/lose, match setup
- Phase 6 — Tech tree, ages, minimap, control groups, save/load, audio, balance

## Project docs

- [`docs/PLAN.md`](./docs/PLAN.md) — the single living plan: design principles, the
  method, architecture invariants, phase roadmap **with status + commit SHAs**, the
  deferred backlog, and the next phase's task breakdown.
- [`docs/PROMPT.md`](./docs/PROMPT.md) — the original brief.
- [`CLAUDE.md`](./CLAUDE.md) — a short pointer to the two docs above.
- [`ASSETS.md`](./ASSETS.md) — art/audio credits.
