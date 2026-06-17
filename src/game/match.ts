/**
 * Match configuration + presets (Phase 5). Pure data — no imports from the ECS
 * world, so `components.ts` can import the `Difficulty` type without a cycle.
 *
 * A `MatchConfig` is produced by the lobby and handed to `Game` to seed a fresh
 * match: map dimensions, the world seed, the AI difficulty, and how many
 * resources each player starts with.
 */

import { DEFAULT_SEED, DEFAULT_MAP_W, DEFAULT_MAP_H } from "@/config";

export type Difficulty = "easy" | "medium" | "hard";
export type MapSize = "small" | "medium" | "large";
export type ResourceLevel = "low" | "standard" | "high";

/** Starting stockpile for a player (matches the four ResourceKinds by name). */
export interface StartResources {
  food: number;
  wood: number;
  gold: number;
  stone: number;
}

export interface MatchConfig {
  seed: number;
  mapW: number;
  mapH: number;
  difficulty: Difficulty;
  startResources: StartResources;
}

/** Tuning knobs the AI reads per difficulty (consumed by AiSystem). */
export interface AiParams {
  /** Ticks between AI decision passes (lower = reacts faster). */
  thinkInterval: number;
  /** Villagers the AI tries to reach before leaning on military. */
  villagerTarget: number;
  /** Army size (military units) the AI masses before pushing out to attack. */
  armyThreshold: number;
  /** Whether this difficulty also builds an Archery Range (mixed army). */
  buildArcheryRange: boolean;
  /** Cap on each military unit type so training doesn't run forever. */
  maxMilitaryPerType: number;
}

export const MAP_SIZES: Record<MapSize, { w: number; h: number; label: string }> = {
  small: { w: 48, h: 48, label: "Small (48×48)" },
  medium: { w: DEFAULT_MAP_W, h: DEFAULT_MAP_H, label: "Medium (64×64)" },
  large: { w: 96, h: 96, label: "Large (96×96)" },
};

export const RESOURCE_LEVELS: Record<ResourceLevel, { res: StartResources; label: string }> = {
  low: { res: { food: 100, wood: 100, gold: 50, stone: 50 }, label: "Low" },
  standard: { res: { food: 200, wood: 200, gold: 100, stone: 100 }, label: "Standard" },
  high: { res: { food: 500, wood: 500, gold: 300, stone: 300 }, label: "High" },
};

export const AI_PARAMS: Record<Difficulty, AiParams> = {
  easy: { thinkInterval: 30, villagerTarget: 7, armyThreshold: 4, buildArcheryRange: false, maxMilitaryPerType: 6 },
  medium: { thinkInterval: 20, villagerTarget: 11, armyThreshold: 7, buildArcheryRange: true, maxMilitaryPerType: 10 },
  hard: { thinkInterval: 12, villagerTarget: 13, armyThreshold: 9, buildArcheryRange: true, maxMilitaryPerType: 16 },
};

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  seed: DEFAULT_SEED,
  mapW: DEFAULT_MAP_W,
  mapH: DEFAULT_MAP_H,
  difficulty: "medium",
  startResources: RESOURCE_LEVELS.standard.res,
};
