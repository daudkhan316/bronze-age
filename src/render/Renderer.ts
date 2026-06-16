import type { Camera } from "@/render/Camera";
import type { GameMap } from "@/map/GameMap";
import { drawMap } from "@/render/drawMap";
import { BACKGROUND } from "@/render/colors";

/**
 * Owns the canvas 2D context and handles HiDPI scaling. All world drawing is
 * done in CSS pixels; the renderer applies the devicePixelRatio transform so
 * output stays crisp on Retina displays. Returns the CSS-pixel viewport size so
 * the camera and input layer can share one coordinate space.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  cssWidth = 1;
  cssHeight = 1;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("Renderer: 2D canvas context unavailable");
    this.canvas = canvas;
    this.ctx = ctx;
    this.resize();
  }

  /** Resize the backing store to match CSS size * devicePixelRatio. */
  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssWidth = this.canvas.clientWidth || window.innerWidth;
    this.cssHeight = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.cssWidth * this.dpr);
    this.canvas.height = Math.round(this.cssHeight * this.dpr);
  }

  /**
   * Draw a frame. The optional `overlay` is invoked after the terrain pass with
   * the (already DPR-scaled, CSS-pixel) context, so game-specific layers (units,
   * selection marquee, order pings) can draw on top without the Renderer having
   * to know about them.
   */
  render(
    camera: Camera,
    map: GameMap,
    showGrid: boolean,
    overlay?: (ctx: CanvasRenderingContext2D) => void,
  ): void {
    const ctx = this.ctx;
    // Reset transform, then scale so 1 unit == 1 CSS pixel.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    drawMap(ctx, camera, map, showGrid);

    if (overlay !== undefined) overlay(ctx);
  }
}
