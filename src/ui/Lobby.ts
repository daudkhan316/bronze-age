import {
  MAP_SIZES,
  RESOURCE_LEVELS,
  DEFAULT_MATCH_CONFIG,
  type MatchConfig,
  type MapSize,
  type Difficulty,
  type ResourceLevel,
} from "@/game/match";

/**
 * Pre-game lobby (Phase 5). Renders the match-setup form into a host element
 * (`#menu`, already styled as `.overlay`) and, when the player presses Start,
 * calls `onStart` with the chosen `MatchConfig`. Pure view: owns no sim state,
 * imports only from `@/game/match`.
 *
 * Controls are segmented `.seg` buttons (map size / difficulty / resources) plus
 * a numeric seed input. Selections live in private fields; the DOM is built once
 * (idempotent `show()`) so returning from a finished match preserves choices.
 */

/** Tuple types for the three segmented controls — keys in display order. */
const MAP_KEYS = ["small", "medium", "large"] as const satisfies readonly MapSize[];
const DIFF_KEYS = ["easy", "medium", "hard"] as const satisfies readonly Difficulty[];
const RES_KEYS = ["low", "standard", "high"] as const satisfies readonly ResourceLevel[];

/** Human labels for difficulty (match.ts has no label table for these). */
const DIFF_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export class Lobby {
  // Current selections, seeded from the defaults.
  private mapSize: MapSize = "medium";
  private difficulty: Difficulty = DEFAULT_MATCH_CONFIG.difficulty;
  private resourceLevel: ResourceLevel = "standard";

  /** True once the form DOM + listeners are in place (so build runs once). */
  private built = false;
  /** Seed field, cached after build for reads on Start / dice. */
  private seedInput: HTMLInputElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly onStart: (config: MatchConfig) => void,
  ) {}

  /** Build the form (idempotent) and reveal the lobby. */
  show(): void {
    if (!this.built) this.build();
    this.root.hidden = false;
  }

  /** Hide the lobby (a match is starting / running). */
  hide(): void {
    this.root.hidden = true;
  }

  // ── build ────────────────────────────────────────────────────────────────

  /** Render the panel into `root` once and wire all listeners. */
  private build(): void {
    const seg = (
      name: string,
      keys: readonly string[],
      labelOf: (k: string) => string,
      active: string,
    ): string =>
      `<div class="seg" data-seg="${name}">` +
      keys
        .map(
          (k) =>
            `<button type="button" data-key="${k}" aria-pressed="${k === active}">` +
            `${labelOf(k)}</button>`,
        )
        .join("") +
      `</div>`;

    this.root.innerHTML =
      `<div class="panel">` +
      `<h1>Bronze Age</h1>` +
      `<p class="sub">Configure your match</p>` +
      // Map size
      `<div class="field">` +
      `<label>Map size</label>` +
      seg("map", MAP_KEYS, (k) => MAP_SIZES[k as MapSize].label, this.mapSize) +
      `</div>` +
      // AI difficulty
      `<div class="field">` +
      `<label>AI difficulty</label>` +
      seg("diff", DIFF_KEYS, (k) => DIFF_LABELS[k as Difficulty], this.difficulty) +
      `</div>` +
      // Starting resources
      `<div class="field">` +
      `<label>Starting resources</label>` +
      seg("res", RES_KEYS, (k) => RESOURCE_LEVELS[k as ResourceLevel].label, this.resourceLevel) +
      `</div>` +
      // Seed (number input + a dice button that fills a fresh value)
      `<div class="field">` +
      `<label>Seed</label>` +
      `<div class="seg">` +
      `<input type="number" data-action="seed" value="${DEFAULT_MATCH_CONFIG.seed}" step="1" />` +
      `<button type="button" class="seg" data-action="dice" title="Random seed" ` +
      `style="flex:0 0 auto">🎲</button>` +
      `</div>` +
      `</div>` +
      `<button class="primary" type="button" data-action="start">Start match</button>` +
      `</div>`;

    // Segmented controls: clicking a button updates aria-pressed + state.
    this.wireSeg("map", (k) => (this.mapSize = k as MapSize));
    this.wireSeg("diff", (k) => (this.difficulty = k as Difficulty));
    this.wireSeg("res", (k) => (this.resourceLevel = k as ResourceLevel));

    const seedInput = this.root.querySelector('[data-action="seed"]');
    if (seedInput instanceof HTMLInputElement) this.seedInput = seedInput;

    const dice = this.root.querySelector('[data-action="dice"]');
    if (dice instanceof HTMLButtonElement) {
      dice.addEventListener("click", () => {
        // View-only randomness — fine here (never touches the sim RNG).
        if (this.seedInput) this.seedInput.value = String((Math.random() * 0xffffffff) >>> 0);
      });
    }

    const start = this.root.querySelector('[data-action="start"]');
    if (start instanceof HTMLButtonElement) {
      start.addEventListener("click", () => this.onStart(this.buildConfig()));
    }

    this.built = true;
  }

  /**
   * Wire one segmented control: on click, mark the pressed button active, its
   * siblings inactive, and report the chosen key to `set`.
   */
  private wireSeg(name: string, set: (key: string) => void): void {
    const group = this.root.querySelector(`[data-seg="${name}"]`);
    if (!(group instanceof HTMLElement)) return;
    group.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const key = target.dataset["key"];
      if (key === undefined) return;
      for (const btn of group.querySelectorAll("button")) {
        btn.setAttribute("aria-pressed", String(btn === target));
      }
      set(key);
    });
  }

  // ── start ────────────────────────────────────────────────────────────────

  /** Assemble a fresh `MatchConfig` from the current selections. */
  private buildConfig(): MatchConfig {
    const size = MAP_SIZES[this.mapSize];
    const res = RESOURCE_LEVELS[this.resourceLevel].res;
    return {
      seed: this.readSeed(),
      mapW: size.w,
      mapH: size.h,
      difficulty: this.difficulty,
      startResources: { ...res }, // copy — caller must not alias the preset
    };
  }

  /** Parse the seed input as a uint32; fall back to the default if blank/NaN. */
  private readSeed(): number {
    const raw = this.seedInput?.value ?? "";
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_MATCH_CONFIG.seed;
    return Math.trunc(n) >>> 0;
  }
}
