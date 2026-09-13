import { Container, Graphics } from 'pixi.js';
import { deskHistoryFor, sameDesk, EMPTY_DESK, type DeskHistory, type DeskPropKind } from './deskHistory';

/**
 * The trinket row on one agent's desk — the drawn half of `deskHistory.ts`.
 *
 * WHERE IT SITS. Every standard desk in every shipped map is the same 3-tile
 * stamp: a 2×2 PC block (gids 365/366/381/382) with one free tile of desk
 * surface to its LEFT, and the chair directly below the block. `DeskScreen`
 * owns the block, `Character.setCupSpot` owns the mug spot at its right edge,
 * and the wall boards' "taken note" already lands flat on that free left tile
 * (OfficeFloor.tsx's `drawTaskBoard`). This class claims the BACK of the same
 * tile: five standing slots, 3px apart, resting on a baseline just above where
 * the note lies. That is the whole reason the ladder caps at five — it is the
 * widest honest row that fits on a 16px desk without climbing onto the
 * keyboard.
 *
 * WHY IT IS A Graphics AND NOT TILE ART. The props are procedural pixels drawn
 * straight into the character layer, exactly like the cork boards, the archive
 * pile, the world clock and the desk mug. No tileset gid, no atlas slot, no
 * theme entry: every theme's desks get their history for free, including the
 * custom/imported ones, and no map or tileset had to change to add this.
 *
 * WHY IT COSTS NOTHING. The drawing is static — repainted only when the ledger
 * actually moves an agent to a new rung (`sameDesk` guards the repaint), never
 * per frame. There is no ticker hook, no subscription and no timer in here.
 */

/** Local pixel baseline the props stand on, measured from the desk tile's top
 *  edge. Sits just above the row the board notes lie on (+8), so a taken note
 *  reads as lying in FRONT of the trinkets rather than through them. */
const BASE_Y = 8;
/** Left inset + horizontal pitch between slots (5 slots × 3px + 1px inset = 16px,
 *  the exact width of the free desk tile). */
const INSET_X = 1;
const PITCH_X = 3;

/** Paint one prop with its bottom-left corner at (x, BASE_Y). */
function paintProp(g: Graphics, kind: DeskPropKind, x: number, sheets: number): void {
  const b = BASE_Y;
  switch (kind) {
    case 'papers': {
      // A leaning pile — one sheet per closure past the last milestone, so the
      // desk of someone who never stops still visibly keeps filling.
      for (let s = 0; s < Math.max(1, sheets); s++) {
        g.rect(x + (s % 2), b - 1 - s, 3, 1).fill(s === Math.max(1, sheets) - 1 ? 0xf6f0de : 0xe3dbc2);
      }
      break;
    }
    case 'plant':
      g.rect(x, b - 2, 3, 2).fill(0xa9603c);        // terracotta pot
      g.rect(x, b - 4, 3, 2).fill(0x5f9e52);        // foliage
      g.rect(x + 1, b - 5, 1, 1).fill(0x76b862);    // one proud shoot
      break;
    case 'photo':
      g.rect(x, b - 5, 3, 5).fill(0x8a6f4d);        // wooden frame
      g.rect(x, b - 4, 3, 3).fill(0xcfe6ff);        // the picture
      break;
    case 'plantBig':
      g.rect(x, b - 3, 3, 3).fill(0x9a5636);
      g.rect(x, b - 6, 3, 3).fill(0x4e8a45);
      g.rect(x + 1, b - 8, 1, 2).fill(0x6fae60);
      break;
    case 'trophy':
      g.rect(x, b - 2, 3, 2).fill(0x6e5639);        // plinth
      g.rect(x + 1, b - 4, 1, 2).fill(0xe8c14d);    // stem
      g.rect(x, b - 7, 3, 3).fill(0xe8c14d);        // cup
      g.rect(x, b - 7, 1, 1).fill(0xfff0b0);        // glint
      break;
  }
}

export class DeskShelf {
  readonly container = new Container();
  private g = new Graphics();
  private shown: DeskHistory = EMPTY_DESK;

  /** `deskTile` is the FREE desk-surface tile (the seat tile shifted one left
   *  and one up) — the caller resolves it, since only it knows the map stamp. */
  constructor(deskTile: { x: number; y: number }, tileSize: number) {
    this.g.eventMode = 'none';
    this.container.addChild(this.g);
    this.container.eventMode = 'none';
    this.container.interactiveChildren = false;
    this.container.position.set(deskTile.x * tileSize, deskTile.y * tileSize);
    // Behind the taken-note (seat row −1) and behind the monitor overlay, so a
    // note laid on the desk and the PC itself both draw over the trinkets.
    this.container.zIndex = (deskTile.y + 1) * tileSize - 2;
    this.container.visible = false;
  }

  /** Point the desk at a closed-task count. Cheap to call on every poll. */
  setDoneCount(done: number): void {
    this.apply(deskHistoryFor(done));
  }

  /** What the desk is currently showing — for tests and for callers that want
   *  to know whether a milestone was just crossed. */
  current(): DeskHistory {
    return this.shown;
  }

  private apply(next: DeskHistory): void {
    if (sameDesk(next, this.shown)) { this.shown = next; return; }
    this.shown = next;
    this.g.clear();
    if (next.props.length === 0) { this.container.visible = false; return; }
    this.container.visible = true;
    next.props.forEach((kind, i) => {
      paintProp(this.g, kind, INSET_X + i * PITCH_X, next.sheets);
    });
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
