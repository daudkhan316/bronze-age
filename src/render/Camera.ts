import { ZOOM_MIN, ZOOM_MAX } from "@/config";
import { clamp } from "@/math/Vec2";

/**
 * The camera is pure VIEW state — deliberately NOT part of the ECS world or the
 * fixed simulation. It maps between world space (the projected iso plane, in
 * pixels at zoom 1) and screen space (CSS pixels). It updates at render
 * framerate so panning stays smooth regardless of the 20Hz sim tick, and it is
 * never serialized into save games.
 *
 *   screen = (world - cameraCentre) * zoom + viewportCentre
 */
export class Camera {
  /** World-space point shown at the centre of the viewport. */
  x = 0;
  y = 0;
  zoom = 1;

  /** Viewport size in CSS pixels. */
  viewW = 1;
  viewH = 1;

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  worldToScreen(wx: number, wy: number): { sx: number; sy: number } {
    return {
      sx: (wx - this.x) * this.zoom + this.viewW / 2,
      sy: (wy - this.y) * this.zoom + this.viewH / 2,
    };
  }

  screenToWorld(sx: number, sy: number): { wx: number; wy: number } {
    return {
      wx: (sx - this.viewW / 2) / this.zoom + this.x,
      wy: (sy - this.viewH / 2) / this.zoom + this.y,
    };
  }

  /** Move the camera by a screen-pixel delta (e.g. middle-drag). */
  panByScreen(dxScreen: number, dyScreen: number): void {
    this.x += dxScreen / this.zoom;
    this.y += dyScreen / this.zoom;
  }

  /** Move the camera by a world-space delta (e.g. keyboard/edge-scroll). */
  panByWorld(dxWorld: number, dyWorld: number): void {
    this.x += dxWorld;
    this.y += dyWorld;
  }

  /** Zoom by `factor`, keeping the world point under (sx, sy) fixed on screen. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    const after = this.screenToWorld(sx, sy);
    this.x += before.wx - after.wx;
    this.y += before.wy - after.wy;
  }

  /**
   * Keep the map within the viewport. The clamp range is the bounds inset by
   * half the visible world extent, so a map edge stops at the screen edge
   * rather than letting the camera centre reach the edge (which would leave
   * half the screen empty). When the map is smaller than the viewport on an
   * axis, the camera is pinned to the bounds midpoint so it stays centred.
   */
  clampToBounds(minX: number, minY: number, maxX: number, maxY: number): void {
    const halfVisW = this.viewW / 2 / this.zoom;
    const halfVisH = this.viewH / 2 / this.zoom;

    if (maxX - minX <= halfVisW * 2) {
      this.x = (minX + maxX) / 2;
    } else {
      this.x = clamp(this.x, minX + halfVisW, maxX - halfVisW);
    }

    if (maxY - minY <= halfVisH * 2) {
      this.y = (minY + maxY) / 2;
    } else {
      this.y = clamp(this.y, minY + halfVisH, maxY - halfVisH);
    }
  }
}
