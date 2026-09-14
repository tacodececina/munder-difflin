import type { Projection, Point } from './projection';
import { deskDisplayTop } from './deskVisuals';

export type FloorRoom = 'operations' | 'engineering' | 'briefing' | 'deployments' | 'rest';
export type FloorInteractionKind = 'agent' | 'desk' | 'screen' | 'room';

export type FloorInspectionTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'desk' | 'screen'; seatId: string; agentId?: string | null }
  | { kind: 'room'; room: FloorRoom };

export interface FloorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloorInteractionTarget {
  id: string;
  kind: FloorInteractionKind;
  /** Higher priority wins when a visual target overlaps a room. */
  priority: number;
  bounds: FloorRect;
  target: FloorInspectionTarget;
}

export interface FloorReadingInfo {
  source: string;
  scope: string;
  availability: 'available' | 'unavailable';
  lastValidAt: number | null;
}

export interface FloorInspectionTask {
  id: string;
  title: string | null;
  status: string | null;
  assignee: string | null;
}

export interface FloorInspectionBreaker {
  info: FloorReadingInfo;
  readings: Array<{ agentId: string; level: string; ts: number }> | null;
}

export interface FloorInspectionCI {
  info: FloorReadingInfo;
  repo: string | null;
  runs: Array<{ name: string | null; status: string | null; conclusion: string | null; url: string | null }> | null;
}

export interface FloorInspectionHandoff {
  id: string | null;
  from: string | null;
  to: string | null;
  act: string | null;
  createdAt: number | null;
}

export interface FloorInspectionSnapshot {
  capturedAt: number;
  breaker: FloorInspectionBreaker;
  tasks: FloorInspectionTask[] | null;
  taskReading: FloorReadingInfo;
  ci: FloorInspectionCI;
  handoffs: { info: FloorReadingInfo; items: FloorInspectionHandoff[] | null };
  conversationsEnabled: boolean;
}

export interface FloorInspectionEventDetail {
  target: FloorInspectionTarget;
  snapshot: FloorInspectionSnapshot;
}

function validRect(rect: FloorRect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function contains(rect: FloorRect, point: Point): boolean {
  return validRect(rect) && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;
}

/**
 * The Pixi stage is projected world space, not logical tile space. This helper
 * deliberately projects all four tile corners so an isometric map gets a
 * conservative screen-space rectangle too.
 */
export function projectedTileRect(
  projection: Pick<Projection, 'tileToWorld' | 'tileWidth' | 'tileHeight'>,
  rect: { x: number; y: number; width: number; height: number },
  padding = 0,
): FloorRect {
  const corners = [
    projection.tileToWorld(rect.x, rect.y),
    projection.tileToWorld(rect.x + rect.width - 1, rect.y),
    projection.tileToWorld(rect.x, rect.y + rect.height - 1),
    projection.tileToWorld(rect.x + rect.width - 1, rect.y + rect.height - 1),
  ];
  const minX = Math.min(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxX = Math.max(...corners.map((p) => p.x)) + projection.tileWidth;
  const maxY = Math.max(...corners.map((p) => p.y)) + projection.tileHeight;
  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2),
  };
}

/** The entire visual desk stamp, including the monitor block and surface. */
export function deskVisualRect(
  projection: Pick<Projection, 'tileToWorld' | 'tileWidth' | 'tileHeight'>,
  seat: Point,
  monitorOffsetY = 0,
): FloorRect {
  return projectedTileRect(projection, {
    x: seat.x,
    y: deskDisplayTop(seat, monitorOffsetY).y,
    width: 2,
    height: 3,
  }, 2);
}

/** A smaller, higher-priority target for the monitor itself. */
export function screenVisualRect(
  projection: Pick<Projection, 'tileToWorld' | 'tileWidth' | 'tileHeight'>,
  seat: Point,
  monitorOffsetY = 0,
): FloorRect {
  return projectedTileRect(projection, {
    x: seat.x,
    y: deskDisplayTop(seat, monitorOffsetY).y,
    width: 2,
    height: 2,
  }, 1);
}

/** Character positions are feet anchors; this rectangle follows the drawn body. */
export function agentVisualRect(position: Point): FloorRect {
  return { x: position.x - 10, y: position.y - 31, width: 20, height: 34 };
}

export class FloorInteractionRegistry {
  private targets = new Map<string, FloorInteractionTarget>();

  register(target: FloorInteractionTarget): () => void {
    if (!target.id || !validRect(target.bounds) || !Number.isFinite(target.priority)) return () => {};
    this.targets.set(target.id, { ...target, bounds: { ...target.bounds } });
    return () => this.targets.delete(target.id);
  }

  update(id: string, patch: Partial<Pick<FloorInteractionTarget, 'bounds' | 'priority'>>): void {
    const current = this.targets.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    if (validRect(next.bounds) && Number.isFinite(next.priority)) this.targets.set(id, next);
  }

  get(id: string): FloorInteractionTarget | undefined { return this.targets.get(id); }

  list(): FloorInspectionTarget[] { return [...this.targets.values()].map(({ target }) => ({ ...target })); }

  unregister(id: string): void { this.targets.delete(id); }

  resolve(point: Point): FloorInteractionTarget | null {
    return [...this.targets.values()]
      .filter((target) => contains(target.bounds, point))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0] ?? null;
  }

  clear(): void { this.targets.clear(); }
}

/** Keep the inspector boundary small: only facts safe for a read-only view. */
export function normalizeInspectionTasks(value: unknown): FloorInspectionTask[] | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { tasks?: unknown }).tasks)) return null;
  return (value as { tasks: unknown[] }).tasks.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as { id?: unknown; title?: unknown; name?: unknown; status?: unknown; assignee?: unknown };
    if (typeof item.id !== 'string' || !item.id) return [];
    return [{
      id: item.id,
      title: typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : null,
      status: typeof item.status === 'string' ? item.status : null,
      assignee: typeof item.assignee === 'string' && item.assignee ? item.assignee : null,
    }];
  });
}
