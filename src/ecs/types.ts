/** An entity is just an opaque id. All data lives in components. */
export type Entity = number;

/**
 * A component type descriptor. Carries a phantom `T` for compile-time type
 * safety while being nothing more than a name tag at runtime. Create one with
 * `defineComponent<T>(name)`.
 */
export interface ComponentType<T> {
  readonly name: string;
  /** Phantom field — never present at runtime; exists only to bind `T`. */
  readonly _type: T;
}

/**
 * Names registered so far. Component stores are keyed by name (so saves stay
 * readable), which means two `defineComponent` calls sharing a name would
 * silently alias each other's data through the unchecked store cast. Guard
 * against that at definition time, turning a silent data-corruption bug into a
 * loud startup error.
 */
const registeredNames = new Set<string>();

export function defineComponent<T>(name: string): ComponentType<T> {
  if (registeredNames.has(name)) {
    throw new Error(`defineComponent: duplicate component name "${name}" — names must be unique`);
  }
  registeredNames.add(name);
  return { name } as ComponentType<T>;
}
