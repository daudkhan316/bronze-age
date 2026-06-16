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

## Current status — Phase 2: Economy ✅

A working economy loop: gather four resources, drop them at the Town Center, and
spend food to train more villagers against a house-driven population cap — on top
of the Phase 0/1 map, units and A\* movement.

### Controls

| Input | Action |
| --- | --- |
| **Left-click** unit | Select it |
| **Left-drag** a box | Select all your units in the box |
| **Double-click** unit | Select all on-screen units of that type |
| **Shift** + click/drag | Add to / toggle current selection |
| **Right-click** a resource | Send selected villagers to gather it |
| **Right-click** ground | Move selected units there (A\* path) |
| `Q` or the on-screen button | Train a villager (50 food) at the Town Center |
| `W` `A` `S` `D` / Arrow keys | Pan camera |
| Move mouse to screen edge | Edge-scroll pan |
| Middle-mouse drag | Pan camera (grab) |
| Mouse wheel | Zoom in/out toward cursor |
| `Space` | Pause / resume simulation |
| `G` | Toggle tile grid overlay |

You start with **3 villagers**, a **Town Center** and **2 houses** (pop cap 15),
plus resource nodes: forests (wood), gold/stone deposits, and berry bushes
(food). Right-click a tree/bush/mine with villagers selected and they'll gather
it, haul it back to the Town Center, and the **resource bar** (top) ticks up.
Spend food to train villagers until you hit the population cap.

> **Resources:** food / wood / gold / stone, each node depletes and disappears
> (chopped forest reopens to grass). Carry capacity 10; the Town Center is the
> universal drop-off. Building *placement & construction* arrives in Phase 3 —
> for now the Town Center and houses are pre-placed.

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
    EconomySystem.ts   Population recount + Town Center training queues.
  selection/
    SelectionController.ts  VIEW-state selection: click/box/double-click/shift.
  render/
    Camera.ts          VIEW state only: world<->screen transform, pan/zoom/clamp.
    Renderer.ts        Canvas 2D context, HiDPI scaling, frame orchestration + overlay hook.
    drawMap.ts         Viewport-culled iso tile drawing.
    drawUnits.ts       Depth-sorted unit sprites + selection rings.
    drawResources.ts   Resource-node sprites (trees / bushes / gold / stone).
    drawBuildings.ts   Isometric building sprites (Town Center, House).
    colors.ts          Terrain palette.
  input/
    Input.ts           Keyboard/mouse/wheel state, per-frame deltas, edge-scroll.
  game/
    components.ts      All components + economy constants (plain, JSON-safe).
    spawn.ts           Factories: unit / resource node / building / player.
    economy.ts         Domain helpers: player lookup, drop-off / node search.
    Game.ts            Owns world + map + occupancy + systems + tick; setup; save/load.
  main.ts              Bootstraps everything; wires loop, input, orders, gather, HUD.
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
- **Divergence — building construction is deferred to Phase 3.** Phase 2 pre-places the Town Center and houses so the *economy loop* is the focus; placement preview + villager-built structures are the next phase. Training is via a hotkey/button rather than a selected-building panel (also Phase 3, once buildings are selectable).
- **Known limitation — no cross-type iso depth sort yet.** Resources, buildings and units are drawn in separate passes (units depth-sort among themselves), so a unit walking *behind* a pre-placed building can briefly draw in front of it. Purely cosmetic (zero sim impact); it'll be folded into a single depth-keyed draw list when Phase 3 makes buildings dynamic.

### Strictness / quality bar

Full TypeScript strict mode, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `noImplicitReturns`. `npm run build` runs the typecheck and fails the build on any error.

---

## Roadmap

- **Phase 0 — Skeleton** ✅
- **Phase 1 — Units & movement** ✅ (selection, A* pathfinding, move orders)
- **Phase 2 — Economy** ✅ (resources, gathering, drop-off, train villagers, pop cap)
- Phase 3 — Buildings & construction (placement UI, villager-built, Barracks)
- Phase 4 — Combat (HP/armor, melee + ranged, projectiles, fog of war)
- Phase 5 — Enemy AI, win/lose, match setup
- Phase 6 — Tech tree, ages, minimap, control groups, save/load, audio, balance

See [ASSETS.md](./ASSETS.md) for art/audio credits.
