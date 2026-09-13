import { useEffect, useState } from 'react';
import { bp, type BreakpointBand } from '@/design/tokens';

export interface BreakpointState {
  width: number;
  height: number;
  band: BreakpointBand;
  /** True when the viewport is short enough that vertical chrome (title bar,
   *  panel headers, the agent strip) should shed padding rather than crowd the
   *  content beneath it — see the `< 700px` height rules in design/layout.css. */
  short: boolean;
}

/** Viewport height below which `short` flips true. Not part of `bp` (design/
 *  tokens.ts) because that scale is a WIDTH axis — bands are about horizontal
 *  room (does the strip/sidebar/scene fit side by side), this is the
 *  orthogonal vertical one (is there room for full-height chrome padding). */
const SHORT_HEIGHT = 700;

function bandFor(width: number): BreakpointBand {
  if (width < bp.compact) return 'compact';
  if (width >= bp.wide) return 'wide';
  return 'cozy';
}

function read(): BreakpointState {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return { width, height, band: bandFor(width), short: height < SHORT_HEIGHT };
}

// Module-scope singleton: every component calling useBreakpoint() shares ONE
// `resize` listener and one cached reading, rather than each mounting its own.
// App.tsx used to keep its own `vpWidth` state + resize listener just for the
// SidebarSplitter clamp; that measurement now flows through here too, so the
// app has exactly one place that watches window size, not two that could
// drift a frame apart from each other.
let current: BreakpointState | null = null;
const listeners = new Set<(s: BreakpointState) => void>();
let attached = false;

function handleResize(): void {
  const next = read();
  const prev = current;
  if (prev && prev.width === next.width && prev.height === next.height) return;
  current = next;
  for (const l of listeners) l(next);
}

function ensureListener(): void {
  if (attached) return;
  attached = true;
  current = read();
  window.addEventListener('resize', handleResize);
}

/**
 * Subscribes to the window's size and returns its current width/height, which
 * named layout band (`compact` / `cozy` / `wide`, see `bp` in
 * design/tokens.ts) the width falls into, and whether the height is short
 * enough to shed vertical chrome padding. Backs every width/height-driven
 * layout decision in AppShell.tsx and what it renders directly — AgentStrip's
 * portraits-only collapse, AgentDetailPanel's overlay mode, the title bar and
 * header padding reductions.
 *
 * Purely a WINDOW measurement. A region that resizes independently of the
 * window (the sidebar via SidebarSplitter, without the window changing) is a
 * job for a CSS `@container` query instead — see `.cth-detail-col` in
 * design/layout.css — not for this hook.
 */
export function useBreakpoint(): BreakpointState {
  ensureListener();
  const [state, setState] = useState<BreakpointState>(() => current ?? read());
  useEffect(() => {
    ensureListener();
    // The very first render above may have run before `current` existed (or
    // before this module was reached at all in a fresh test/SSR context) —
    // resync once on mount, then just listen.
    setState(current ?? read());
    listeners.add(setState);
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}
