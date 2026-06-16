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

## Current status — Phase 4: Combat ✅

Two armies can fight: melee + ranged units, projectiles, attack & attack-move
orders with auto-retaliate, unit counters, death, and **fog of war** — on top of
the Phase 0–3 economy and base-building.

### Controls

| Input | Action |
| --- | --- |
| **Left-click** unit / building | Select unit, or single-select a building |
| **Left-drag** box · **double-click** · **Shift** | Box-select · select by type · add/toggle |
| Select a villager → **Build** menu | Pick a building to place (ghost → left-click) |
| **Right-click** an enemy | Attack it (your units chase it down) |
| **F** then left-click | Attack-move: advance to a point, engaging enemies en route |
| **Right-click** foundation / resource / ground | Build / gather / move |
| Select a building → panel / `Q` | Train its unit (Barracks → spearman, Archery Range → archer) |
| `W` `A` `S` `D` / Arrows / edge / middle-drag | Pan · wheel: zoom |
| `Space` pause · `G` grid · `Esc` cancel | |

You start with 3 villagers, a Town Center and 2 houses. Build a **Barracks**
(spearmen) and an **Archery Range** (archers), make an army, and crush the debug
enemy force off to the east. Idle military auto-retaliate when enemies wander
into range; villagers don't auto-fight.

> **Combat:** damage = `max(1, attack − armor)` (melee) or `− pierce-armor`
> (ranged) plus counter bonuses (spearmen beat archers; archers harry villagers).
> Archers fire homing arrows. Units die at 0 HP (HP bars show damage). **Fog of
> war:** you only see tiles near your units/buildings; enemy units vanish when out
> of sight, enemy buildings are remembered once seen, the rest is black.

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
    Fog.ts             Per-player fog of war: visible + explored tile grids (derived).
  pathfinding/
    astar.ts           8-connected A* (octile heuristic, no corner-cutting, binary heap).
    grid.ts            Walkability/standability (terrain + occupancy) + helpers.
  systems/
    MovementSystem.ts  Path-following + occupancy-aware separation; stuck-detection.
    GatherSystem.ts    Villager gather state machine (toNode/gathering/toDrop/depositing).
    BuildSystem.ts     Villager construction state machine (toSite/building → complete).
    CombatSystem.ts    Acquire/chase/attack (melee + ranged) + attack-move.
    ProjectileSystem.ts  Arrows home on targets and resolve impact damage.
    DeathSystem.ts     Reaps 0-hp entities each tick; frees building occupancy.
    EconomySystem.ts   Population recount + building training queues.
    FogSystem.ts       Recomputes the viewer's visibility from unit/building sight.
  selection/
    SelectionController.ts  VIEW-state selection: units (click/box/double-click) + 1 building.
  placement/
    PlacementController.ts  VIEW-state build placement: ghost tile + validity (no mutation).
  render/
    Camera.ts          VIEW state only: world<->screen transform, pan/zoom/clamp.
    Renderer.ts        Canvas 2D context, HiDPI scaling, frame orchestration + overlay hook.
    drawMap.ts         Viewport-culled iso tile drawing.
    drawWorld.ts       ONE depth-sorted pass: resources/buildings/units + projectiles; fog-gates enemies.
    drawPlacement.ts   The build placement ghost (green/red footprint).
    drawFog.ts         The fog-of-war veil overlay.
    colors.ts          Terrain palette.
  input/
    Input.ts           Keyboard/mouse/wheel state, per-frame deltas, edge-scroll.
  game/
    components.ts      All components + unit/building data tables (plain, JSON-safe).
    spawn.ts           Factories: unit / resource node / building / player / projectile.
    economy.ts         Domain helpers: player lookup, drop-off / node search, approach tiles.
    combat.ts          Combat helpers: enemy search, damage calc, apply-damage, reap-dead.
    Game.ts            Owns world + map + occupancy + fog + systems + tick; setup; save/load.
  main.ts              Bootstraps everything; wires loop, input, orders, placement, combat, HUD.
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
- **Divergence — defensive structures deferred.** Phase 3 shipped the economy buildings + Barracks; Phase 4 adds the Archery Range. Walls/Gates/Towers come with later phases. There's still no cancel-after-place refund.
- **Centralised death.** Combat and projectile systems only call `applyDamage` (subtract HP); a separate `DeathSystem` reaps 0-HP entities once per tick (freeing a dead building's occupancy). Nothing destroys entities mid-iteration, so the damage-dealing systems can't corrupt the query they're walking.
- **Combat is intent + resolution split across systems.** `CombatSystem` decides (acquire/chase/attack) and sets Movement paths; `MovementSystem` walks; ranged attacks spawn a homing `Projectile` that `ProjectileSystem` flies and resolves. Damage = `max(1, attack − armor/pierce)` plus a small `DAMAGE_BONUS` counter table. All deterministic on the fixed tick.
- **Fog of war is derived, not serialized.** A per-player `Fog` (visible + explored grids) is recomputed every tick by `FogSystem` from unit/building sight; the renderer hides enemy units outside current vision and remembers enemy buildings once explored. Like occupancy, it's rebuilt rather than saved (explored history resets on load — acceptable for now).

### Strictness / quality bar

Full TypeScript strict mode, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `noImplicitReturns`. `npm run build` runs the typecheck and fails the build on any error.

---

## Roadmap

- **Phase 0 — Skeleton** ✅
- **Phase 1 — Units & movement** ✅ (selection, A* pathfinding, move orders)
- **Phase 2 — Economy** ✅ (resources, gathering, drop-off, train villagers, pop cap)
- **Phase 3 — Buildings & construction** ✅ (placement UI, villager-built, Barracks + infantry)
- **Phase 4 — Combat** ✅ (HP/armor, melee + ranged, projectiles, attack-move, death, fog of war)
- Phase 5 — Enemy AI, win/lose, match setup
- Phase 6 — Tech tree, ages, minimap, control groups, save/load, audio, balance

## Project docs

- [`docs/PLAN.md`](./docs/PLAN.md) — the single living plan: design principles, the
  method, architecture invariants, phase roadmap **with status + commit SHAs**, the
  deferred backlog, and the next phase's task breakdown.
- [`docs/PROMPT.md`](./docs/PROMPT.md) — the original brief.
- [`CLAUDE.md`](./CLAUDE.md) — a short pointer to the two docs above.
- [`ASSETS.md`](./ASSETS.md) — art/audio credits.
