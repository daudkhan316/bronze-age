# Plan & status

The single living reference: design principles, how we work, architecture
invariants, the phase roadmap **with current status**, the deferred backlog, and
the next phase's task list. The original brief is in [`PROMPT.md`](PROMPT.md).
**Update this file at the end of every phase**, commit, and push. It is written
to be self-sufficient so work resumes cleanly in a fresh context.

Last updated: **Phase 6, slice 5 (audio)**.

## Status

| Phase | Title | Status | Commit |
| --- | --- | --- | --- |
| 0 | Skeleton | ✅ | `96c4544` |
| 1 | Units & movement | ✅ | `53f665d` |
| 2 | Economy | ✅ | `6b29895` |
| 3 | Buildings & construction | ✅ | `9b3ba20` |
| 4 | Combat | ✅ | `af42910` |
| 5 | Enemy AI + match flow | ✅ | `59c0489` |
| 6 | Depth — **built in slices** | 🔨 in progress | — |
| 6a | · Tech tree & ages | ✅ | `01502be` |
| 6b | · QoL/UI (minimap · control groups · save/load) | ✅ | `2943468` |
| 6c | · Cavalry & counter triangle (+ AI economy fixes) | ✅ | `b2da500` |
| 6d | · Balance pass (archer kiting fix, cheaper tech/cav, curve) | ✅ | `65c87b7` |
| 6e | · Audio (procedural WebAudio SFX, sim→view event channel) | ✅ | `6731d8b` |
| 6f+ | · Walls/gates | ⬜ **Next** | — |

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

### Phase 5 — Enemy AI + match flow ✅ (`59c0489`)
Per-tick `CommandBuffer` + authoritative `executeCommand` — EVERY sim write (human
input AND AI) is a plain `Command` drained at tick start; re-validated on apply;
serialized in the snapshot (determinism survives save/load). `AiSystem` (rule-based
build order: balanced gather → houses → villagers → Barracks/Archery Range → army →
attack at a difficulty threshold) enqueues the same commands the human does; cadence
from serialized `AiMemory.ticks`, RNG-from-sim only, fog-limited targeting (nearest
explored enemy building, else mirror-of-own-start sweep). Two players + per-player
`Fog`; `MatchSystem` latches win/lose (defeated = zero buildings) into a singleton
`Match`. `Lobby` (map/difficulty/resources/seed → `MatchConfig`) + a
`menu → playing → gameover` app-state machine in `main.ts` with Victory/Defeat +
Play again. Built by parallel subagents (AI brain, lobby) against frozen contracts.
Review: 3 reviewers; rejected 4 non-bugs (disproven by the determinism test), fixed
real ones — major = AI gather monoculture starved wood (now distributed
food/wood/gold); plus builder de-dup, military cap counts queued, disengage halts
survivors, match-end frame ordering, `#controls` guard.

### Phase 6 — Depth (built in slices)
A grab-bag, done one reviewable slice at a time (stop + review per slice).

**Slice 1 — Tech tree & ages ✅ (`01502be`)** — Ages Stone→Bronze→Iron (advanced at
the TC; gate buildings/upgrades via `ageRequired`, enforced in executor + UI).
Per-player tech (`Player.age` + `techs`); `src/game/tech.ts` folds `UPGRADE_DEFS`
into EFFECTIVE stats read by combat/gather/tower (research changes outcomes without
mutating base tables; serializes free). Blacksmith (Forging/Scale Armor/Fletching/
Iron Casting) + Wheelbarrow/age advances at the TC; `Research` component advanced by
`ResearchSystem` (before `DeathSystem`); single `research` command (AI + human).
Watch Tower = building-attacker (`TowerSystem`, `"tower"` attacker kind, costs stone).
AI teches by BANKING (pauses unit production to afford its next tech goal). Built by
a subagent (AI tech layer) against the tech contracts. Review: 2 reviewers; fixed
research/death tick-race, tower counter-bonus, AI stone food-guard, AI Iron banking.

**Slice 2 — QoL/UI ✅ (`2943468`)** — All pure view state (never serialized).
Minimap (`src/render/drawMinimap.ts`): a corner canvas — fog-gated terrain + owned/
enemy blips + the camera viewport projected back to a trapezoid; click/drag to
recentre. Control groups in `SelectionController` (Ctrl/Cmd+1–9 bind, 1–9 recall;
prunes dead, no-op when unbound; `Input` preventDefaults Ctrl+Digit vs browser tab
switching). Save/load toolbar → `localStorage` via `Game.serialize/deserialize`;
`GameSnapshot` gains a `version` (SAVE_VERSION) so an incompatible save is rejected
cleanly. Review: 1 reviewer (mostly self-retracted); fixed save-version guard,
unbound-group no-op, hot-reload listener cleanup.

**Slice 3 — Cavalry & counter triangle ✅ (`b2da500`)** — New `cavalry` UnitKind
(fast/tanky melee) at a new age-2 `stable`. `DAMAGE_BONUS`: spearman→cavalry +12
(hard counter), cavalry→archer +4 / →villager +2 ⇒ spear > cav > archer triangle
(verified 17/13/8 per hit). Fully data-driven (UnitKind/BuildingKind + table entries
+ cavalry sprite + stable palette in drawWorld); generic systems unchanged. AI builds
a stable + fields cavalry opportunistically. **Big AI economy fix:** the 6a tech/
building resource-banking paused unit production so hard it silently starved the AI's
army (only spearmen, or passive/never-attacks). Removed Iron + blacksmith-upgrade +
secondary-building banking (now opportunistic); kept only a brief Bronze food-bank for
medium/hard (easy never techs); lowered hard armyThreshold 11→9 (13 villagerTarget).
All difficulties now mass + attack + win (easy ~800/3200, med 6400/8000, hard
10400/12000). Review: 1 reviewer (findings rejected — JSON round-trips numbers
losslessly so the rng-gate concern is moot; the stall needs a boxed-in base + clears
on foundation placement); the real issues (passive AI) were found+fixed by in-browser
testing across difficulties.

**Slice 4 — Balance pass ✅** — Driven by a 4-reviewer balance-analysis Workflow
(ai-reliability / unit-counters / economy-tech / difficulty) → synthesized
change-set; I applied the wins and rejected 2 after in-browser testing. APPLIED:
archer kiting fix (speed 48→52 so it out-paces spearmen — the broken RPS leg; +hp
40, +atk 5); cheaper costs (stable wood 150→100, archery 175→150, cavalry food
70→55, Iron gold 300→200, watch-tower stone 100→60); difficulty curve (hard
armyThreshold 9→7 so it's no longer the *slowest* to attack; medium/hard
villagerTarget −1). REJECTED after testing: the "Stable before Archery" reorder
(delayed the army + left the AI with cavalry but no archers), and the gold-weighted
gather (wrong premise — wood/food are the binding constraints; the AI already piles
up surplus gold). Verified: all 3 difficulties still attack + win (easy 800/3200,
medium 6400/8000, hard 6400/8000 — hard cured); counter triangle intact (17/13/5 +
kiting). **Still situational:** the AI fields cavalry / reaches Iron only with surplus
— a deeper build-order rework (build archery+stable in the opening without pausing
the army) is the real fix; the aggression-vs-diversity tension is genuine.

**Slice 5 — Audio ✅ (`6731d8b`)** — Procedural sound. A new **one-way sim→view
event channel** (`src/game/events.ts`, `EventBuffer`) mirrors the command buffer
but flows OUT: sim systems `emit()` transient `GameEvent`s (arrow fired, melee
hit, unit died, building destroyed/completed, unit trained) and the view drains
them each frame. The buffer is **never serialized and never read by sim code**, so
determinism is untouched — proven in-browser: a save/restored copy stayed
byte-identical to the live game across 40 ticks with events wired in, and `events`
is absent from the snapshot. `Game` owns the buffer and threads it into Build/
Combat/Tower/Death/Economy systems (each emit is a one-line pure push; `reapDead`
captures the dying entity's position before destroy). View side: **`SoundBank`**
(`src/audio/SoundBank.ts`) synthesises every SFX procedurally with WebAudio
(oscillators + filtered noise) — no asset files, CC0, swappable behind one
`play()`. `main.ts` drains via `routeSimAudio` (combat **fog-gated** — but you
always hear your *own* losses, since the dying entity may have been the only
vision over its tile; train/build chimes owner-gated), plays view sounds at
order/selection/placement/UI sites + victory/defeat, unlocks the AudioContext on
first gesture (autoplay policy), and persists mute (`M` / 🔊 toolbar button).
Review: a 3-dimension adversarial Workflow (determinism / audio-view / TS) →
verified findings; fixed 4 real ones — own-loss fog-gate bypass, drain the
match-deciding tick before the end screen (else the winning blow is silent),
`Math.imul` LCG, noise divisor `0x40000000`. All 6 event types verified firing in
a real browser.

**Remaining slices** — see "Next up" below.

## Deferred backlog (carry-over)

- **[P6 later slices]** **Walls / gates** (drag-placement + owner-aware open/close —
  needs occupancy/pathfinding that distinguishes owner) still deferred; cavalry shipped
  in slice 3. **Watch-tower range** is centre-to-tile (~1 tile short on a 2×2, cosmetic).
  **Mid-research building death** forfeits the paid cost (no refund) — by design.
- **[AI / balance]** The AI fields **cavalry / the Stable only opportunistically** (when
  it has surplus) — common in long/rich games, rare in tight ones; it rarely reaches the
  **Iron age** (600f/300g, no banking for it). Higher difficulties are a bit slower to
  first-attack than Phase 5 (the Bronze food-bank trade-off). All tuning levers for the
  balance slice, not bugs — every difficulty reliably attacks + wins. **Degenerate
  edge:** if `placeNear` can't find any build spot for ~18 rings (a fully boxed-in base),
  the AI can't place that building; its army still fights. Essentially impossible on the
  open-quadrant maps.
- **[done in P5]** Win/lose + match setup ✅; real owner-1 AI replacing the debug
  squad ✅; per-tick command buffer ✅. Console `spawn`/`spawnBuilding` hooks remain
  as debug aids (harmless; on `window`). **Owner stances** (move-only vs aggressive
  auto-acquire) still not implemented — the human's default is always aggressive.
- **[perf]** `footprintPlaceable` scans all resource nodes per footprint tile, and
  the AI's `placeNear` spirals up to ~18 rings — fine at tested scales (ran clean on
  48×48), but a node-tile index would make it O(1) for the 96×96 map. Same O(nodes)
  pattern as `resourceNodeAtTile`.
- **[save]** Save/load UI shipped (slice 2: one `localStorage` slot, `GameSnapshot`
  now has a `version`). It still doesn't store the `MatchConfig` (difficulty/start
  resources) — the world carries `Player.difficulty`/`AiMemory` so a loaded game plays
  correctly, but it can't *display* its original config. Multiple save slots / file
  import-export also deferred.
- **[UX]** Command-buffer 1-tick lag: a placement ghost shows valid, the player
  clicks, placement mode exits, but if resources drop within that tick the executor
  silently no-ops the build (no foundation, no feedback). Rare (needs two spends in
  one tick); add post-commit feedback or keep placement open until the foundation
  appears.
- **[AI]** No real scouting — a fog-blind AI marches on the mirror of its own start;
  no lumber/mining/mill drop-off camps (slower long-haul gathering); army can park at
  an empty rally tile until the next think re-issues. Tuning levers, not bugs.
- **[Phase 4+]** Cancel/refund a placed foundation + player-driven demolish (combat
  already destroys buildings + frees occupancy).
- **[render]** Per-row building depth banding; enemy-building fog gate uses one centre
  tile (cosmetic). **[fog]** explored history resets on load (per-player now).
- **[Phase 6]** Projectiles snapshot the attacker's *effective* `attack` at fire time
  but resolve the **defender's live effective armor/counters at impact** — works as
  intended now that tech-modified armor exists (verified). Keep in mind if mutable
  attacker stats ever need mid-flight re-evaluation.
- **[perf]** A* scratch-array pooling; spatial-grid separation. **[feel]** true
  formation movement (vs current distinct-tile spread).

## Next up — Phase 6 remaining slices

Slices 1–5 (tech & ages, QoL/UI, cavalry & counters, balance, audio) are done.
Remaining grab-bag, **one reviewable slice at a time** (stop + review per slice).
Reuse the command buffer for any new player actions; keep new sim state JSON-safe
+ serialized. (For new view feedback, reuse the sim→view `EventBuffer` from the
audio slice — emit a `GameEvent`, drain it in the view; never read it from sim.)

- [ ] **Walls / gates** — drag-placed wall segments + an owner-aware open/close gate
      (needs occupancy/pathfinding that knows the owner). Its own focused slice.
      (Recommended next.)
- [ ] **(stretch) AI combined-arms build order** — make the AI reliably field cavalry/
      archers + reach Iron by building archery+stable in the opening WITHOUT pausing the
      army (the unsolved tension from slices 3–4). Risky — verify all tiers still attack+win.
- [ ] **(optional) Audio polish** — ambient bed / spatialised (pan-by-screen-x) SFX;
      tower-fire already covered. The `SoundBank` `play()` interface makes swapping in
      real CC0 samples a drop-in if desired.
- [ ] Per slice: review → fix → verify in browser → update README + this file →
      commit → push → stop.
