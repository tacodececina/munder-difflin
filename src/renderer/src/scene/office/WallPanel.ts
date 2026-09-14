import { Container, Sprite, Texture } from 'pixi.js';
import type { Projection } from './projection';
import type { PixelBuffer } from './techOfficeArt';

/**
 * One live instrument surface, composited over a baked prop.
 *
 * The office's two wall instruments (the operations display, the planning
 * whiteboard) are ordinary tiles in the procedural atlas — their bezel, glass
 * and header are stamped into the tileset once at mount. What they SAY changes,
 * and repainting a shared atlas to move a bar would repaint every copy of every
 * prop that borrows those pixels. So the chrome stays in the atlas and the
 * reading is one small sprite pinned over the region the art leaves empty.
 *
 * A sprite backed by a 2D canvas, rather than a Graphics of rectangles like the
 * calendar and the cork boards: the readings are drawn by techOfficeArt's own
 * `rectOn`/`textOn` into an RGBA buffer, in the same palette and the same
 * three-pixel alphabet as the prop underneath. Using the art file's primitives
 * is the point — it is the difference between an overlay that belongs to the
 * furniture and one that looks like UI parked on top of it.
 *
 * ONE canvas and ONE texture for the lifetime of the panel. `paint` re-uploads
 * in place; nothing here allocates per repaint, and repaints are rare anyway
 * (the data behind them moves on a 5 s / 60 s / 5 min cadence).
 */
export class WallPanel {
  readonly container = new Container();
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly texture: Texture | null;

  /**
   * @param topLeft   the prop's top-left TILE (the theme anchor).
   * @param rect      the live region in PROP-LOCAL pixels — techOfficeArt's
   *                  OPS_READOUT_RECT / PLAN_READOUT_RECT.
   * @param projection the scene's one projection; tile → world and depth both
   *                  come from it, so this stays correct if the floor is ever
   *                  drawn on another grid.
   * @param depthRow  the tile row the panel sorts on. A wall instrument must
   *                  draw over the wall it hangs on and under anyone standing
   *                  in front of it, so this is the prop's LAST row, not its
   *                  anchor row — see the calendar's depth note in OfficeFloor.
   */
  constructor(
    topLeft: { x: number; y: number },
    rect: { x: number; y: number; w: number; h: number },
    projection: Projection,
    depthRow: number
  ) {
    this.canvas.width = rect.w;
    this.canvas.height = rect.h;
    this.ctx = this.canvas.getContext('2d');
    this.texture = this.ctx ? Texture.from(this.canvas) : null;
    if (this.texture) {
      this.texture.source.scaleMode = 'nearest';
      this.container.addChild(new Sprite(this.texture));
    }
    const at = projection.tileToWorld(topLeft.x, topLeft.y);
    this.container.x = at.x + rect.x;
    this.container.y = at.y + rect.y;
    this.container.zIndex = projection.rowDepth(depthRow);
    // A READOUT, like the weather: pointer-inert, so the prop underneath keeps
    // whatever click behaviour it had (today: none) and this can never swallow
    // a tap meant for an avatar walking past it.
    this.container.eventMode = 'none';
  }

  /** Upload one freshly drawn buffer. Silently does nothing without a 2D
   *  context — the same degradation every other canvas path in this scene
   *  takes, and a missing readout is better than a thrown mount. */
  paint(buffer: PixelBuffer): void {
    if (!this.ctx || !this.texture) return;
    const image = this.ctx.createImageData(buffer.width, buffer.height);
    image.data.set(buffer.data);
    this.ctx.putImageData(image, 0, 0);
    this.texture.source.update();
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.texture?.destroy(true);
  }
}
