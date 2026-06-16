import type { Terrain } from "@/map/Terrain";

/** Flat placeholder palette (CC0 — plain hex, no external assets). */
export interface TileColors {
  readonly top: string;
  readonly edge: string;
}

export const TERRAIN_COLORS: Record<Terrain, TileColors> = {
  grass: { top: "#5a8b3c", edge: "#4a7531" },
  water: { top: "#2f6d9e", edge: "#285c86" },
  forest: { top: "#2f5d2a", edge: "#264b22" },
  hills: { top: "#7a8b3c", edge: "#677531" },
  stone: { top: "#9aa0a6", edge: "#7f858a" },
  gold: { top: "#c9a227", edge: "#a8871f" },
};

export const BACKGROUND = "#0b0d10";
export const GRID_LINE = "rgba(0,0,0,0.25)";
