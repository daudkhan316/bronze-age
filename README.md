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

## Current status — Phase 1: Units & movement ✅

Villagers you can select (every method) and command around the terrain with A\*
pathfinding, on top of the Phase 0 isometric map and fixed-timestep sim.

### Controls

| Input | Action |
| --- | --- |
| **Left-click** unit | Select it |
| **Left-drag** a box | Select all your units in the box |
| **Double-click** unit | Select all on-screen units of that type |
| **Shift** + click/drag | Add to / toggle current selection |
| **Right-click** | Move selected units to that tile (A\* path) |
| `W` `A` `S` `D` / Arrow keys | Pan camera |
| Move mouse to screen edge | Edge-scroll pan |
| Middle-mouse drag | Pan camera (grab) |
| Mouse wheel | Zoom in/out toward cursor |
| `Space` | Pause / resume simulation |
| `G` | Toggle tile grid overlay |

You start with 8 cyan villagers near the map centre (plus two red, unselectable
enemy units to show owner colours). The HUD shows fps, sim tick, zoom, selected
count, the hovered tile, and grid state.

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
  pathfinding/
    astar.ts           8-connected A* (octile heuristic, no corner-cutting, binary heap).
    grid.ts            Walkability + node-id packing helpers.
  systems/
    MovementSystem.ts  Path-following + local separation (collision avoidance).
  selection/
    SelectionController.ts  VIEW-state selection: click/box/double-click/shift.
  render/
    Camera.ts          VIEW state only: world<->screen transform, pan/zoom/clamp.
    Renderer.ts        Canvas 2D context, HiDPI scaling, frame orchestration + overlay hook.
    drawMap.ts         Viewport-culled iso tile drawing.
    drawUnits.ts       Depth-sorted unit sprites + selection rings.
    colors.ts          Terrain palette.
  input/
    Input.ts           Keyboard/mouse/wheel state, per-frame deltas, edge-scroll.
  game/
    components.ts      Transform / Movement / Unit components (plain, JSON-safe).
    spawn.ts           Unit factory.
    Game.ts            Owns world + map + systems + tick (the simulation); save/load.
  main.ts              Bootstraps everything, wires loop, input, selection, orders, HUD.
```

### Key design decisions (and where we diverge from AoE)

- **Camera is view state, not game state.** Pan/zoom update at render framerate (smooth) and never enter the ECS world or save games. Only deterministic sim state is serializable.
- **Fixed 20Hz simulation, decoupled render.** An accumulator drives discrete sim ticks; the render loop carries an interpolation `alpha` (unused in Phase 0, ready for smooth unit movement later). This is what makes the game pauseable, deterministic, and save/load-friendly.
- **Seeded PRNG everywhere in the sim.** No `Math.random()` in simulation code — determinism is a first-class requirement, not an afterthought.
- **Pragmatic ECS, not dogmatic.** Components are plain serializable objects in per-type maps; systems are stateless. Good enough for an RTS without archetype/bitset machinery.
- **Phase 0 isn't literally blank:** the spec lists terrain types under rendering, so the skeleton already renders grass/water/forest/hills/stone/gold instead of an empty grid, to make panning testable and front-load the terrain pipeline.
- **Selection is view state, like the camera.** Which units are selected lives in `SelectionController`, not the ECS world — it's player intent, not simulation state, so it never touches save games or determinism. Unit positions/movement *are* in the sim.
- **A\*: 8-connected, octile heuristic, no corner-cutting**, with a blocked-goal retarget to the nearest walkable tile (right-clicking water/forest still does something sensible). Diverges from AoE's flow-field-ish group movement — fine at this scale; revisit if large armies stutter.
- **Local collision avoidance is simple pair separation** (O(n²) over a handful of units) as a placeholder; it has no terrain awareness yet and is flagged for a spatial-grid + path-aware replacement in a later phase.

### Strictness / quality bar

Full TypeScript strict mode, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `noImplicitReturns`. `npm run build` runs the typecheck and fails the build on any error.

---

## Roadmap

- **Phase 0 — Skeleton** ✅
- **Phase 1 — Units & movement** ✅ (selection, A* pathfinding, move orders)
- Phase 2 — Economy (resources, gathering, drop-off, pop cap)
- Phase 3 — Buildings & construction
- Phase 4 — Combat (HP/armor, melee + ranged, projectiles, fog of war)
- Phase 5 — Enemy AI, win/lose, match setup
- Phase 6 — Tech tree, ages, minimap, control groups, save/load, audio, balance

See [ASSETS.md](./ASSETS.md) for art/audio credits.
