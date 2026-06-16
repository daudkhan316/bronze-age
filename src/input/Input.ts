import { WHEEL_LINE_PX } from "@/config";

/**
 * Centralised input state. Listeners write into plain fields; the game reads
 * them once per frame. Per-frame deltas (wheel, middle-drag, just-pressed keys)
 * are accumulated and cleared by `endFrame()`, so a fast-moving mouse wheel or
 * a drag spanning several events is never lost between frames.
 *
 * Keys are tracked by `KeyboardEvent.code` (layout-independent: "KeyW",
 * "ArrowUp", "Space", ...).
 */
export class Input {
  private readonly held = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private readonly buttons = new Set<number>();
  private readonly pressedButtons = new Set<number>();
  private readonly releasedButtons = new Set<number>();

  /** Mouse position in CSS pixels relative to the canvas top-left. */
  mouseX = 0;
  mouseY = 0;
  /** Whether the pointer is currently over the canvas (for edge-scroll). */
  pointerInside = false;

  private wheelAccum = 0;
  private dragX = 0;
  private dragY = 0;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    target.addEventListener("mousemove", this.onMouseMove);
    target.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    target.addEventListener("mouseenter", this.onMouseEnter);
    target.addEventListener("mouseleave", this.onMouseLeave);
    target.addEventListener("wheel", this.onWheel, { passive: false });
    target.addEventListener("contextmenu", this.onContextMenu);
  }

  isKeyDown(code: string): boolean {
    return this.held.has(code);
  }

  /** True if the key transitioned to down during the frame just gone. */
  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  isButtonDown(button: number): boolean {
    return this.buttons.has(button);
  }

  /** True if `button` transitioned to down during the frame just gone. */
  wasButtonPressed(button: number): boolean {
    return this.pressedButtons.has(button);
  }

  /** True if `button` transitioned to up during the frame just gone. */
  wasButtonReleased(button: number): boolean {
    return this.releasedButtons.has(button);
  }

  /** Accumulated wheel deltaY since last frame (negative = scroll up). */
  consumeWheel(): number {
    const w = this.wheelAccum;
    this.wheelAccum = 0;
    return w;
  }

  /** Accumulated middle-drag movement (CSS px) since last frame. */
  consumeDrag(): { x: number; y: number } {
    const d = { x: this.dragX, y: this.dragY };
    this.dragX = 0;
    this.dragY = 0;
    return d;
  }

  /** Clear per-frame state. Call once at the end of every rendered frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.pressedButtons.clear();
    this.releasedButtons.clear();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.target.removeEventListener("mousemove", this.onMouseMove);
    this.target.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.target.removeEventListener("mouseenter", this.onMouseEnter);
    this.target.removeEventListener("mouseleave", this.onMouseLeave);
    this.target.removeEventListener("wheel", this.onWheel);
    this.target.removeEventListener("contextmenu", this.onContextMenu);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.held.has(e.code)) this.pressedThisFrame.add(e.code);
    this.held.add(e.code);
    // Stop the page from scrolling on arrows/space.
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private onBlur = (): void => {
    // Losing focus drops all transient state so nothing "sticks" while the
    // window is in the background. pointerInside matters because alt-tab fires
    // blur but NOT mouseleave, which would otherwise leave edge-scroll panning
    // with a stale cursor position the user can't see or stop.
    this.held.clear();
    this.buttons.clear();
    this.pointerInside = false;
    this.dragX = 0;
    this.dragY = 0;
  };

  private onMouseMove = (e: MouseEvent): void => {
    const rect = this.target.getBoundingClientRect();
    this.mouseX = e.clientX - rect.left;
    this.mouseY = e.clientY - rect.top;
    if (this.buttons.has(1)) {
      this.dragX += e.movementX;
      this.dragY += e.movementY;
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    this.buttons.add(e.button);
    this.pressedButtons.add(e.button);
    if (e.button === 1) e.preventDefault(); // suppress middle-click autoscroll
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.buttons.delete(e.button);
    this.releasedButtons.add(e.button);
  };

  private onMouseEnter = (): void => {
    this.pointerInside = true;
  };

  private onMouseLeave = (): void => {
    this.pointerInside = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Normalize to pixels: Firefox/line-mode reports deltaY in lines (~a few
    // per notch), page-mode in pages. Without this, zoom is near-dead on
    // browsers that don't use pixel deltas.
    const unit =
      e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? this.target.clientHeight : 1;
    this.wheelAccum += e.deltaY * unit;
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };
}
