import type { Entity, ComponentType } from "@/ecs/types";

/**
 * Serializable snapshot of an entire world. Component data MUST be JSON-plain
 * (objects/arrays/numbers/strings/booleans/null) — no Map, Set, NaN, Infinity,
 * functions, or class instances — because saves are JSON-stringified. Author
 * components accordingly (e.g. a control group is `Entity[]`, not `Set`).
 *
 * `serialize()` returns a deep-copied, independent snapshot, so the simulation
 * may keep running after a save without mutating the saved data.
 */
export interface WorldSnapshot {
  nextId: number;
  living: Entity[];
  /** componentName -> list of [entity, data] pairs. */
  stores: Record<string, Array<[Entity, unknown]>>;
}

/**
 * The ECS world: owns entity lifecycle and component storage.
 *
 * Storage is a map of component-name -> (entity -> data). Components are plain
 * objects (see WorldSnapshot). Reads (`get`/`has`/`query`/`remove`) never
 * create a store, so the set of stores reflects only what was *written* — which
 * keeps serialized snapshots independent of read history (important for replay
 * hashing and save-diffing). Only `add` creates a store.
 */
export class World {
  private nextId = 1;
  private readonly living = new Set<Entity>();
  private readonly stores = new Map<string, Map<Entity, unknown>>();

  createEntity(): Entity {
    const e = this.nextId++;
    this.living.add(e);
    return e;
  }

  destroyEntity(e: Entity): void {
    this.living.delete(e);
    for (const store of this.stores.values()) store.delete(e);
  }

  isAlive(e: Entity): boolean {
    return this.living.has(e);
  }

  /** Get-or-create the backing store for a component (write path only). */
  private writeStore<T>(type: ComponentType<T>): Map<Entity, T> {
    let store = this.stores.get(type.name);
    if (store === undefined) {
      store = new Map<Entity, unknown>();
      this.stores.set(type.name, store);
    }
    return store as Map<Entity, T>;
  }

  add<T>(e: Entity, type: ComponentType<T>, data: T): T {
    // Invariant: components only attach to living entities. Catches the
    // add-after-destroy ordering bug (which would otherwise leak silently,
    // since query filters by living but the store keeps the data).
    if (!this.living.has(e)) {
      throw new Error(`World.add: entity ${e} is not alive (component "${type.name}")`);
    }
    this.writeStore(type).set(e, data);
    return data;
  }

  get<T>(e: Entity, type: ComponentType<T>): T | undefined {
    return this.stores.get(type.name)?.get(e) as T | undefined;
  }

  has<T>(e: Entity, type: ComponentType<T>): boolean {
    return this.stores.get(type.name)?.has(e) ?? false;
  }

  remove<T>(e: Entity, type: ComponentType<T>): void {
    this.stores.get(type.name)?.delete(e);
  }

  /** Iterate `[entity, data]` for every living entity carrying `type`. */
  *query<T>(type: ComponentType<T>): IterableIterator<[Entity, T]> {
    const store = this.stores.get(type.name);
    if (store === undefined) return;
    for (const [e, data] of store) {
      if (this.living.has(e)) yield [e, data as T];
    }
  }

  /** Living entity count. */
  get size(): number {
    return this.living.size;
  }

  /** Deep-copied, independent snapshot. Empty stores are omitted. */
  serialize(): WorldSnapshot {
    const stores: Record<string, Array<[Entity, unknown]>> = {};
    for (const [name, store] of this.stores) {
      if (store.size === 0) continue;
      stores[name] = [...store.entries()].map(
        ([e, data]): [Entity, unknown] => [e, structuredClone(data)],
      );
    }
    return { nextId: this.nextId, living: [...this.living], stores };
  }

  static deserialize(snap: WorldSnapshot): World {
    const world = new World();
    let maxId = 0;
    for (const e of snap.living) {
      world.living.add(e);
      if (e > maxId) maxId = e;
    }
    for (const [name, entries] of Object.entries(snap.stores)) {
      const store = new Map<Entity, unknown>(
        entries.map(([e, data]): [Entity, unknown] => {
          if (e > maxId) maxId = e;
          return [e, structuredClone(data)];
        }),
      );
      world.stores.set(name, store);
    }
    // Never hand out an id that's already in use, even from a tampered snapshot.
    world.nextId = Math.max(snap.nextId, maxId + 1);
    return world;
  }
}
