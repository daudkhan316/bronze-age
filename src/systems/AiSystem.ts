import type { System } from "@/ecs/System";
import type { World } from "@/ecs/World";
import type { Entity } from "@/ecs/types";
import type { GameMap } from "@/map/GameMap";
import type { Occupancy } from "@/map/Occupancy";
import type { Random } from "@/core/Random";
import type { Fog } from "@/map/Fog";
import { CommandBuffer, footprintPlaceable } from "@/game/commands";
import {
  CPlayer,
  CAiMemory,
  CUnit,
  CBuilding,
  CGather,
  CBuild,
  CCombat,
  CMovement,
  CTransform,
  CTrainQueue,
  BUILDING_DEFS,
  UNIT_STATS,
  UPGRADE_DEFS,
  RESOURCE_KINDS,
  type AiMemory,
  type PlayerState,
  type Building,
  type BuildingKind,
  type ResourceKind,
  type UpgradeId,
} from "@/game/components";
import { findNearestNodeOfKind } from "@/game/economy";
import { canResearch } from "@/game/tech";
import { AI_PARAMS, type AiParams } from "@/game/match";
import { worldToTile } from "@/math/iso";

/** Resources the AI actively gathers (stone is unused by its build order). */
type GatherKind = "food" | "wood" | "gold";

/**
 * The computer opponent's brain (Phase 5). Runs as the last sim system each
 * tick; for every AI player it advances a rule-based build-order state machine
 * and pushes intents into the shared CommandBuffer (executed at the start of the
 * NEXT tick, like the human's). It never mutates the world directly — only
 * enqueues commands — so the AI and the player share one code path. The executor
 * re-validates affordability/pop/placement and silently no-ops invalid commands,
 * so we enqueue optimistically but pre-gate the obvious cases to avoid spam.
 *
 * Determinism: cadence is driven by the serialized per-player `AiMemory.ticks`
 * counter (NOT wall-clock), all randomness is drawn from the sim `rng`, queries
 * are iterated in natural order, and tie-breaks prefer the lowest entity id /
 * lowest tile index over rng. The AI sees only its own `Fog` (fog-limited
 * targeting), so it can't omnisciently snipe the human's base.
 *
 * Build order (per decision pass, priority order):
 *   1. assign idle villagers to the most-needed resource (lowest stockpile, with
 *      an early food floor),
 *   2. build a house when pop headroom runs low,
 *   3. train villagers at the Town Center up to villagerTarget,
 *   4. build military buildings (barracks, and archery_range when enabled) once
 *      the economy is on its feet,
 *   5. train military from each up to maxMilitaryPerType,
 *   6. once the army reaches armyThreshold, attackMove the whole army at the
 *      nearest explored enemy building (or sweep the mirrored TC tile if nothing
 *      is discovered yet),
 *   7. tech up (Phase 6): advance ages, build a Blacksmith + Watch Towers, and
 *      research Blacksmith/Town-Center upgrades — see maybeTech.
 */
export class AiSystem implements System {
  readonly name = "ai";

  constructor(
    private readonly map: GameMap,
    private readonly occ: Occupancy,
    private readonly buffer: CommandBuffer,
    private readonly rng: Random,
    private readonly fogFor: (owner: number) => Fog | undefined,
  ) {}

  update(world: World, _dt: number): void {
    for (const [, ps] of world.query(CPlayer)) {
      if (!ps.isAI) continue;
      const mem = aiMemory(world, ps.id);
      if (mem === undefined) continue;
      mem.ticks++;

      // Need a difficulty to look up the tuning knobs; a null-difficulty AI just
      // idles (shouldn't happen, but keeps us total).
      if (ps.difficulty === null) continue;
      const params = AI_PARAMS[ps.difficulty];

      // Only think on the cadence — cheap, and the offset is the same every run
      // so it's jitter-free across save/load.
      if (mem.ticks % params.thinkInterval !== 0) continue;

      this.think(world, ps, mem, params);
    }
  }

  /** One decision pass for a single AI player, in strict priority order. */
  private think(world: World, ps: PlayerState, mem: AiMemory, params: AiParams): void {
    const owner = ps.id;

    // Gather this AI's units/buildings once (natural query order).
    const units: Entity[] = [];
    let villagers = 0;
    let military = 0;
    for (const [e, u] of world.query(CUnit)) {
      if (u.owner !== owner) continue;
      units.push(e);
      if (u.kind === "villager") villagers++;
      else military++;
    }

    let tc: { e: Entity; b: Building } | undefined; // a complete Town Center
    const barracks: Array<{ e: Entity; b: Building }> = [];
    const ranges: Array<{ e: Entity; b: Building }> = [];
    // Phase 6 teching: count blacksmiths + watch towers (foundation OR complete,
    // like the barracks count) so maybeTech doesn't re-place ones in flight.
    const blacksmiths: Array<{ e: Entity; b: Building }> = []; // any (foundation/complete)
    const stables: Array<{ e: Entity; b: Building }> = []; // any (foundation/complete)
    let watchTowers = 0; // foundation OR complete
    for (const [e, b] of world.query(CBuilding)) {
      if (b.owner !== owner) continue;
      if (b.kind === "town_center" && b.complete && tc === undefined) tc = { e, b };
      else if (b.kind === "barracks") barracks.push({ e, b });
      else if (b.kind === "archery_range") ranges.push({ e, b });
      else if (b.kind === "blacksmith") blacksmiths.push({ e, b });
      else if (b.kind === "stable") stables.push({ e, b });
      else if (b.kind === "watch_tower") watchTowers++;
    }
    if (tc === undefined) return; // no base to think from (dead/booting) — bail.

    // --- 1) Economy: assign idle villagers --------------------------------
    this.assignIdleVillagers(world, owner, ps);

    // --- 1b) Builders: keep every foundation staffed ----------------------
    // The AI places foundations with no builders (like the human's place-then-
    // assign flow), so without this step they'd never progress. Self-healing:
    // also re-staffs a foundation whose builder died or wandered off.
    this.assignBuildersToFoundations(world, owner);

    // --- 2) Houses: keep pop headroom -------------------------------------
    this.maybeBuildHouse(world, owner, ps, mem, params, tc.b);

    // Phase 6: the AI banks for its next tech goal (Bronze → Blacksmith → a
    // couple of Blacksmith upgrades) by PAUSING new unit production — continuous
    // production otherwise keeps resources near zero and tech never affords. The
    // army already built keeps fighting (step 6); once the tech plan is done the
    // AI returns to pure military. See techSavingGoal.
    const saving =
      villagers >= Math.floor(params.villagerTarget * 0.6) &&
      this.wantsToBankTech(world, ps, tc.e, barracks);

    // --- 3) Train villagers up to target ----------------------------------
    if (!saving) this.trainVillagers(world, owner, ps, params, villagers, tc.e);

    // --- 4) Military buildings --------------------------------------------
    // Only commit to a military once the economy is on its feet, so a rush
    // doesn't starve villager production. The barracks/range builds spiral out
    // from the Town Center via footprintPlaceable. (Buildings cost wood, not
    // food, so they don't compete with banking for the age.)
    if (villagers >= Math.floor(params.villagerTarget * 0.6)) {
      if (barracks.length === 0 && this.canAfford(ps, BUILDING_DEFS.barracks.cost)) {
        this.placeNear(world, owner, "barracks", tc.b);
      } else if (
        params.buildArcheryRange &&
        ranges.length === 0 &&
        this.canAfford(ps, BUILDING_DEFS.archery_range.cost)
      ) {
        this.placeNear(world, owner, "archery_range", tc.b);
      } else if (
        // Stable (Age 2) for cavalry — ambitious difficulties only (easy keeps a
        // simple spear/archer army). Costs wood, so it doesn't fight food-banking.
        ps.age >= 2 &&
        ps.difficulty !== "easy" &&
        (!params.buildArcheryRange || ranges.length > 0) &&
        stables.length === 0 &&
        this.canAfford(ps, BUILDING_DEFS.stable.cost)
      ) {
        this.placeNear(world, owner, "stable", tc.b);
      }
    }

    // --- 5) Train military -------------------------------------------------
    if (!saving) {
      this.trainMilitary(world, owner, ps, params, barracks, "spearman");
      if (params.buildArcheryRange) {
        this.trainMilitary(world, owner, ps, params, ranges, "archer");
      }
      // Cavalry from any Stable (no-op until one exists, i.e. ambitious + Age 2).
      this.trainMilitary(world, owner, ps, params, stables, "cavalry");
    }

    // --- 6) Attack ---------------------------------------------------------
    this.maybeAttack(world, owner, mem, params, military, tc.b);

    // --- 7) Tech up (Phase 6) ---------------------------------------------
    // A teching layer that runs alongside the existing flow: advance ages,
    // build a Blacksmith + Watch Tower(s), and research upgrades when affordable.
    this.maybeTech(world, ps, params, tc, villagers, military, blacksmiths, watchTowers);
  }

  // ------------------------------------------------------------------------
  // 7) Tech (Phase 6)
  // ------------------------------------------------------------------------

  /**
   * The Phase-6 teching layer. Deterministic and pre-gated (`canResearch` for
   * eligibility + `canAfford` for cost), running on the same think cadence as the
   * rest of the build order. Priority, top to bottom:
   *
   *   1. Advance the age — Bronze once the economy is on its feet, then Iron once
   *      there's some army (medium/hard only; easy stops at Bronze).
   *   2. Build a Blacksmith once in Bronze (none in flight).
   *   3. Build Watch Tower(s) near the TC for defense (1, or 2 on medium/hard).
   *   4. Research Blacksmith + Town-Center upgrades, in a fixed preference order.
   *
   * Only enqueues commands; the executor re-validates everything next tick.
   */
  private maybeTech(
    world: World,
    ps: PlayerState,
    params: AiParams,
    tc: { e: Entity; b: Building },
    villagers: number,
    military: number,
    blacksmiths: Array<{ e: Entity; b: Building }>,
    watchTowers: number,
  ): void {
    const owner = ps.id;
    // easy stops at Bronze; medium/hard pursue Iron, iron_casting, a 2nd tower.
    const ambitious = ps.difficulty !== "easy";

    // --- 1) Age advances (at the Town Center) -----------------------------
    // Bronze: once the economy is on its feet (same ~60% villager gate the
    // military buildings use). Iron: once we also have some army to defend the
    // long research, and only for the ambitious difficulties.
    if (ps.age === 1) {
      if (
        villagers >= Math.floor(params.villagerTarget * 0.6) &&
        canResearch(world, owner, tc.e, "advance_bronze") &&
        this.canAfford(ps, UPGRADE_DEFS.advance_bronze.cost)
      ) {
        this.research(owner, tc.e, "advance_bronze");
      }
      return; // nothing else here is reachable below Bronze
    }

    // From here on age >= 2 (Bronze or Iron).

    if (
      ps.age === 2 &&
      ambitious &&
      military >= Math.max(1, Math.floor(params.armyThreshold / 2)) &&
      canResearch(world, owner, tc.e, "advance_iron") &&
      this.canAfford(ps, UPGRADE_DEFS.advance_iron.cost)
    ) {
      this.research(owner, tc.e, "advance_iron");
    }

    // --- 2) Blacksmith ----------------------------------------------------
    // One Blacksmith (count foundation + complete) once we can pay for it.
    if (blacksmiths.length === 0 && this.canAfford(ps, BUILDING_DEFS.blacksmith.cost)) {
      this.placeNear(world, owner, "blacksmith", tc.b);
    }

    // --- 3) Watch tower(s) ------------------------------------------------
    // Defensive towers cost wood + STONE. The AI doesn't gather stone in its
    // normal loop, so we attempt the tower only when its full cost (stone
    // included) is already affordable from the stockpile and nudge one idle
    // villager onto stone otherwise — see maybeGatherStone. This keeps the
    // existing food/wood/gold gather logic untouched.
    const towerTarget = ambitious ? 2 : 1;
    if (watchTowers < towerTarget) {
      if (this.canAfford(ps, BUILDING_DEFS.watch_tower.cost)) {
        this.placeNear(world, owner, "watch_tower", tc.b);
      } else {
        this.maybeGatherStone(world, owner, ps);
      }
    }

    // --- 4) Upgrades ------------------------------------------------------
    // Fixed preference order; canResearch gates kind/age/prereq/in-progress and
    // returns false if the building is busy (one research per building at a time).
    // forging → fletching (archers only) → scale_armor → iron_casting at each
    // Blacksmith; wheelbarrow at the Town Center.
    const smithOrder: UpgradeId[] = params.buildArcheryRange
      ? ["forging", "fletching", "scale_armor", "iron_casting"]
      : ["forging", "scale_armor", "iron_casting"];
    for (const { e, b } of blacksmiths) {
      if (!b.complete) continue;
      for (const id of smithOrder) {
        // iron_casting is an Iron-age tech; only the ambitious difficulties chase it.
        if (id === "iron_casting" && !ambitious) continue;
        if (canResearch(world, owner, e, id) && this.canAfford(ps, UPGRADE_DEFS[id].cost)) {
          this.research(owner, e, id);
          break; // one research per building per pass (it's now busy)
        }
      }
    }
    // Town-Center economy upgrade (after age advances are considered above so we
    // don't tie up the TC and block an age-up the same pass).
    if (
      canResearch(world, owner, tc.e, "wheelbarrow") &&
      this.canAfford(ps, UPGRADE_DEFS.wheelbarrow.cost)
    ) {
      this.research(owner, tc.e, "wheelbarrow");
    }
  }

  /**
   * Whether the AI should pause new unit production to bank for its next tech
   * goal. Crucially this does NOT check affordability — it stays true until the
   * purchase has STARTED (gated by `canResearch`, which flips false once the age
   * research is in progress). Checking affordability would oscillate at the cost
   * threshold: the pass food first hits the cost we'd un-pause, train units, dip
   * back under, and never actually buy.
   *
   * We ONLY pause for the **Bronze age advance** — a single 400-food purchase that
   * continuous unit production would never let us afford. Everything else (the
   * Blacksmith, its upgrades, Iron) is pursued opportunistically in `maybeTech`
   * when a surplus already affords it: pausing production for the whole tech tree
   * would starve the army for the entire game (it did — that was a bug).
   */
  private wantsToBankTech(
    world: World,
    ps: PlayerState,
    tcEntity: Entity,
    barracks: Array<{ e: Entity; b: Building }>,
  ): boolean {
    // Easy never techs — banking 400 food with its tiny economy would pause the
    // army for the whole game. It just makes spearmen and attacks.
    if (ps.difficulty === "easy") return false;
    return ps.age === 1 && barracks.length > 0 && canResearch(world, ps.id, tcEntity, "advance_bronze");
  }

  /**
   * Nudge a single idle villager onto stone so Watch Towers (wood + stone) can
   * eventually be afforded. Deliberately minimal and separate from
   * assignIdleVillagers (which only balances food/wood/gold and must stay
   * untouched): pulls at most ONE truly-idle, non-pathing villager per pass and
   * only if nobody is already mining stone, so it never starves the main
   * economy. Deterministic: lowest entity id wins.
   */
  private maybeGatherStone(world: World, owner: number, ps: PlayerState): void {
    // Don't divert our one idle villager to stone during a food emergency — food
    // funds villagers/spearmen and the diverted villager would override its
    // food assignment for this tick (commands apply next tick, FIFO).
    if (ps.food < 80) return;
    // Already have enough stone for a tower, or someone's already on it — skip.
    if (ps.stone >= (BUILDING_DEFS.watch_tower.cost.stone ?? 0)) return;
    let candidate: { e: Entity; x: number; y: number } | undefined;
    for (const [e, u] of world.query(CUnit)) {
      if (u.owner !== owner || u.kind !== "villager") continue;
      const g = world.get(e, CGather);
      if (g !== undefined) {
        if (g.resourceKind === "stone") return; // already mining stone — done
        continue;
      }
      if (world.has(e, CBuild)) continue;
      const mv = world.get(e, CMovement);
      const tr = world.get(e, CTransform);
      if (mv === undefined || tr === undefined || mv.path.length > 0) continue;
      // Lowest entity id is the stable pick (query order is natural/ascending).
      if (candidate === undefined) candidate = { e, x: tr.x, y: tr.y };
    }
    if (candidate === undefined) return;
    const hit = findNearestNodeOfKind(world, "stone", candidate.x, candidate.y, 9999);
    if (hit === null) return;
    this.buffer.enqueue({ type: "gather", owner, units: [candidate.e], node: hit.entity });
  }

  /** Enqueue a research command (pre-gated by the caller via canResearch + canAfford). */
  private research(owner: number, building: Entity, upgrade: UpgradeId): void {
    this.buffer.enqueue({ type: "research", owner, building, upgrade });
  }

  // ------------------------------------------------------------------------
  // 1) Economy
  // ------------------------------------------------------------------------

  /**
   * Put every idle villager (no gather/build task, not walking far) onto the
   * resource the AI most needs. "Most needed" = the lowest stockpile among
   * food/wood/gold, but with an early food floor so the AI never abandons food
   * (which funds villagers/spearmen). Stone is ignored — nothing in the build
   * order costs it. Each villager is tasked individually so it picks the node
   * nearest to itself.
   */
  private assignIdleVillagers(world: World, owner: number, ps: PlayerState): void {
    // Distribute gatherers across food/wood/gold toward a target split rather
    // than dumping everyone on the single lowest stockpile — a monoculture
    // starves the other resources (e.g. all-on-food never regathers the wood
    // that houses/military need, stalling the build order). Stone is ignored
    // (nothing in the AI's build order costs it).
    const kinds: GatherKind[] = ["food", "wood", "gold"];
    // Food-led early (funds villagers + spearmen), with real wood + gold income.
    const target: Record<GatherKind, number> = ps.food < 80
      ? { food: 0.6, wood: 0.3, gold: 0.1 } // emergency: refill food first
      : { food: 0.4, wood: 0.4, gold: 0.2 };

    // Count current gatherers per kind, and collect idle villagers.
    const assigned: Record<GatherKind, number> = { food: 0, wood: 0, gold: 0 };
    const idle: Array<{ e: Entity; x: number; y: number }> = [];
    for (const [e, u] of world.query(CUnit)) {
      if (u.owner !== owner || u.kind !== "villager") continue;
      const g = world.get(e, CGather);
      if (g !== undefined) {
        // Already gathering — count it toward its kind, never re-task it.
        const rk = g.resourceKind;
        if (rk === "food" || rk === "wood" || rk === "gold") assigned[rk] += 1;
        continue;
      }
      if (world.has(e, CBuild)) continue;
      const mv = world.get(e, CMovement);
      const tr = world.get(e, CTransform);
      if (mv === undefined || tr === undefined) continue;
      if (mv.path.length > 0) continue; // mid-path — leave it be (no thrash)
      idle.push({ e, x: tr.x, y: tr.y });
    }

    for (const v of idle) {
      const total = assigned.food + assigned.wood + assigned.gold + 1;
      // Pick the kind furthest below its target share (stable order breaks ties).
      let pick: GatherKind = "food";
      let bestDeficit = -Infinity;
      for (const k of kinds) {
        const deficit = target[k] - assigned[k] / total;
        if (deficit > bestDeficit) {
          bestDeficit = deficit;
          pick = k;
        }
      }
      // Find a node of the chosen kind; fall back through the others so an idle
      // villager always finds work when its preferred kind is exhausted.
      let hit = findNearestNodeOfKind(world, pick, v.x, v.y, 9999);
      if (hit === null) {
        for (const k of kinds) {
          if (k === pick) continue;
          hit = findNearestNodeOfKind(world, k, v.x, v.y, 9999);
          if (hit !== null) {
            pick = k;
            break;
          }
        }
      }
      if (hit === null) continue;
      assigned[pick] = (assigned[pick] ?? 0) + 1;
      this.buffer.enqueue({ type: "gather", owner, units: [v.e], node: hit.entity });
    }
  }

  /**
   * Ensure each of the AI's unfinished foundations has up to two builders. Counts
   * villagers already assigned to it (a CBuild targeting that foundation), then
   * pulls the nearest available villagers to make up the difference. Prefers
   * truly idle villagers (no gather/build task) but will pull a gatherer if
   * that's all there is — finishing a house/barracks is worth a few wood. The
   * assignBuild command drops any existing gather task, so it overrides cleanly.
   */
  private assignBuildersToFoundations(world: World, owner: number): void {
    const WANT = 2;
    // Villagers picked earlier in this pass — commands apply next tick, so a
    // villager's CBuild isn't visible yet; without this set the same villager
    // could be claimed by two foundations (the later assignBuild would win and
    // the first foundation would go unstaffed for a whole think interval).
    const claimed = new Set<Entity>();
    for (const [fe, fb] of world.query(CBuilding)) {
      if (fb.owner !== owner || fb.complete) continue;

      // Already-assigned builders for this foundation.
      let have = 0;
      for (const [, bd] of world.query(CBuild)) {
        if (bd.target === fe) have++;
      }
      if (have >= WANT) continue;

      // Candidate villagers not already building (or claimed this pass), ranked:
      // idle first, then nearest. Distance is to the footprint origin.
      const candidates: Array<{ e: Entity; idle: boolean; d: number }> = [];
      for (const [e, u] of world.query(CUnit)) {
        if (u.owner !== owner || u.kind !== "villager") continue;
        if (world.has(e, CBuild) || claimed.has(e)) continue;
        const tr = world.get(e, CTransform);
        if (tr === undefined) continue;
        const t = worldToTile(tr.x, tr.y);
        const d = Math.max(Math.abs(t.tx - fb.tx), Math.abs(t.ty - fb.ty));
        candidates.push({ e, idle: !world.has(e, CGather), d });
      }
      // Idle before busy; nearest first; entity id as a stable final tie-break.
      candidates.sort((a, b) =>
        a.idle !== b.idle ? (a.idle ? -1 : 1) : a.d !== b.d ? a.d - b.d : a.e - b.e,
      );

      const take = candidates.slice(0, WANT - have).map((c) => c.e);
      if (take.length > 0) {
        for (const e of take) claimed.add(e);
        this.buffer.enqueue({ type: "assignBuild", owner, villagers: take, target: fe });
      }
    }
  }

  // ------------------------------------------------------------------------
  // 2) Houses
  // ------------------------------------------------------------------------

  /**
   * Build a house when pop headroom is tight, capped so we don't house past what
   * the army+economy will ever need. "Tight" counts villagers already queued at
   * the TC so we pre-empt the cap rather than stalling at it.
   */
  private maybeBuildHouse(
    world: World,
    owner: number,
    ps: PlayerState,
    mem: AiMemory,
    params: AiParams,
    tc: Building,
  ): void {
    const popCeiling = params.villagerTarget + params.armyThreshold + 10;
    if (ps.popCap >= popCeiling) return;

    const queued = queuedForOwner(world, owner);
    if (ps.popUsed + queued < ps.popCap - 2) return; // still have headroom
    if (!this.canAfford(ps, BUILDING_DEFS.house.cost)) return;

    if (this.placeNear(world, owner, "house", tc)) {
      mem.stage = "boom"; // economy phase label
    }
  }

  // ------------------------------------------------------------------------
  // 3) Train villagers
  // ------------------------------------------------------------------------

  /**
   * Queue villagers at the Town Center up to villagerTarget, gated on food cost,
   * population, and a short queue (so we don't pre-pay a long line that the cap
   * can't honour). Counting queued villagers toward the target stops us
   * overshooting once enough are in flight.
   */
  private trainVillagers(
    world: World,
    owner: number,
    ps: PlayerState,
    params: AiParams,
    villagers: number,
    tcEntity: Entity,
  ): void {
    const tq = world.get(tcEntity, CTrainQueue);
    if (tq === undefined) return;
    if (tq.queued >= 2) return; // keep the TC queue short
    if (villagers + tq.queued >= params.villagerTarget) return;
    if (!this.canAfford(ps, UNIT_STATS.villager.cost)) return;
    if (ps.popUsed + queuedForOwner(world, owner) >= ps.popCap) return;
    this.buffer.enqueue({ type: "train", owner, building: tcEntity, unit: "villager" });
  }

  // ------------------------------------------------------------------------
  // 5) Train military
  // ------------------------------------------------------------------------

  /**
   * Train `unit` from each complete production building up to maxMilitaryPerType
   * total of that kind, gated on cost, population, and a short per-building
   * queue. Counts the units already alive plus everything queued across the
   * player's buildings so the cap is honoured globally.
   */
  private trainMilitary(
    world: World,
    owner: number,
    ps: PlayerState,
    params: AiParams,
    buildings: Array<{ e: Entity; b: Building }>,
    unit: "spearman" | "archer" | "cavalry",
  ): void {
    if (buildings.length === 0) return;
    let count = 0;
    for (const [, u] of world.query(CUnit)) {
      if (u.owner === owner && u.kind === unit) count++;
    }
    // Count units already in these buildings' queues too, so in-flight training
    // counts toward the cap (otherwise the army overshoots maxMilitaryPerType by
    // a think-interval's worth before the queued units spawn).
    for (const { e } of buildings) {
      const q = world.get(e, CTrainQueue);
      if (q !== undefined) count += q.queued;
    }
    const cost = UNIT_STATS[unit].cost;
    for (const { e, b } of buildings) {
      if (!b.complete) continue;
      if (count >= params.maxMilitaryPerType) break;
      const tq = world.get(e, CTrainQueue);
      if (tq === undefined || tq.queued >= 2) continue;
      if (!this.canAfford(ps, cost)) break; // can't pay — stop trying this kind
      if (ps.popUsed + queuedForOwner(world, owner) >= ps.popCap) break;
      this.buffer.enqueue({ type: "train", owner, building: e, unit });
      // Optimistically count the queued unit so sibling buildings this pass
      // don't all blow past the cap (the executor re-checks pop/afford anyway).
      count++;
    }
  }

  // ------------------------------------------------------------------------
  // 6) Attack
  // ------------------------------------------------------------------------

  /**
   * Mass-and-push: once the army reaches armyThreshold, send EVERY idle military
   * unit (not already attacking) on an attackMove toward the enemy. Disengage
   * (rebuild) if the army is whittled below half the threshold. Targeting is
   * fog-limited — see chooseAttackTarget.
   */
  private maybeAttack(
    world: World,
    owner: number,
    mem: AiMemory,
    params: AiParams,
    military: number,
    tc: Building,
  ): void {
    if (mem.attacking && military < Math.max(1, Math.floor(params.armyThreshold / 2))) {
      // Army gutted — pull back to massing. Halt the survivors so they actually
      // stop pressing in (otherwise their attack-move stays live and the
      // "disengage" is hollow). Idle military still auto-defends in CombatSystem.
      const survivors: Entity[] = [];
      for (const [e, u] of world.query(CUnit)) {
        if (u.owner === owner && u.kind !== "villager") survivors.push(e);
      }
      if (survivors.length > 0) {
        this.buffer.enqueue({ type: "stop", owner, units: survivors });
      }
      mem.attacking = false;
      mem.stage = "boom";
      return;
    }

    if (!mem.attacking) {
      if (military < params.armyThreshold) return; // still massing
      mem.attacking = true;
      mem.stage = "attack";
    }

    // Pick (or refresh) the target tile every attacking pass: as the army
    // advances and reveals fog it can re-home onto a real enemy building.
    const target = this.chooseAttackTarget(world, owner, tc);
    mem.rallyTx = target.tx;
    mem.rallyTy = target.ty;

    // Send only IDLE military (no live target and no attack-move in progress)
    // toward the target. Units already engaging an enemy or already marching are
    // left alone, so we don't wipe a mid-fight target or thrash a unit's order
    // every pass; CombatSystem auto-acquires enemies met en route. This also
    // sweeps up freshly-trained reinforcements into the ongoing push.
    const army: Entity[] = [];
    for (const [e, u] of world.query(CUnit)) {
      if (u.owner !== owner || u.kind === "villager") continue;
      const cb = world.get(e, CCombat);
      if (cb !== undefined && (cb.target !== null || cb.attackMove !== null)) continue;
      army.push(e);
    }
    if (army.length > 0) {
      this.buffer.enqueue({ type: "attackMove", owner, units: army, tx: target.tx, ty: target.ty });
    }
  }

  /**
   * Fog-limited attack target. Scan enemy buildings; for each, if ANY footprint
   * tile is currently explored OR visible in THIS AI's fog, it's a known target.
   * Pick the nearest known one (Chebyshev from our TC; lowest tile index breaks
   * ties). If nothing is known yet, sweep toward the mirror of our own Town
   * Center across the map centre — the likely human start — discovering the
   * enemy via fog as the army marches (CombatSystem auto-acquires en route).
   */
  private chooseAttackTarget(world: World, owner: number, tc: Building): { tx: number; ty: number } {
    const fog = this.fogFor(owner);
    const fromTx = tc.tx + (tc.w >> 1);
    const fromTy = tc.ty + (tc.h >> 1);

    let best: { tx: number; ty: number } | undefined;
    let bestD = Infinity;
    let bestIdx = Infinity; // origin tile index, for a stable tie-break
    for (const [, b] of world.query(CBuilding)) {
      if (b.owner === owner) continue; // only enemies
      // Known if ANY footprint tile is explored/visible in our own fog.
      let known = fog === undefined; // no fog wired up -> treat all as known
      if (fog !== undefined) {
        outer: for (let y = b.ty; y < b.ty + b.h; y++) {
          for (let x = b.tx; x < b.tx + b.w; x++) {
            if (fog.isExplored(x, y) || fog.isVisible(x, y)) {
              known = true;
              break outer;
            }
          }
        }
      }
      if (!known) continue;
      const d = Math.max(Math.abs(b.tx - fromTx), Math.abs(b.ty - fromTy));
      const idx = b.ty * this.map.width + b.tx;
      // Nearest building; lowest footprint-origin tile index breaks ties.
      if (d < bestD || (d === bestD && idx < bestIdx)) {
        bestD = d;
        bestIdx = idx;
        best = { tx: b.tx, ty: b.ty };
      }
    }
    if (best !== undefined) return best;

    // Nothing discovered: march toward the mirror of our own TC.
    return {
      tx: this.map.width - 1 - fromTx,
      ty: this.map.height - 1 - fromTy,
    };
  }

  // ------------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------------

  /** True if `ps` can pay every component of `cost`. */
  private canAfford(ps: PlayerState, cost: Partial<Record<ResourceKind, number>>): boolean {
    for (const k of RESOURCE_KINDS) {
      if ((cost[k] ?? 0) > ps[k]) return false;
    }
    return true;
  }

  /**
   * Spiral outward from a Town Center footprint and enqueue a `build` for `kind`
   * on the first legal spot (footprintPlaceable). Returns true if a spot was
   * found and a command enqueued. Deterministic: the spiral visits tiles in a
   * fixed ring order, so the same situation always picks the same spot.
   */
  private placeNear(world: World, owner: number, kind: BuildingKind, tc: Building): boolean {
    const def = BUILDING_DEFS[kind];
    // Centre the search just outside the TC footprint, with a small rng-driven
    // offset so successive buildings fan out around the base instead of all
    // stacking on one side. `rng` keeps this deterministic (serialized seed).
    const cx = tc.tx - 1 + (this.rng.int(0, 2) - 1);
    const cy = tc.ty - 1 + (this.rng.int(0, 2) - 1);
    for (let r = 0; r <= 18; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const tx = cx + dx;
          const ty = cy + dy;
          if (!this.map.inBounds(tx, ty)) continue;
          if (!this.map.inBounds(tx + def.w - 1, ty + def.h - 1)) continue;
          if (footprintPlaceable(world, this.map, this.occ, kind, tx, ty)) {
            this.buffer.enqueue({ type: "build", owner, kind, tx, ty, builders: [] });
            return true;
          }
        }
      }
    }
    return false;
  }
}

/** The AiMemory for `owner`, or undefined. */
function aiMemory(world: World, owner: number): AiMemory | undefined {
  for (const [, m] of world.query(CAiMemory)) {
    if (m.owner === owner) return m;
  }
  return undefined;
}

/** Total units queued across all of a player's training buildings. */
function queuedForOwner(world: World, owner: number): number {
  let total = 0;
  for (const [e, b] of world.query(CBuilding)) {
    if (b.owner !== owner) continue;
    const tq = world.get(e, CTrainQueue);
    if (tq !== undefined) total += tq.queued;
  }
  return total;
}
