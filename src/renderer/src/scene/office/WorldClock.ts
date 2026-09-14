import { Container, Graphics, Text } from 'pixi.js';
import type { Projection } from './projection';

// A small always-on wall prop showing two live timezones (China + Mexico
// City) — a scene-level fixture, not per-agent, so it mirrors the calendar/
// clock props built directly in OfficeFloor.tsx's init effect rather than
// DeskScreen's per-desk lifecycle. Digital text (not an analog face) since no
// clock-face tile art exists in any loaded atlas — see ToolBubble.ts for the
// same "monospace Text in a hand-drawn frame" technique this reuses.

const CN_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const MX_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Mexico_City',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Padding between the text and the frame edge. The frame itself is MEASURED
// from the rendered text rather than hard-coded: the first version fixed it at
// 34x20px, which fits "CN 09" and nothing more — the ":16" of every reading
// spilled past the dark panel onto the light wall behind it (pale text on pale
// tiles, effectively invisible) and the MX row was clipped outright.
const PAD_X = 3;
const PAD_Y = 2;

export class WorldClock {
  readonly container = new Container();
  private label: Text;
  private acc = 0;

  constructor(topLeft: { x: number; y: number }, projection: Projection) {
    this.label = new Text({
      text: '',
      style: { fontSize: 10, fontFamily: 'monospace', fill: '#fffdf5', align: 'left' },
    });
    // Fill in the real text BEFORE measuring — both lines are fixed-width
    // ("CN HH:MM"), so one measurement at construction holds for every tick.
    this.render();
    const textW = Math.ceil(this.label.width);
    const textH = Math.ceil(this.label.height);
    const frameW = textW + PAD_X * 2;
    const frameH = textH + PAD_Y * 2;
    const rowH = Math.max(1, Math.round(textH / 2));

    const frame = new Graphics();
    frame.rect(0, 0, frameW, frameH).fill(0x2a2334).stroke({ color: 0x1a1320, width: 1 });
    frame.rect(1, PAD_Y, frameW - 2, rowH).fill(0x1a1320);          // CN row background
    frame.rect(1, PAD_Y + rowH, frameW - 2, rowH).fill(0x1a1320);   // MX row background
    this.container.addChild(frame);

    this.label.position.set(PAD_X, PAD_Y);
    this.container.addChild(this.label);

    const at = projection.tileToWorld(topLeft.x, topLeft.y);
    this.container.position.set(at.x, at.y);
    // `+2` = the shared wall-prop depth rule (see the calendar in
    // OfficeFloor.tsx): a hanging prop spills a row below its own tile, so it
    // sorts against that row. Was a literal `rowDepth(3)`, correct only while
    // every theme's worldClock anchor sat on row 1.
    this.container.zIndex = projection.rowDepth(topLeft.y + 2);
    this.container.eventMode = 'none';
    this.render();
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < 1) return; // reformat at most once/sec — value only changes once/minute
    this.acc = 0;
    this.render();
  }

  private render(): void {
    const now = new Date();
    this.label.text = `CN ${CN_FMT.format(now)}\nMX ${MX_FMT.format(now)}`;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
