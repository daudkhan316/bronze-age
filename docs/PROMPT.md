# Original brief

The founding spec for the project, preserved verbatim as the source of truth for
the vision. (Process notes and the living plan are in `PLAN.md`; status is in
`PROGRESS.md`.)

---

> **"Bronze Age: an RTS inspired by Age of Empires"**
>
> **Goal:** Build a browser-based real-time strategy game in the spirit of Age of
> Empires II, running on macOS in any modern browser, playable single-player vs.
> an AI opponent.
>
> **Tech stack (fixed):**
> - TypeScript (strict mode) + Vite for dev/build.
> - HTML5 Canvas 2D for rendering (isometric tile grid). No heavyweight game
>   engine — keep dependencies minimal.
> - Architecture: Entity-Component-System (ECS), fixed-timestep simulation loop
>   (e.g. 20 ticks/sec) decoupled from render loop, so the game is deterministic
>   and pauseable.
> - State in plain serializable objects so save/load and AI inspection are trivial.
> - No backend; everything client-side. Save games to localStorage/downloadable JSON.
>
> **Core systems the full game must include:**
> 1. **Isometric map & rendering** — diamond tile grid, camera pan/zoom/edge-scroll,
>    terrain types (grass, water, forest, hills, stone/gold deposits), fog of war +
>    explored-but-hidden memory.
> 2. **Resources** — Food, Wood, Gold, Stone. Gathering with drop-off-to-building
>    mechanics and per-resource carry limits.
> 3. **Units** — selection (click, shift-click, drag-box, double-click-select-type),
>    grid/A* pathfinding with local collision avoidance, move/attack/gather/build/
>    garrison orders, control groups (Ctrl+1–9).
> 4. **Buildings** — Town Center, House (pop cap), Barracks, Archery Range,
>    Mill/Farm, Lumber Camp, Mining Camp, Wall/Gate, Tower. Placement preview with
>    validity check; construction by villagers.
> 5. **Economy & population** — pop cap from houses, build queues, resource costs,
>    refunds on cancel.
> 6. **Combat** — melee + ranged, hit points, attack/armor/pierce-armor stats,
>    attack-move, projectiles, death animations, unit counters (rock-paper-scissors).
> 7. **Tech tree & ages** — advance through Ages (e.g. Dark→Feudal→Castle→Imperial);
>    each unlocks units/buildings/upgrades; research at relevant buildings.
> 8. **AI opponent** — bootstraps an economy, expands, builds army, attacks;
>    difficulty levels. Start rule-based (build-order state machine), not ML.
> 9. **UI/HUD** — resource bar, minimap with click-to-navigate, selected-unit panel
>    with action buttons, build menus, hotkeys, game-speed control, pause.
> 10. **Win/lose** — defeat = all buildings destroyed (or wonder/relic variant
>     later). Match setup screen (map size, AI difficulty, starting resources).
> 11. **Audio** — basic SFX (select, command, combat, build-complete) and ambient/
>     music hooks. Use placeholder/CC0 assets.
>
> **Build it in phases** — each phase must be playable/testable on its own and
> committed before moving on. Stop after each phase and show me what works:
> - **Phase 0 — Skeleton:** Vite + TS project, fixed-timestep game loop, blank
>   isometric grid renderer, camera pan/zoom. *Deliverable: scrollable empty map at 60fps.*
> - **Phase 1 — Units & movement:** spawn villagers, selection (all methods), A*
>   pathfinding, move orders. *Deliverable: select and move units around terrain.*
> - **Phase 2 — Economy:** resource nodes, gathering + drop-off, Town Center, House,
>   build villagers, pop cap, resource HUD. *Deliverable: a working economy loop.*
> - **Phase 3 — Buildings & construction:** placement UI, villager construction,
>   Barracks + train infantry. *Deliverable: build a base and an army.*
> - **Phase 4 — Combat:** HP/armor/attack, melee + ranged, projectiles, attack-move,
>   death, fog of war. *Deliverable: two armies can fight.*
> - **Phase 5 — Enemy AI:** rule-based opponent with a build order that economies up
>   and attacks; win/lose conditions; match-setup screen. *Deliverable: a full beatable match.*
> - **Phase 6 — Depth:** tech tree, ages, more units/buildings, upgrades, minimap,
>   control groups, save/load, audio, balance pass.
>
> **Quality bar:** clean ECS separation, no global mutable spaghetti, typed
> throughout, each phase committed to git with a short README of controls. Use only
> free/CC0 placeholder art and audio; keep an ASSETS.md crediting sources. Flag any
> design decision where you'd diverge from AoE and tell me why.
