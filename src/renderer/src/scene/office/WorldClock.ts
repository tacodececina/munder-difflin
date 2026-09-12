import { Container, Graphics, Text } from 'pixi.js';

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

const FRAME_W = 34;
const FRAME_H = 20;

export class WorldClock {
  readonly container = new Container();
  private label: Text;
  private acc = 0;

  constructor(topLeft: { x: number; y: number }, tileSize: number) {
    const frame = new Graphics();
    frame.rect(0, 0, FRAME_W, FRAME_H).fill(0x2a2334).stroke({ color: 0x1a1320, width: 1 });
    frame.rect(1, 1, FRAME_W - 2, 7).fill(0x1a1320);  // CN row background
    frame.rect(1, 11, FRAME_W - 2, 7).fill(0x1a1320); // MX row background
    this.container.addChild(frame);

    this.label = new Text({
      text: '',
      style: { fontSize: 10, fontFamily: 'monospace', fill: '#fffdf5', align: 'left' },
    });
    this.label.position.set(3, 2);
    this.container.addChild(this.label);

    this.container.position.set(topLeft.x * tileSize, topLeft.y * tileSize);
    this.container.zIndex = 3 * tileSize;
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
