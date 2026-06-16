import type { GameMap } from "@/map/GameMap";
import type { GridPoint } from "@/math/iso";
import { canStand, packId } from "@/pathfinding/grid";
import type { BlockedQuery } from "@/pathfinding/grid";

// Re-export walkability helpers so callers only need "@/pathfinding/astar".
export { isWalkable, canStand, standableTileNear } from "@/pathfinding/grid";
export type { BlockedQuery } from "@/pathfinding/grid";

/**
 * 8-connected A* over the tile grid.
 *
 * Costs: orthogonal step = 1, diagonal step = √2. Heuristic = octile distance,
 * which is the exact cost of an unobstructed diagonal-then-straight walk and is
 * therefore admissible AND consistent for this move model — so the first time a
 * node is popped we have its optimal g, and no re-expansion is needed.
 *
 * Complexity: O(E log V) where V ≤ width·height and the open set is a binary
 * min-heap, so each push/pop is O(log V). A 64×64 map (4096 nodes) searches in
 * well under a millisecond.
 *
 * No corner cutting: a diagonal move from A to its diagonal neighbour B is only
 * allowed when BOTH tiles orthogonally adjacent to both A and B are walkable.
 * This stops units from slipping through the "X" gap between two blocking tiles.
 */

const SQRT2 = Math.SQRT2;

/** 8 neighbour offsets. The 4 diagonals carry the indices of the two */
/** orthogonal cells that must be clear for the move to be legal. */
interface NeighbourOffset {
  readonly dx: number;
  readonly dy: number;
  readonly cost: number;
  /** For diagonals: the two orthogonal {dx,dy} that must both be walkable. */
  readonly guards: readonly [readonly [number, number], readonly [number, number]] | null;
}

const NEIGHBOURS: readonly NeighbourOffset[] = [
  { dx: 1, dy: 0, cost: 1, guards: null },
  { dx: -1, dy: 0, cost: 1, guards: null },
  { dx: 0, dy: 1, cost: 1, guards: null },
  { dx: 0, dy: -1, cost: 1, guards: null },
  { dx: 1, dy: 1, cost: SQRT2, guards: [[1, 0], [0, 1]] },
  { dx: 1, dy: -1, cost: SQRT2, guards: [[1, 0], [0, -1]] },
  { dx: -1, dy: 1, cost: SQRT2, guards: [[-1, 0], [0, 1]] },
  { dx: -1, dy: -1, cost: SQRT2, guards: [[-1, 0], [0, -1]] },
];

/** Octile distance: admissible heuristic for the {1, √2} move model. */
function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  // min(dx,dy) diagonal steps + the leftover straight steps.
  return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
}

/**
 * Binary min-heap of node ids, ordered by f-score then by a stable secondary
 * key (the packed id) so equal-f ties resolve deterministically. Storing only
 * ids keeps the heap compact; f/g live in parallel arrays indexed by id.
 */
class MinHeap {
  private readonly ids: number[] = [];

  constructor(
    private readonly f: Float64Array,
  ) {}

  get size(): number {
    return this.ids.length;
  }

  /** True if node `a` orders before node `b` (lower f, then lower id). */
  private less(a: number, b: number): boolean {
    const fa = this.f[a] as number;
    const fb = this.f[b] as number;
    if (fa !== fb) return fa < fb;
    return a < b; // stable, deterministic tie-break on packed coordinate
  }

  push(id: number): void {
    const ids = this.ids;
    ids.push(id);
    let i = ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pi = ids[parent] as number;
      const ci = ids[i] as number;
      if (!this.less(ci, pi)) break;
      ids[parent] = ci;
      ids[i] = pi;
      i = parent;
    }
  }

  pop(): number {
    const ids = this.ids;
    const top = ids[0] as number;
    const last = ids.pop() as number;
    if (ids.length > 0) {
      ids[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftDown(start: number): void {
    const ids = this.ids;
    const n = ids.length;
    let i = start;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.less(ids[left] as number, ids[smallest] as number)) smallest = left;
      if (right < n && this.less(ids[right] as number, ids[smallest] as number)) smallest = right;
      if (smallest === i) break;
      const a = ids[i] as number;
      ids[i] = ids[smallest] as number;
      ids[smallest] = a;
      i = smallest;
    }
  }
}

/**
 * Find the nearest walkable tile to `goal` via a deterministic outward ring
 * scan (increasing Chebyshev radius; within a ring a fixed coordinate order).
 * Returns `null` if no walkable tile exists within the map bounds.
 *
 * Used to retarget when the requested goal is itself blocked, so a right-click
 * on water/forest still moves the unit as close as it can get.
 */
function nearestWalkable(map: GameMap, goal: GridPoint, occ?: BlockedQuery): GridPoint | null {
  if (canStand(map, goal.tx, goal.ty, occ)) return { tx: goal.tx, ty: goal.ty };

  // A ring at radius r can never contain a closer tile than the map's farthest
  // extent, so bound the search by the map diagonal.
  const maxR = map.width + map.height;
  for (let r = 1; r <= maxR; r++) {
    let best: GridPoint | null = null;
    // Scan the square ring at Chebyshev radius r in a fixed (ty, then tx) order
    // and keep the first walkable tile — deterministic and independent of input.
    for (let ty = goal.ty - r; ty <= goal.ty + r; ty++) {
      for (let tx = goal.tx - r; tx <= goal.tx + r; tx++) {
        // Only the perimeter of the square is new at this radius.
        const onRing = Math.abs(tx - goal.tx) === r || Math.abs(ty - goal.ty) === r;
        if (!onRing) continue;
        if (canStand(map, tx, ty, occ)) {
          best = { tx, ty };
          break;
        }
      }
      if (best !== null) break;
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * Compute a tile-by-tile path from `start` to `goal`.
 *
 * Returns the waypoints AFTER `start` through `goal` inclusive (the start tile
 * is excluded). Returns `[]` when start === goal, when no route exists, or when
 * neither the goal nor any walkable tile can be reached.
 *
 * If `goal` is unwalkable it is retargeted to the nearest walkable tile first.
 */
export function findPath(
  map: GameMap,
  start: GridPoint,
  goal: GridPoint,
  occ?: BlockedQuery,
): GridPoint[] {
  // Clamp the goal into the map first, so nearestWalkable's bounded ring scan
  // always covers every in-map tile even if a caller passes an out-of-bounds
  // goal (otherwise a far OOB goal could exceed the scan radius and wrongly
  // report "unreachable").
  const clampedGoal: GridPoint = {
    tx: goal.tx < 0 ? 0 : goal.tx > map.width - 1 ? map.width - 1 : goal.tx,
    ty: goal.ty < 0 ? 0 : goal.ty > map.height - 1 ? map.height - 1 : goal.ty,
  };

  // Retarget a blocked goal to the closest standable tile (deterministic).
  const target = nearestWalkable(map, clampedGoal, occ);
  if (target === null) return [];

  // If the unit can't even stand on its start tile, there is nothing to do.
  if (!canStand(map, start.tx, start.ty, occ)) return [];

  if (start.tx === target.tx && start.ty === target.ty) return [];

  const width = map.width;
  const n = width * map.height;

  const startId = packId(start.tx, start.ty, width);
  const goalId = packId(target.tx, target.ty, width);

  const g = new Float64Array(n).fill(Infinity);
  const f = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  // Closed set: a node is finalized once popped (consistent heuristic ⇒ optimal).
  const closed = new Uint8Array(n);

  g[startId] = 0;
  f[startId] = octile(start.tx, start.ty, target.tx, target.ty);

  const open = new MinHeap(f);
  open.push(startId);

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current] === 1) continue; // stale duplicate entry — skip
    if (current === goalId) return reconstruct(cameFrom, current, width);
    closed[current] = 1;

    const cx = current % width;
    const cy = (current - cx) / width;
    const gCur = g[current] as number;

    for (const nb of NEIGHBOURS) {
      const nx = cx + nb.dx;
      const ny = cy + nb.dy;
      if (!canStand(map, nx, ny, occ)) continue;

      // No corner cutting: both orthogonal cells flanking the diagonal must be
      // clear, otherwise the unit would clip the corner of a blocked tile.
      if (nb.guards !== null) {
        const [ga, gb] = nb.guards;
        if (!canStand(map, cx + ga[0], cy + ga[1], occ)) continue;
        if (!canStand(map, cx + gb[0], cy + gb[1], occ)) continue;
      }

      const neighbourId = packId(nx, ny, width);
      if (closed[neighbourId] === 1) continue;

      const tentative = gCur + nb.cost;
      if (tentative < (g[neighbourId] as number)) {
        cameFrom[neighbourId] = current;
        g[neighbourId] = tentative;
        f[neighbourId] = tentative + octile(nx, ny, target.tx, target.ty);
        // Lazy-deletion heap: push a fresh entry; the stale one is filtered on
        // pop via the closed check above. Avoids a decrease-key operation.
        open.push(neighbourId);
      }
    }
  }

  return []; // open set exhausted: target unreachable
}

/**
 * Walk the cameFrom chain from `goal` back to (but excluding) the start, then
 * reverse it so the result runs start→goal. The start tile is intentionally
 * dropped — callers want the steps still ahead of the unit.
 */
function reconstruct(cameFrom: Int32Array, goalId: number, width: number): GridPoint[] {
  const out: GridPoint[] = [];
  let cur = goalId;
  while (cur !== -1) {
    const tx = cur % width;
    const ty = (cur - tx) / width;
    out.push({ tx, ty });
    cur = cameFrom[cur] as number;
  }
  out.reverse();
  // out[0] is the start tile (its cameFrom is -1); exclude it.
  out.shift();
  return out;
}
