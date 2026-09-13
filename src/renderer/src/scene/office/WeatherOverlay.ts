import { Container, Graphics } from 'pixi.js';
import type { Weather } from './weather';

/**
 * The sky, drawn. A screen-space layer that sits above the world container and
 * tints the floor (plus rain, when it rains) according to the weather derived in
 * weather.ts from the circuit breaker.
 *
 * Deliberately inert:
 *   - `eventMode = 'none'` + `interactiveChildren = false`, so it can never
 *     swallow a click meant for a desk, an avatar or the wall calendar;
 *   - it reads a Weather enum and nothing else — it holds no agent, no store and
 *     no callback, so there is no path from here back into anyone's behavior;
 *   - when the sky is clear it hides itself and does zero work per frame.
 *
 * Two Graphics total (one tint quad, one batched rain pass), so the whole
 * feature costs a couple of draw calls even in a downpour. It lives on the app
 * ticker, so a paused floor (fullscreen terminal, hidden window) freezes it
 * along with everything else.
 */

/** Target look per weather. Alphas are deliberately gentle — the floor has to
 *  stay readable in the rain; this is a mood, not a curtain. */
const SKY: Record<Weather, { color: number; alpha: number; drops: number }> = {
  clear:    { color: 0x223049, alpha: 0,    drops: 0 },
  overcast: { color: 0x2b3554, alpha: 0.17, drops: 0 },
  rain:     { color: 0x161f36, alpha: 0.30, drops: 120 }
};

/** Alpha units per second — a weather change reads as the light shifting over
 *  ~2 s rather than a jump cut. */
const FADE_PER_SEC = 0.16;
/** Drops added/removed per second while the rain arrives or clears. */
const DROP_RAMP_PER_SEC = 110;
/** Per-drop fall speed range, px/s (screen space). */
const SPEED_MIN = 260;
const SPEED_MAX = 430;
/** Horizontal drift as a fraction of fall speed — wind, always one way. */
const SLANT = 0.26;
const DROP_COLOR = 0xbcd4f0;
const DROP_ALPHA = 0.5;

interface Drop {
  x: number;
  y: number;
  /** px/s downward. */
  vy: number;
  /** streak length in px. */
  len: number;
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);

export class WeatherOverlay {
  readonly container = new Container();
  private tint = new Graphics();
  private rain = new Graphics();
  private w = 0;
  private h = 0;
  private weather: Weather = 'clear';
  /** Current (animated) values, chasing SKY[this.weather]. */
  private alpha = 0;
  private color = SKY.clear.color;
  private drops: Drop[] = [];
  /** Fractional carry so the ramp is frame-rate independent. */
  private dropCarry = 0;

  constructor(viewWidth = 0, viewHeight = 0) {
    this.container.eventMode = 'none';
    this.container.interactiveChildren = false;
    this.container.visible = false;
    this.tint.eventMode = 'none';
    this.rain.eventMode = 'none';
    this.container.addChild(this.tint, this.rain);
    this.setViewSize(viewWidth, viewHeight);
  }

  /** Follow the canvas. Called on mount and from the floor's ResizeObserver. */
  setViewSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.w = width;
    this.h = height;
    // One white quad, recolored via `tint` — no redraw when the weather shifts.
    this.tint.clear();
    this.tint.rect(0, 0, width, height).fill(0xffffff);
    this.tint.tint = this.color;
    this.tint.alpha = this.alpha;
    for (const d of this.drops) {
      if (d.x > width) d.x = Math.random() * width;
      if (d.y > height) d.y = -d.len;
    }
  }

  /** Set the target sky. Cheap and idempotent — safe to call every frame. */
  setWeather(weather: Weather): void {
    this.weather = weather;
  }

  /** Advance the animation. `dt` is seconds (the floor's ticker delta). */
  update(dt: number, weather?: Weather): void {
    if (weather) this.weather = weather;
    const target = SKY[this.weather] ?? SKY.clear;

    // Nothing showing and nothing wanted: stay hidden, skip the frame entirely.
    if (this.alpha <= 0.001 && target.alpha <= 0 && this.drops.length === 0) {
      if (this.container.visible) {
        this.container.visible = false;
        this.rain.clear();
      }
      return;
    }
    this.container.visible = true;

    // ── light ────────────────────────────────────────────────────────────────
    const step = FADE_PER_SEC * dt;
    if (this.alpha < target.alpha) this.alpha = Math.min(target.alpha, this.alpha + step);
    else if (this.alpha > target.alpha) this.alpha = Math.max(target.alpha, this.alpha - step);
    // Chase the target hue on the same schedule so overcast→rain darkens rather
    // than snapping to a different color mid-fade.
    this.color = lerpColor(this.color, target.color, Math.min(1, dt * 2));
    this.tint.tint = this.color;
    this.tint.alpha = this.alpha;

    // ── rain ─────────────────────────────────────────────────────────────────
    this.rampDrops(target.drops, dt);
    if (this.drops.length === 0) {
      this.rain.clear();
      return;
    }
    const spread = this.w + this.h * SLANT;
    for (const d of this.drops) {
      d.y += d.vy * dt;
      d.x += d.vy * SLANT * dt;
      if (d.y > this.h || d.x > this.w + 8) {
        d.y = -d.len - Math.random() * 40;
        d.x = Math.random() * spread - this.h * SLANT;
        d.vy = rand(SPEED_MIN, SPEED_MAX);
      }
    }
    // All streaks in ONE path + ONE fill: a downpour is a single batch.
    this.rain.clear();
    for (const d of this.drops) this.rain.rect(Math.round(d.x), Math.round(d.y), 1, d.len);
    this.rain.fill({ color: DROP_COLOR, alpha: DROP_ALPHA * (this.alpha / SKY.rain.alpha) });
  }

  /** Move the drop count toward `want` at a fixed rate (rain arrives, it does
   *  not appear). Spawns above the top edge so the onset falls INTO frame. */
  private rampDrops(want: number, dt: number): void {
    const have = this.drops.length;
    if (have === want) { this.dropCarry = 0; return; }
    this.dropCarry += DROP_RAMP_PER_SEC * dt;
    const move = Math.floor(this.dropCarry);
    if (move <= 0) return;
    this.dropCarry -= move;
    if (have < want) {
      const spread = this.w + this.h * SLANT;
      for (let i = 0; i < Math.min(move, want - have); i++) {
        this.drops.push({
          x: Math.random() * spread - this.h * SLANT,
          y: -Math.random() * this.h - 4,
          vy: rand(SPEED_MIN, SPEED_MAX),
          len: 4 + Math.floor(Math.random() * 5)
        });
      }
    } else {
      this.drops.length = Math.max(want, have - move);
    }
  }

  destroy(): void {
    this.drops.length = 0;
    this.container.destroy({ children: true });
  }
}

/** Channel-wise lerp between two 0xRRGGBB colors. */
function lerpColor(from: number, to: number, t: number): number {
  if (from === to) return to;
  const fr = (from >> 16) & 0xff, fg = (from >> 8) & 0xff, fb = from & 0xff;
  const tr = (to >> 16) & 0xff, tg = (to >> 8) & 0xff, tb = to & 0xff;
  const r = Math.round(fr + (tr - fr) * t);
  const g = Math.round(fg + (tg - fg) * t);
  const b = Math.round(fb + (tb - fb) * t);
  return (r << 16) | (g << 8) | b;
}
