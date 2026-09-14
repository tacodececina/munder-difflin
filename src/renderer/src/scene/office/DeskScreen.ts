import { Container, Graphics, Sprite } from 'pixi.js';
import { monitorDisplayGid } from './deskVisuals';
import type { TiledMapRenderer } from './TiledMapRenderer';
import type { MonitorConfig } from './themeRegistry';

// The office tileset ships every desk PC twice: a dark, switched-off monitor
// (gids 365/366 + 381/382 — what the map paints) and the SAME monitor with a
// lit blue desktop (367/368 + 383/384). DeskScreen overlays the lit variant on
// a desk's monitor block while its agent is seated, plus a tiny screen-life
// animation (scrolling lines + a blinking cursor) so the PC visibly works when
// its owner does. Hidden, the map's off art shows through — no state to undo.

/** gid of the OFF monitor block's top-left tile, as painted in the office map.
 *  Default for the office theme; a theme supplies its own via MonitorConfig. */
export const MONITOR_OFF_TOPLEFT_GID = 365;
/** Matching ON tiles for the office theme, laid out 2×2 directly right of the
 *  off block — used when no per-theme MonitorConfig is passed. */
const DEFAULT_ON_GIDS: ReadonlyArray<readonly [number, number, number]> = [
  // [gid, dx, dy] in tiles relative to the block's top-left
  [367, 0, 0], [368, 1, 0],
  [383, 0, 1], [384, 1, 1]
];

/** Screen interior of the 2×2 (32×32px) block, in local pixels — where the
 *  blue desktop is drawn in the tile art. The animation stays inside it. */
const SCREEN = { x: 3, y: 5, w: 25, h: 12 };

export class DeskScreen {
  readonly container = new Container();
  private anim = new Graphics();
  private on = false;
  private t = 0;
  private reducedMotion = false;

  constructor(mapRenderer: TiledMapRenderer, topLeft: { x: number; y: number }, monitor?: MonitorConfig, private visualOffset = 0) {
    const proj = mapRenderer.projection;
    const onGids = monitor?.onGids ?? DEFAULT_ON_GIDS;
    for (const [gid, dx, dy] of onGids) {
      const tex = mapRenderer.textureForGid(monitorDisplayGid(gid, visualOffset));
      if (!tex) continue;
      const s = new Sprite(tex);
      // (dx,dy) is a tile OFFSET inside the block; the projection is linear and
      // pins tile (0,0) at the origin, so converting the offset is the same
      // operation as converting a tile.
      const off = proj.tileToWorld(dx, dy);
      s.x = off.x;
      s.y = off.y;
      this.container.addChild(s);
    }
    this.anim.eventMode = 'none';
    this.container.addChild(this.anim);
    const at = proj.tileToWorld(topLeft.x, topLeft.y);
    this.container.x = at.x;
    this.container.y = at.y;
    // Sort with the characters: the block's bottom edge sits above the seated
    // agent's anchor row, so the avatar's head draws over the keyboard, not
    // under it — same painter's order the map art implies.
    this.container.zIndex = proj.rowDepth(topLeft.y + 2) - 1;
    this.container.visible = false;
    this.container.eventMode = 'none';
  }

  /** Light the screen (agent sat down) or cut it (stood up / left). */
  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.container.visible = on;
    if (!on) { this.anim.clear(); this.t = 0; }
  }

  /** Keep the real on/off monitor state while removing its continuous screen
   *  line animation from the opt-in software economy mode. */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      this.t = 0;
      this.anim.clear();
    }
  }

  update(dt: number): void {
    if (!this.on) return;
    if (this.visualOffset > 0 || this.reducedMotion) return; // Rear panel: only its status LED is visible.
    this.t += dt;
    const g = this.anim;
    g.clear();
    // Two faint "output" lines scrolling up the desktop, wrapping around —
    // the eternal build log — plus a cursor blinking in the lower left.
    for (let i = 0; i < 2; i++) {
      const phase = (this.t * 3.2 + i * (SCREEN.h / 2)) % SCREEN.h;
      const y = SCREEN.y + SCREEN.h - 1 - phase;
      const w = 6 + ((i * 7 + Math.floor(this.t / 1.7)) % 9);
      g.rect(SCREEN.x + 2, Math.round(y), w, 1).fill({ color: 0xcfe6ff, alpha: 0.55 });
    }
    if (Math.floor(this.t / 0.53) % 2 === 0) {
      g.rect(SCREEN.x + 2, SCREEN.y + SCREEN.h - 2, 2, 2).fill({ color: 0xffffff, alpha: 0.9 });
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
