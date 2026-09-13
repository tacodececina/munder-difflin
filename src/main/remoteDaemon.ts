/**
 * remoteDaemon.ts — the CLIENT half of the Phase 3a remote PTY protocol.
 *
 * The daemon (`remote-daemon/`, standalone, validated cross-machine over
 * Tailscale) lets a paired client spawn and drive real pseudo-terminals on
 * ANOTHER machine over a WebSocket. This file speaks that wire format from the
 * Electron main process and re-exposes it as something shaped almost exactly
 * like `PtyManager` (src/main/pty.ts), so a remote session can slot into the
 * existing spawn/write/resize/kill call sites with no renderer changes at all:
 * `RemoteDaemonManager` emits the SAME `pty:data:<id>` / `pty:exit:<id>` IPC
 * events, with the same payload shapes, to the same owner window.
 *
 * WIRE FORMAT — mirrored from remote-daemon/src/protocol.js. Do not "improve" it
 * here; the daemon validates every frame and closes the socket on anything it
 * does not recognise.
 *
 *   pair    -> { type:'pair', code, name? }              => { type:'paired', clientId, secret, pairedAt }
 *   auth    -> { type:'auth', clientId, timestamp, nonce, hmac }
 *                                                        => { type:'authed', clientId }
 *   spawn   -> { type:'spawn', id, command, args, cwd, cols, rows }
 *                                                        => { type:'spawned', id, pid }
 *   input   -> { type:'input',  id, data }   data is BASE64
 *   resize  -> { type:'resize', id, cols, rows }
 *   kill    -> { type:'kill',   id }
 *   list    -> { type:'list' }                           => { type:'list', sessions:[…] }
 *   (daemon-initiated) { type:'output', id, data }  data is BASE64
 *                      { type:'exit',   id, code, signal? }
 *                      { type:'error',  id|null, message }
 *
 * FILESYSTEM PROXY (Phase 3c) — the one exchange that runs the OTHER WAY. A
 * remote agent's Read/Write hits the remote machine's disk, so it has no hive.
 * The fix is a filesystem mounted over there whose contents are
 * `<harnessHome>/hive/agents/<agentId>/` over HERE, which means the daemon has to
 * be able to ask US for file I/O:
 *
 *   (daemon-initiated) { type:'fs-request', reqId, agentId, op, path[, data][, newPath] }
 *   (our answer)       { type:'fs-response', reqId, ok:true[, data][, entries][, stat] }
 *                      { type:'fs-response', reqId, ok:false, error }
 *
 * We are the RESPONDER there, not the requester: `reqId` (not `id`) correlates,
 * because many fs calls are in flight at once and finish out of order. Nothing is
 * served until `enableHiveFs()` has been called AND the agent id has been passed
 * to `authorizeAgent()`; the sandbox and the hive's read/write asymmetry are
 * enforced in remoteFsHost.ts. Wire format: src/main/remoteFsProtocol.ts;
 * full spec: remote-daemon/README-FS-PROXY.md.
 *
 * BASE64 IN BOTH DIRECTIONS. A PTY carries arbitrary bytes; JSON strings cannot,
 * and `JSON.stringify` would silently replace them with U+FFFD. The daemon
 * REJECTS a non-base64 `input.data` outright (protocol.js `isBase64`), so this is
 * not optional on the write path either.
 *
 * HMAC. `HMAC-SHA256(secret, "<clientId>:<timestamp>:<nonce>")`, hex — byte for
 * byte what remote-daemon/src/auth.js `signingPayload`/`computeHmac` compute. The
 * daemon tolerates 30 s of skew and remembers nonces for 60 s, so every
 * connection needs a FRESH timestamp and nonce; a reconnect that reuses either is
 * refused as a replay.
 *
 * SECURITY. The secret is held in memory here (a reconnect must re-sign) and
 * NOWHERE else in this process: it is never logged, never returned over IPC,
 * never put in an agent's environment. Everything logged below is host/port/id
 * only. `electron` is imported TYPE-ONLY, which keeps this module runnable —
 * and therefore testable — under plain Node against the real daemon
 * (test/remote-daemon-client.test.cjs does exactly that).
 */
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { WebContents } from 'electron';
import { FS_ERRORS, MAX_FS_INFLIGHT, isValidAgentId, isValidReqId, validateFsRequest, type FsRequest } from './remoteFsProtocol';
import { HiveFsHost, type FsResult } from './remoteFsHost';

/** How long a connect+auth handshake may take before we give up. */
const CONNECT_TIMEOUT_MS = 15_000;
/** How long to wait for a `spawned`/`error` answer to a spawn request. */
const SPAWN_TIMEOUT_MS = 20_000;
/** How long to wait for a `list` reply. */
const LIST_TIMEOUT_MS = 10_000;
/** How long a pairing exchange may take (the operator already typed the code). */
const PAIR_TIMEOUT_MS = 20_000;
/** Reconnect backoff, and how many times we try before giving up on a drop. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

export interface RemoteDaemonCredentials {
  host: string;
  port: number;
  clientId: string;
  /** The 32-byte pairing secret, hex. MEMORY ONLY — never logged or serialised. */
  secret: string;
}

export interface RemoteSpawnOptions {
  id: string;
  command: string;
  args?: string[];
  /** A path on the REMOTE machine. Omitted → the daemon uses its own homedir. */
  cwd?: string;
  cols?: number;
  rows?: number;
  /**
   * The HIVE agent id this PTY is running, when it has one — NOT the pty id
   * (`id` above), which is the terminal tab's identity and may differ.
   *
   * Present only makes a difference once `RemoteDaemonManager.enableHiveFs()` has
   * been called: it is what authorizes the remote machine to proxy filesystem
   * calls into `<harnessHome>/hive/agents/<hiveAgentId>/`. Never sent on the
   * wire — the daemon has no concept of a hive agent and must not be given one.
   */
  hiveAgentId?: string;
}

export interface RemoteSessionInfo {
  id: string;
  command: string;
  args: string[];
  pid: number;
  startedAt: string;
  cols: number;
  rows: number;
}

type Result = { ok: boolean; error?: string };

function wsUrl(host: string, port: number): string {
  return `ws://${host}:${port}`;
}

/** The canonical string both sides HMAC — keep byte-identical with auth.js. */
function signingPayload(clientId: string, timestamp: number, nonce: string): string {
  return `${clientId}:${timestamp}:${nonce}`;
}

function computeHmac(secret: string, clientId: string, timestamp: number, nonce: string): string {
  return createHmac('sha256', secret).update(signingPayload(clientId, timestamp, nonce)).digest('hex');
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** ws hands us a string, a Buffer, or (fragmented) an array of Buffers. */
function frameText(raw: WebSocket.Data): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return String(raw);
}

/**
 * One authenticated WebSocket to one remote daemon, multiplexing every session
 * on that machine. The daemon BROADCASTS output to all authenticated sockets and
 * keys it by session id, so one connection per environment is the natural shape —
 * not one per PTY.
 *
 * Events (all payloads already decoded):
 *   'data'  ({ id, data })                 — PTY output, base64 decoded
 *   'exit'  ({ id, exitCode, signal })     — PTY closed
 *   'error' (message: string)              — daemon-level (id-less) error
 *   'open'  ()                             — authenticated and ready
 *   'close' (reason: string)               — socket down (a reconnect may follow)
 *   'gone'  (reason: string)               — down for good, reconnects exhausted
 */
export class RemoteDaemonClient extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly clientId: string;
  /** Not `readonly` only so `dispose()` can blank it; never read outside signing. */
  private secret: string;

  private ws: WebSocket | null = null;
  private authed = false;
  private disposed = false;
  private connecting: Promise<Result> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Session ids WE spawned through this client — the set worth reconnecting for. */
  private readonly live = new Set<string>();
  /** id -> resolver for an in-flight `spawn`. */
  private readonly pendingSpawns = new Map<string, (r: { ok: boolean; error?: string; pid?: number }) => void>();
  /** `list` has no correlation id in the protocol, so replies are matched FIFO. */
  private readonly pendingLists: Array<(sessions: RemoteSessionInfo[]) => void> = [];

  // ── filesystem proxy (we are the RESPONDER for these) ─────────────────────
  /** Set by enableHiveFs(). Null = fs-requests are answered `unsupported_op`. */
  private fsHost: { handle(req: FsRequest): Promise<FsResult> } | null = null;
  /**
   * The agent ids this connection may serve. THE authorization boundary: the
   * daemon can ask for any id it likes, and anything not in here is refused
   * without ever reaching a path calculation. Populated by `authorizeAgent`,
   * which the spawn that created the remote agent calls.
   */
  private readonly fsAgents = new Set<string>();
  /** Concurrent fs operations, so a rogue daemon cannot exhaust our fd budget. */
  private fsInflight = 0;
  /** Where refusals are recorded. Shared with the host so one sink sees both gates. */
  private fsLogger: Pick<Console, 'log' | 'warn'> = console;

  constructor(creds: RemoteDaemonCredentials) {
    super();
    this.host = creds.host;
    this.port = creds.port;
    this.clientId = creds.clientId;
    this.secret = creds.secret;
  }

  get isConnected(): boolean {
    return this.authed && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Session ids this client believes are still running on the remote machine. */
  liveSessionIds(): string[] {
    return [...this.live];
  }

  /** `emit('error')` on a bare EventEmitter THROWS when nobody is listening, and
   *  a daemon-side error frame must never be able to take the main process down.
   *  Every non-lifecycle emit goes through here. */
  private emitSafe(event: string, payload: unknown): void {
    if (this.listenerCount(event) === 0) return;
    this.emit(event, payload);
  }

  /** Connect + authenticate, or resolve immediately if already up. Concurrent
   *  callers share one in-flight attempt (a floor restoring four remote agents
   *  must not open four sockets). */
  connect(): Promise<Result> {
    if (this.disposed) return Promise.resolve({ ok: false, error: 'client disposed' });
    if (this.isConnected) return Promise.resolve({ ok: true });
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private openSocket(): Promise<Result> {
    return new Promise<Result>((resolve) => {
      let settled = false;
      const done = (r: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl(this.host, this.port));
      } catch (e) {
        return done({ ok: false, error: errText(e) });
      }
      this.ws = ws;
      this.authed = false;

      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* already gone */ }
        done({ ok: false, error: `timed out connecting to ${this.host}:${this.port}` });
      }, CONNECT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      ws.on('open', () => {
        // A FRESH timestamp+nonce per connection: the daemon remembers nonces for
        // 60 s and refuses a replay, so a reconnect must never reuse them.
        const timestamp = Date.now();
        const nonce = randomBytes(16).toString('hex');
        const hmac = computeHmac(this.secret, this.clientId, timestamp, nonce);
        this.send({ type: 'auth', clientId: this.clientId, timestamp, nonce, hmac });
      });

      ws.on('message', (raw: WebSocket.Data) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(frameText(raw));
        } catch {
          return; // a frame we cannot parse is not worth killing the link over
        }
        if (!settled) {
          // Handshake phase: only `authed` (success) or `error` (refusal) matter.
          if (msg.type === 'authed') {
            this.authed = true;
            this.reconnectAttempt = 0;
            this.emit('open');
            return done({ ok: true });
          }
          if (msg.type === 'error') {
            return done({ ok: false, error: typeof msg.message === 'string' ? msg.message : 'authentication failed' });
          }
          return;
        }
        this.onFrame(msg);
      });

      ws.on('error', (err: Error) => {
        // ECONNREFUSED / bad host land here BEFORE 'open'. Never include the
        // secret (there is none in an ws error), only the transport message.
        done({ ok: false, error: err.message });
      });

      ws.on('close', (code: number, reason: Buffer | string) => {
        const why = `socket closed (${code}${reason && reason.length ? `: ${String(reason)}` : ''})`;
        this.authed = false;
        if (this.ws === ws) this.ws = null;
        done({ ok: false, error: why });
        this.failPending(why);
        this.emit('close', why);
        this.scheduleReconnect(why);
      });
    });
  }

  /** A dropped link leaves the remote PTYs RUNNING (the daemon deliberately
   *  outlives its clients), so reconnecting restores the live output stream.
   *  Only worth doing while we still believe a session exists. */
  private scheduleReconnect(reason: string): void {
    if (this.disposed || this.live.size === 0) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.emitSafe('gone', reason);
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.live.size === 0) return;
      void this.connect().then((r) => {
        if (!r.ok) this.scheduleReconnect(r.error ?? reason);
      });
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  /** Every in-flight request fails when the link goes: better an honest error
   *  than a promise that never settles and a spinner that never stops. */
  private failPending(reason: string): void {
    for (const [, resolve] of this.pendingSpawns) resolve({ ok: false, error: reason });
    this.pendingSpawns.clear();
    while (this.pendingLists.length) this.pendingLists.shift()?.([]);
  }

  private onFrame(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' ? msg.id : null;
    switch (msg.type) {
      case 'output': {
        if (!id || typeof msg.data !== 'string') return;
        this.emit('data', { id, data: Buffer.from(msg.data, 'base64').toString('utf8') });
        return;
      }
      case 'exit': {
        if (!id) return;
        this.live.delete(id);
        const code = typeof msg.code === 'number' ? msg.code : 0;
        const signal = typeof msg.signal === 'number' ? msg.signal : undefined;
        this.emit('exit', { id, exitCode: code, signal });
        return;
      }
      case 'spawned': {
        if (!id) return;
        const pid = typeof msg.pid === 'number' ? msg.pid : undefined;
        this.live.add(id);
        this.pendingSpawns.get(id)?.({ ok: true, pid });
        this.pendingSpawns.delete(id);
        return;
      }
      case 'list': {
        const sessions = Array.isArray(msg.sessions) ? (msg.sessions as RemoteSessionInfo[]) : [];
        this.pendingLists.shift()?.(sessions);
        return;
      }
      case 'fs-request': {
        // The only frame we ANSWER rather than consume. Deliberately not awaited:
        // real file I/O must not stall the socket's message loop, and each
        // request carries its own reqId, so replies may come back out of order.
        void this.onFsRequest(msg);
        return;
      }
      case 'error': {
        const message = typeof msg.message === 'string' ? msg.message : 'remote error';
        // An error CARRYING a session id answers that session's pending request;
        // an id-less one is daemon-level and goes out as a client error event.
        if (id && this.pendingSpawns.has(id)) {
          this.pendingSpawns.get(id)?.({ ok: false, error: message });
          this.pendingSpawns.delete(id);
          return;
        }
        this.emitSafe('error', id ? `${id}: ${message}` : message);
        return;
      }
      default:
        return;
    }
  }

  private send(obj: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  // ── filesystem proxy: we answer, the remote machine asks ──────────────────

  /**
   * Start serving hive filesystem requests from this daemon.
   *
   * Opt-in and inert until called — a client that never calls this answers every
   * fs-request with `unsupported_op`, which is what every existing remote
   * environment does today. Even after it IS called, nothing is served until an
   * agent id has been through {@link authorizeAgent}: enabling the host grants
   * the ABILITY to serve, never the right to any particular folder.
   *
   * @param agentsRoot resolves `<harnessHome>/hive/agents`, or null when the hive
   *                   is off. A function because harnessHome changes at runtime.
   */
  enableHiveFs(agentsRoot: () => string | null, logger?: Pick<Console, 'log' | 'warn'>): void {
    this.fsLogger = logger ?? console;
    this.fsHost = new HiveFsHost({
      agentsRoot,
      isAuthorized: (agentId) => this.fsAgents.has(agentId),
      logger: this.fsLogger
    });
  }

  /** Swap in a different responder. Exists for tests; production uses enableHiveFs. */
  attachFsHost(host: { handle(req: FsRequest): Promise<FsResult> } | null): void {
    this.fsHost = host;
  }

  /** Whether this client will answer fs-requests at all. */
  get isHiveFsEnabled(): boolean {
    return this.fsHost !== null;
  }

  /**
   * Grant this connection the right to serve one agent's hive folder.
   *
   * Called by whoever KNOWS the mapping — the spawn that started this agent on
   * this machine. Nothing the daemon says can add to this set; that is the point.
   * @returns false when the id is not a shape we will ever resolve to a folder.
   */
  authorizeAgent(agentId: string): boolean {
    if (!isValidAgentId(agentId)) return false;
    this.fsAgents.add(agentId);
    return true;
  }

  /** Withdraw a grant (the agent was killed, the environment unpaired). */
  revokeAgent(agentId: string): void {
    this.fsAgents.delete(agentId);
  }

  /** The agent ids currently served over this connection. */
  authorizedAgents(): string[] {
    return [...this.fsAgents];
  }

  /**
   * Answer one fs-request. Never throws: the remote side is a filesystem and
   * needs a reply for every call, or the mount hangs.
   */
  private async onFsRequest(msg: Record<string, unknown>): Promise<void> {
    // Without a usable reqId there is nothing to correlate an answer to — the
    // frame is unanswerable by construction, so drop it rather than guess.
    if (!isValidReqId(msg.reqId)) return;
    const reqId = msg.reqId;
    const reply = (payload: FsResult): void => {
      this.send({ type: 'fs-response', reqId, ...payload });
    };

    if (!this.fsHost) return reply({ ok: false, error: FS_ERRORS.UNSUPPORTED_OP });

    const parsed = validateFsRequest(msg);
    if (!parsed.ok) {
      // A path that fails the SYNTACTIC gate never reaches the host, so the host
      // cannot be the one to log it — and an unlogged escape attempt is an escape
      // attempt nobody finds out about. Same wording as the host's own rejection
      // so an operator greps once.
      if (parsed.error === FS_ERRORS.PATH_ESCAPE) {
        this.fsLogger.warn(`[remote-fs] PATH ESCAPE REJECTED (syntax) — agent "${String(msg.agentId).slice(0, 64)}" op "${String(msg.op).slice(0, 16)}" path ${JSON.stringify(String(msg.path ?? '')).slice(0, 200)}`);
      } else {
        this.fsLogger.warn(`[remote-fs] rejected fs-request ${reqId}: ${parsed.reason}`);
      }
      return reply({ ok: false, error: parsed.error });
    }
    if (this.fsInflight >= MAX_FS_INFLIGHT) return reply({ ok: false, error: FS_ERRORS.BUSY });

    this.fsInflight += 1;
    try {
      reply(await this.fsHost.handle(parsed.request));
    } catch (e) {
      console.warn(`[remote-fs] handler threw on ${parsed.request.op}: ${errText(e)}`);
      reply({ ok: false, error: FS_ERRORS.IO_ERROR });
    } finally {
      this.fsInflight -= 1;
    }
  }

  /** Spawn a PTY on the remote machine. Connects first if needed. */
  async spawn(opts: RemoteSpawnOptions): Promise<{ ok: boolean; error?: string; pid?: number }> {
    if (this.live.has(opts.id)) return { ok: false, error: `pty already exists for id ${opts.id}` };
    const conn = await this.connect();
    if (!conn.ok) return { ok: false, error: conn.error ?? 'not connected' };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: { ok: boolean; error?: string; pid?: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingSpawns.delete(opts.id);
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timed out waiting for the remote spawn' }), SPAWN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.pendingSpawns.set(opts.id, finish);
      const sent = this.send({
        type: 'spawn',
        id: opts.id,
        command: opts.command,
        args: opts.args ?? [],
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 30
      });
      if (!sent) finish({ ok: false, error: 'not connected' });
    });
  }

  /** Write to a remote PTY. Base64 because the daemon rejects anything else. */
  write(id: string, data: string): Result {
    if (!this.isConnected) return { ok: false, error: 'remote environment is not connected' };
    const sent = this.send({ type: 'input', id, data: Buffer.from(data, 'utf8').toString('base64') });
    return sent ? { ok: true } : { ok: false, error: 'remote environment is not connected' };
  }

  resize(id: string, cols: number, rows: number): Result {
    if (!this.isConnected) return { ok: false, error: 'remote environment is not connected' };
    const sent = this.send({ type: 'resize', id, cols, rows });
    return sent ? { ok: true } : { ok: false, error: 'remote environment is not connected' };
  }

  /** Ask the daemon to kill a session. The `exit` frame still arrives from the
   *  process itself, so kill and natural exit look identical downstream — the
   *  same contract PtyManager has. */
  kill(id: string): Result {
    this.live.delete(id);
    if (!this.isConnected) return { ok: false, error: 'remote environment is not connected' };
    const sent = this.send({ type: 'kill', id });
    return sent ? { ok: true } : { ok: false, error: 'remote environment is not connected' };
  }

  /** Sessions the DAEMON reports — including ones spawned before this app run. */
  async list(): Promise<RemoteSessionInfo[]> {
    const conn = await this.connect();
    if (!conn.ok) return [];
    return new Promise((resolve) => {
      let settled = false;
      const finish = (s: RemoteSessionInfo[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(s);
      };
      const timer = setTimeout(() => finish([]), LIST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.pendingLists.push(finish);
      if (!this.send({ type: 'list' })) finish([]);
    });
  }

  /** Close the link for good and forget the secret. Does NOT kill remote PTYs —
   *  they belong to the daemon and survive us on purpose. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending('client disposed');
    this.live.clear();
    // Drop every filesystem grant with the connection. A disposed client that
    // somehow received one more frame must not still be able to serve files.
    this.fsAgents.clear();
    this.fsHost = null;
    try { this.ws?.close(1000, 'client closing'); } catch { /* already gone */ }
    this.ws = null;
    this.authed = false;
    this.secret = '';
  }
}

/**
 * The one-time pairing exchange: present the 6-character code the daemon printed
 * on ITS console and receive `{clientId, secret}`.
 *
 * This is the ONLY moment the secret crosses the wire. The caller must hand it
 * straight to the encrypted store and never let it out again — nothing here logs
 * it, and the failure paths deliberately carry the daemon's message, which never
 * contains it either.
 */
export function pairWithRemoteDaemon(opts: {
  host: string;
  port: number;
  code: string;
  name?: string;
  timeoutMs?: number;
}): Promise<{ ok: true; clientId: string; secret: string; pairedAt: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const done = (r: { ok: true; clientId: string; secret: string; pairedAt: number } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, error: `timed out pairing with ${opts.host}:${opts.port}` }),
      opts.timeoutMs ?? PAIR_TIMEOUT_MS
    );
    if (typeof timer.unref === 'function') timer.unref();

    try {
      ws = new WebSocket(wsUrl(opts.host, opts.port));
    } catch (e) {
      return done({ ok: false, error: errText(e) });
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'pair',
        code: opts.code,
        ...(opts.name ? { name: opts.name } : {})
      }));
    });
    ws.on('message', (raw: WebSocket.Data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(frameText(raw));
      } catch {
        return done({ ok: false, error: 'the daemon sent a reply we could not parse' });
      }
      if (msg.type === 'paired' && typeof msg.clientId === 'string' && typeof msg.secret === 'string') {
        return done({
          ok: true,
          clientId: msg.clientId,
          secret: msg.secret,
          pairedAt: typeof msg.pairedAt === 'number' ? msg.pairedAt : Date.now()
        });
      }
      const message = typeof msg.message === 'string' ? msg.message : 'pairing was refused';
      return done({ ok: false, error: message });
    });
    ws.on('error', (err: Error) => done({ ok: false, error: err.message }));
    ws.on('close', () => done({ ok: false, error: 'the daemon closed the connection before pairing completed' }));
  });
}

interface RemoteSession {
  id: string;
  envId: string;
  cwd: string;
  command: string;
  owner: WebContents | null;
  lastOutputAt: number;
  hasOutput: boolean;
  /** The hive agent this session runs, when it has one (see RemoteSpawnOptions). */
  hiveAgentId?: string;
}

/**
 * The `PtyManager` analogue for remote sessions.
 *
 * Deliberately shaped like src/main/pty.ts: same method names, same
 * `{ok, error?}` returns, the same owner-window routing, the same
 * `pty:data:<id>` / `pty:exit:<id>` channels with the same payloads. That is
 * what lets `pty:write`/`pty:resize`/`pty:kill` route on nothing more than "is
 * this id remote?", and lets the renderer's xterm code stay untouched.
 *
 * One `RemoteDaemonClient` per environment, created lazily and reused: the
 * daemon multiplexes every session over a single authenticated socket.
 */
export class RemoteDaemonManager {
  private readonly clients = new Map<string, RemoteDaemonClient>();
  private readonly sessions = new Map<string, RemoteSession>();
  private webContents: WebContents | null = null;
  private exitHandler: ((id: string, exitCode?: number) => void) | null = null;
  /** Set by enableHiveFs(); every client built afterwards serves hive files. */
  private hiveAgentsRoot: (() => string | null) | null = null;

  /** The default output sink (the primary window), for sessions with no owner. */
  attachWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  /** Same contract as PtyManager.setExitHandler — natural exit runs the shared
   *  lifecycle teardown (archive, map cleanup) that an explicit kill runs. */
  setExitHandler(handler: (id: string, exitCode?: number) => void): void {
    this.exitHandler = handler;
  }

  /** Is this pty id a REMOTE session? The single question every routing site asks. */
  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Let remote machines proxy hive filesystem calls back to this one.
   *
   * OFF unless called — a remote agent stays hive-less, exactly as it is today.
   * Turning it on grants nothing by itself: a folder is only reachable once a
   * spawn carrying `hiveAgentId` (or an explicit `authorizeAgent`) has named it.
   *
   * @param agentsRoot resolves `<harnessHome>/hive/agents` (null when the hive is
   *                   off) — e.g. `() => { const r = hive.root(); return r ? join(r, 'agents') : null; }`
   */
  enableHiveFs(agentsRoot: () => string | null): void {
    this.hiveAgentsRoot = agentsRoot;
    for (const client of this.clients.values()) client.enableHiveFs(agentsRoot);
  }

  /** Grant one environment's connection access to one agent's hive folder. */
  authorizeAgent(envId: string, agentId: string): boolean {
    return this.clients.get(envId)?.authorizeAgent(agentId) ?? false;
  }

  /** Withdraw such a grant. */
  revokeAgent(envId: string, agentId: string): void {
    this.clients.get(envId)?.revokeAgent(agentId);
  }

  /** Which environment a remote session runs on (undefined when it is local). */
  environmentOf(id: string): string | undefined {
    return this.sessions.get(id)?.envId;
  }

  private safeSend(channel: string, payload: unknown, target?: WebContents | null): void {
    const wc = target ?? this.webContents;
    if (!wc || wc.isDestroyed()) return;
    try { wc.send(channel, payload); } catch { /* window tore down mid-send */ }
  }

  /** Get (or lazily build) the client for an environment. Credentials are passed
   *  in per call by the caller that CAN decrypt them; this class never reads the
   *  secret store itself. */
  private clientFor(envId: string, creds: RemoteDaemonCredentials): RemoteDaemonClient {
    const existing = this.clients.get(envId);
    if (existing) return existing;
    const client = new RemoteDaemonClient(creds);
    // Serve hive files only if the app turned the feature on. Still per-agent
    // gated after this — see enableHiveFs above.
    if (this.hiveAgentsRoot) client.enableHiveFs(this.hiveAgentsRoot);
    client.on('data', ({ id, data }: { id: string; data: string }) => {
      const s = this.sessions.get(id);
      if (!s) return; // a session someone else on this daemon spawned — not ours
      s.hasOutput = true;
      s.lastOutputAt = Date.now();
      this.safeSend(`pty:data:${id}`, data, s.owner);
    });
    client.on('exit', ({ id, exitCode, signal }: { id: string; exitCode: number; signal?: number }) => {
      const s = this.sessions.get(id);
      if (!s) return;
      this.safeSend(`pty:exit:${id}`, { exitCode, signal }, s.owner);
      this.sessions.delete(id);
      // The agent is gone; so is the remote machine's claim on its hive folder.
      if (s.hiveAgentId) client.revokeAgent(s.hiveAgentId);
      try { this.exitHandler?.(id, exitCode); } catch { /* never throw out of an exit path */ }
    });
    client.on('error', (message: string) => {
      console.warn(`[remote] ${envId}: ${message}`);
    });
    client.on('gone', (reason: string) => {
      // Reconnects are exhausted. The remote PTYs may well still be alive on the
      // daemon, but we can no longer see them, so tell each owner the tab is dead
      // rather than leaving a terminal that silently never updates again.
      console.warn(`[remote] ${envId}: connection lost for good (${reason})`);
      for (const [id, s] of [...this.sessions]) {
        if (s.envId !== envId) continue;
        this.safeSend(`pty:data:${id}`, `\r\n\x1b[31m[remote] lost the connection to ${s.envId} (${reason})\x1b[0m\r\n`, s.owner);
        this.safeSend(`pty:exit:${id}`, { exitCode: 1 }, s.owner);
        this.sessions.delete(id);
        if (s.hiveAgentId) client.revokeAgent(s.hiveAgentId);
        try { this.exitHandler?.(id, 1); } catch { /* never throw out of an exit path */ }
      }
    });
    this.clients.set(envId, client);
    return client;
  }

  /** Spawn an agent PTY on a remote machine. Mirrors PtyManager.spawn's return. */
  async spawn(
    envId: string,
    creds: RemoteDaemonCredentials,
    opts: RemoteSpawnOptions,
    owner: WebContents | null = null
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.sessions.has(opts.id)) return { ok: false, error: `pty already exists for id ${opts.id}` };
    const client = this.clientFor(envId, creds);
    const res = await client.spawn(opts);
    if (!res.ok) return { ok: false, error: res.error };
    this.sessions.set(opts.id, {
      id: opts.id,
      envId,
      cwd: opts.cwd ?? '',
      command: opts.command,
      owner,
      lastOutputAt: Date.now(),
      hasOutput: false,
      ...(opts.hiveAgentId ? { hiveAgentId: opts.hiveAgentId } : {})
    });
    // The spawn is what KNOWS this remote PTY is that hive agent, so it is the
    // only honest place to grant the folder. Granting later, from a message the
    // daemon sends, would let the remote side name its own authorization.
    if (opts.hiveAgentId) client.authorizeAgent(opts.hiveAgentId);
    return { ok: true };
  }

  write(id: string, data: string): Result {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    const client = this.clients.get(s.envId);
    if (!client) return { ok: false, error: `no remote connection for ${s.envId}` };
    return client.write(id, data);
  }

  resize(id: string, cols: number, rows: number): Result {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    const client = this.clients.get(s.envId);
    if (!client) return { ok: false, error: `no remote connection for ${s.envId}` };
    return client.resize(id, cols, rows);
  }

  /** A remote TUI has no local geometry to nudge; a same-size resize is the same
   *  trick PtyManager.redraw plays, so keep the behaviour identical. */
  redraw(id: string): Result {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    return { ok: true };
  }

  kill(id: string): Result {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: `no pty: ${id}` };
    const client = this.clients.get(s.envId);
    this.sessions.delete(id);
    if (!client) return { ok: false, error: `no remote connection for ${s.envId}` };
    if (s.hiveAgentId) client.revokeAgent(s.hiveAgentId);
    return client.kill(id);
  }

  list(): Array<{ id: string; cwd: string; command: string; pid: number; lastOutputAt: number; hasOutput: boolean; remoteEnvironmentId: string }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      cwd: s.cwd,
      command: s.command,
      pid: 0, // the pid lives on the other machine; 0 keeps the local shape honest
      lastOutputAt: s.lastOutputAt,
      hasOutput: s.hasOutput,
      remoteEnvironmentId: s.envId
    }));
  }

  lastOutputAt(id: string): number | undefined {
    return this.sessions.get(id)?.lastOutputAt;
  }

  idleFor(id: string): number | undefined {
    const s = this.sessions.get(id);
    return s ? Date.now() - s.lastOutputAt : undefined;
  }

  countByOwner(wc: WebContents): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.owner === wc) n += 1;
    return n;
  }

  killByOwner(wc: WebContents): void {
    for (const [id, s] of [...this.sessions]) {
      if (s.owner === wc) this.kill(id);
    }
  }

  /** App quit / reset: ask the daemon to end our sessions, then drop every link.
   *  Fire-and-forget — quitting must not wait on a network round trip. */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
    this.sessions.clear();
  }

  /** Drop a single environment's connection (used when it is unpaired/removed). */
  disconnect(envId: string): void {
    for (const [id, s] of [...this.sessions]) {
      if (s.envId === envId) this.sessions.delete(id);
    }
    this.clients.get(envId)?.dispose();
    this.clients.delete(envId);
  }
}
