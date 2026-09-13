/**
 * Remote environments (Phase 3b) — a machine, reachable over Tailscale, running
 * the standalone remote PTY daemon (`remote-daemon/`) that this app can spawn and
 * drive agents on.
 *
 * METADATA ONLY. The 32-byte HMAC secret minted during pairing is NEVER part of
 * this record: it lives encrypted at rest (Electron `safeStorage`) in a file
 * separate from config.json, exactly like an integration secret, and is reachable
 * only from the main process (see src/main/remoteEnvironments.ts). A record
 * carries an opaque `secretRef` handle derived from its id — nothing else.
 *
 * Shared (not main-only) because the preload bridge and the renderer's
 * "where does this run?" picker both need the shape; neither can ever see a
 * secret, because there is no field here to put one in.
 */

/** One paired remote daemon. Safe to hand to the renderer verbatim. */
export interface RemoteEnvironment {
  /** App-local id (not the daemon's). Stable across reconnects; keys the secret. */
  id: string;
  /** Operator-chosen display name, e.g. "studio-mac". */
  name: string;
  /** Host or IP the daemon listens on — normally a Tailscale address. */
  host: string;
  port: number;
  /** The id the daemon minted for US at pairing; sent on every auth handshake. */
  clientId: string;
  /** Epoch ms the pairing succeeded. */
  pairedAt: number;
}

/** Opaque handle under which this environment's HMAC secret is stored. Mirrors
 *  `secretRefFor` in shared/integrations.ts — a different prefix so the two
 *  namespaces can never collide inside one secret blob. */
export function remoteSecretRefFor(id: string): string {
  return `remote:${id}`;
}

/** Hostnames/IPs only — no scheme, no path, no credentials. The value is
 *  interpolated into a `ws://host:port` URL, so anything that could smuggle a
 *  second URL component is refused here rather than at connect time. */
export function isValidRemoteHost(host: unknown): host is string {
  if (typeof host !== 'string') return false;
  const h = host.trim();
  if (!h || h.length > 253) return false;
  if (/[\s/\\@?#]/.test(h)) return false;
  // Bare IPv6 needs brackets in a URL; accept the bracketed form only.
  if (h.includes(':')) return /^\[[0-9A-Fa-f:.]+\]$/.test(h);
  return /^[A-Za-z0-9._-]+$/.test(h);
}

export function isValidRemotePort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
}

/** Strip a record down to the renderer-safe fields, dropping anything a caller
 *  may have attached. There is no secret to redact — this is a shape guard. */
export function toRemoteEnvironmentView(e: RemoteEnvironment): RemoteEnvironment {
  return { id: e.id, name: e.name, host: e.host, port: e.port, clientId: e.clientId, pairedAt: e.pairedAt };
}
