/**
 * remoteFsHost.ts — the GPD half of the filesystem proxy: the thing that actually
 * touches disk.
 *
 * A remote agent's Read/Write tool calls hit the REMOTE machine's filesystem, so
 * a remote agent has no hive: no memory.md, no inbox, no outbox, no way to be
 * addressed by the router. Phases 3d–3f fix that by mounting a real filesystem on
 * the remote machine whose contents are this machine's
 * `<harnessHome>/hive/agents/<agentId>/`. Every operation on that mount arrives
 * here as an `fs-request` and is executed by this class against real files.
 *
 * That makes this module a SECURITY BOUNDARY, and it is the only one that counts.
 * The daemon on the other end is software on another computer; it can be buggy,
 * it can be out of date, and — if that machine is compromised — it can be hostile.
 * Nothing it sends is trusted. Three gates, in order, on every single request:
 *
 *   1. AUTHORIZATION. `isAuthorized(agentId)` — the app must have explicitly
 *      granted this connection that agent id (RemoteDaemonClient.authorizeAgent,
 *      driven by the spawn that created the remote agent). An id nobody granted
 *      gets `unauthorized_agent` and never reaches a path calculation.
 *
 *   2. THE SANDBOX. The request's path is RELATIVE by construction; it is
 *      resolved against the agent folder and the result must still be inside it —
 *      compared with a trailing separator, so `…/agents/orion-x` cannot be
 *      escaped into the sibling `…/agents/orion-x-evil` by prefix collision. Then
 *      the same containment is re-checked through `realpath`, because `resolve`
 *      knows nothing about SYMLINKS and the hive really does contain some (a
 *      Codex worker's `.codex` data dirs are symlinked to the user's global
 *      `~/.codex`). Anything that fails is `path_escape`, logged, and touches
 *      nothing.
 *
 *   3. THE WRITE POLICY. The hive has an asymmetric read/write contract that the
 *      local floor already assumes — identity.md is written by the harness and
 *      read by the agent, inbox/ is filled by the router and drained by the
 *      agent, outbox/ is the agent's only outbound channel. A remote mount gets
 *      the AGENT's half of that contract, not the harness's. See
 *      {@link hiveWriteClass}, which is where the whole policy lives.
 *
 * Written against `node:fs/promises` on purpose: this runs on the Electron main
 * thread, and a remote mount can issue dozens of overlapping operations. A
 * synchronous readFile here would stall the UI of the app the operator is
 * watching the floor in.
 */
import {
  lstat as lstatAsync,
  mkdir as mkdirAsync,
  readFile as readFileAsync,
  readdir as readdirAsync,
  realpath as realpathAsync,
  rename as renameAsync,
  rmdir as rmdirAsync,
  stat as statAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  FS_ERRORS,
  MAX_FS_ENTRIES,
  MAX_FS_FILE_BYTES,
  isSafeRelPath,
  isValidAgentId,
  type FsEntry,
  type FsError,
  type FsRequest,
  type FsStat
} from './remoteFsProtocol';

/** What the host answers with — an fs-response minus its envelope fields. */
export type FsResult =
  | { ok: true; data?: string; entries?: FsEntry[]; stat?: FsStat; truncated?: boolean }
  | { ok: false; error: FsError };

/**
 * How much a remote mount may do to a given path inside an agent folder.
 *
 *  - `writable`     — create, overwrite, delete, rename freely.
 *  - `mutable-only` — may be deleted or renamed AWAY, never created or
 *                     overwritten. Exactly one thing needs this: a message file
 *                     sitting in `inbox/`. The agent's job is to handle it and
 *                     move it to `inbox/.done/`; writing one would be forging
 *                     mail from another agent.
 *  - `read-only`    — readable, never mutated.
 */
export type HiveWriteClass = 'writable' | 'mutable-only' | 'read-only';

/**
 * THE WRITE POLICY, derived from what src/main/hive.ts actually does.
 *
 * Who writes what, on the local floor (hive.ts, HIVE.md, and the PROTOCOL.md the
 * hive itself generates):
 *
 *   identity.md   HARNESS. `ensureAgent()` rewrites it on every spawn from the
 *                 registry; PROTOCOL.md tells the agent "read-only; the harness
 *                 writes it". An agent write would be silently reverted anyway.
 *   memory.md     AGENT. Seeded once if missing, then never touched by the
 *                 harness — "append durable facts" is instruction #2 and #4 in
 *                 every injected prompt. Read AND write.
 *   inbox/*.json  ROUTER (`deliver()` → atomicWriteJson into the recipient's
 *                 inbox). The agent READS them and MOVES handled ones into
 *                 `inbox/.done/`. So: readable, deletable, renameable — not
 *                 creatable. `inbox/.done/` itself is the agent's, fully.
 *   outbox/*.json AGENT. The one outbound channel ("write ONE message JSON into
 *                 outbox"). `routeOnce()` drains it and archives into
 *                 `outbox/.sent/`. Fully writable.
 *   cursor.json   HARNESS. `drainForStop()` owns it — it is the "which inbox
 *                 messages has this agent already been shown" watermark. An agent
 *                 that could write it could re-fire or suppress its own wakeups.
 *   settings.json HARNESS. The Claude Code `--settings` file: hook commands,
 *                 permissions, sandbox writable dirs. Writable = the agent
 *                 rewrites its own guardrails.
 *   .gitignore    HARNESS (`ensureMineIgnore`).
 *   .claude/,     HARNESS / provider state (bundled skills, per-agent CODEX_HOME,
 *   .codex/, …    OpenCode plugin dirs). `.codex/` in particular contains
 *                 SYMLINKS to the user's real `~/.codex` — see the realpath gate
 *                 in `resolveWithinAgentDir`, which is what stops a read there
 *                 from leaving the sandbox.
 *
 * The top-level `inbox/` and `outbox/` DIRECTORIES themselves are read-only: a
 * mount may fill them, never delete them out from under the router.
 *
 * Everything not named above is read-only rather than writable — a default-deny,
 * so a future harness-owned file added to the agent folder is protected the day
 * it appears instead of the day someone remembers to update this list.
 *
 * @param rel a path relative to the agent folder, already syntax-checked.
 */
export function hiveWriteClass(rel: string): HiveWriteClass {
  const segs = rel.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
  if (segs.length === 0) return 'read-only'; // the agent folder itself
  const [head] = segs;

  if (head === 'memory.md') return segs.length === 1 ? 'writable' : 'read-only';

  if (head === 'outbox') {
    if (segs.length === 1) return 'read-only'; // never delete the mailbox itself
    return 'writable'; // includes .sent/ — the archive is the router's, but a
                       // mount that moves its own sent mail there is harmless
  }

  if (head === 'inbox') {
    if (segs.length === 1) return 'read-only';
    if (segs[1] === '.done') return segs.length === 2 ? 'read-only' : 'writable';
    // A live inbound message: handle it and move it on, do not author it.
    return 'mutable-only';
  }

  return 'read-only';
}

/** Ops that mutate their `path`, and what class that path must have. */
function mutationAllowed(cls: HiveWriteClass, kind: 'create' | 'remove'): boolean {
  if (cls === 'writable') return true;
  if (cls === 'mutable-only') return kind === 'remove';
  return false;
}

/** Windows compares paths case-insensitively; POSIX does not. */
function samePathPrefix(prefix: string, candidate: string): boolean {
  if (process.platform !== 'win32') return candidate === prefix || candidate.startsWith(prefix + sep);
  const p = prefix.toLowerCase();
  const c = candidate.toLowerCase();
  return c === p || c.startsWith(p + sep);
}

export interface ResolvedPath {
  /** The agent folder, absolute. */
  base: string;
  /** The requested path, absolute, PROVEN to be inside `base`. */
  full: string;
  /** What a mount may do to it. */
  cls: HiveWriteClass;
}

/**
 * Resolve a relative request path inside one agent's hive folder, or refuse.
 *
 * Exported separately from the host so the path sandbox can be tested as a pure
 * function against a table of attack strings — the containment rule is the single
 * most important line in this file and it deserves to be provable without a
 * WebSocket in the way.
 *
 * The `realpath` pass is deliberately done on the nearest EXISTING ancestor when
 * the target does not exist yet (a create), because a path component that does
 * not exist cannot be a symlink, but its parent very much can.
 */
export async function resolveWithinAgentDir(
  agentsRoot: string,
  agentId: string,
  rel: string
): Promise<{ ok: true; resolved: ResolvedPath } | { ok: false; error: FsError }> {
  if (!isValidAgentId(agentId)) return { ok: false, error: FS_ERRORS.UNAUTHORIZED_AGENT };
  if (!isSafeRelPath(rel)) return { ok: false, error: FS_ERRORS.PATH_ESCAPE };

  const root = resolve(agentsRoot);
  const base = resolve(root, agentId);
  // `agentId` has no separators, so this can only fail if it somehow became a
  // path anyway. Belt and braces: the folder must be a DIRECT child of agents/.
  if (dirname(base) !== root) return { ok: false, error: FS_ERRORS.PATH_ESCAPE };

  const full = resolve(base, rel);
  // The prefix check that matters: with the separator appended, `…/orion-x` no
  // longer "contains" `…/orion-x-evil`.
  if (!samePathPrefix(base, full)) return { ok: false, error: FS_ERRORS.PATH_ESCAPE };

  // Second pass, through the real filesystem: `resolve` is pure string algebra
  // and cannot see a symlink pointing out of the sandbox.
  let realBase: string;
  try {
    realBase = await realpathAsync(base);
  } catch {
    return { ok: false, error: FS_ERRORS.AGENT_NOT_FOUND };
  }
  let probe = full;
  for (;;) {
    try {
      const realProbe = await realpathAsync(probe);
      if (!samePathPrefix(realBase, realProbe)) return { ok: false, error: FS_ERRORS.PATH_ESCAPE };
      break;
    } catch {
      const parent = dirname(probe);
      // Walked above the sandbox without finding anything that exists: the base
      // itself resolved, so this cannot happen unless the tree changed mid-flight.
      if (parent === probe || !samePathPrefix(base, parent)) {
        return { ok: false, error: FS_ERRORS.PATH_ESCAPE };
      }
      probe = parent;
    }
  }

  return { ok: true, resolved: { base, full, cls: hiveWriteClass(rel) } };
}

/** Map a Node fs error onto the closed set of codes a FUSE layer can act on. */
function codeFor(err: unknown, fallback: FsError = FS_ERRORS.IO_ERROR): FsError {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'ENOENT': return FS_ERRORS.NOT_FOUND;
    case 'ENOTDIR': return FS_ERRORS.NOT_A_DIRECTORY;
    case 'EISDIR': return FS_ERRORS.IS_A_DIRECTORY;
    case 'EEXIST': return FS_ERRORS.EXISTS;
    case 'ENOTEMPTY': return FS_ERRORS.NOT_EMPTY;
    case 'EACCES':
    case 'EPERM': return FS_ERRORS.PERMISSION_DENIED;
    case 'EINVAL': return FS_ERRORS.INVALID_REQUEST;
    case 'EFBIG': return FS_ERRORS.TOO_LARGE;
    default: return fallback;
  }
}

function statView(s: { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number; mode: number }, cls: HiveWriteClass): FsStat {
  return {
    type: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other',
    size: s.size,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    birthtimeMs: s.birthtimeMs,
    mode: s.mode,
    writable: cls === 'writable'
  };
}

export interface HiveFsHostOptions {
  /**
   * Absolute path of `<harnessHome>/hive/agents`, or null when the hive is off.
   * A function, not a string, because harnessHome is user-configurable at
   * runtime — the same reason HiveManager takes `getHome()`.
   */
  agentsRoot: () => string | null;
  /** May this connection act on this agent id at all? Gate #1. */
  isAuthorized: (agentId: string) => boolean;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/**
 * Executes fs-requests against one machine's hive. One instance per remote
 * connection, so `isAuthorized` can be that connection's own grant set.
 */
export class HiveFsHost {
  private readonly agentsRoot: () => string | null;
  private readonly isAuthorized: (agentId: string) => boolean;
  private readonly log: Pick<Console, 'log' | 'warn'>;

  constructor(opts: HiveFsHostOptions) {
    this.agentsRoot = opts.agentsRoot;
    this.isAuthorized = opts.isAuthorized;
    this.log = opts.logger ?? console;
  }

  /**
   * Run one request. NEVER throws and never rejects: a filesystem layer needs an
   * errno for every call, so every failure — including a bug in here — comes back
   * as `{ ok:false, error }`.
   */
  async handle(req: FsRequest): Promise<FsResult> {
    try {
      return await this.execute(req);
    } catch (err) {
      this.log.warn(`[remote-fs] ${req.op} ${req.agentId}:${req.path} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: codeFor(err) };
    }
  }

  private async execute(req: FsRequest): Promise<FsResult> {
    const root = this.agentsRoot();
    if (!root) return { ok: false, error: FS_ERRORS.AGENT_NOT_FOUND };

    // Gate 1 — authorization. Before any path math, so an unauthorized id cannot
    // even be used to probe which agent folders exist.
    if (!this.isAuthorized(req.agentId)) {
      this.log.warn(`[remote-fs] refused ${req.op} for unauthorized agent "${req.agentId}"`);
      return { ok: false, error: FS_ERRORS.UNAUTHORIZED_AGENT };
    }

    // Gate 2 — the sandbox.
    const target = await resolveWithinAgentDir(root, req.agentId, req.path);
    if (!target.ok) {
      if (target.error === FS_ERRORS.PATH_ESCAPE) {
        // Loud on purpose: a well-behaved mount never produces one of these, so
        // every line here is either a bug in a mount or an attempt to get out.
        this.log.warn(`[remote-fs] PATH ESCAPE REJECTED — agent "${req.agentId}" op "${req.op}" path ${JSON.stringify(req.path)}`);
      }
      return { ok: false, error: target.error };
    }
    const { base, full, cls } = target.resolved;

    // The agent folder must exist. Its absence is a distinct code so a mount can
    // tell "no such agent" from "no such file inside the agent".
    try {
      const baseStat = await statAsync(base);
      if (!baseStat.isDirectory()) return { ok: false, error: FS_ERRORS.AGENT_NOT_FOUND };
    } catch {
      return { ok: false, error: FS_ERRORS.AGENT_NOT_FOUND };
    }

    switch (req.op) {
      case 'read': return this.opRead(full, cls);
      case 'write': return this.opWrite(req, full, cls);
      case 'readdir': return this.opReaddir(req, full);
      case 'stat': return this.opStat(full, cls);
      case 'mkdir': return this.opMkdir(full, cls);
      case 'unlink': return this.opUnlink(full, cls);
      case 'rmdir': return this.opRmdir(full, cls);
      case 'rename': return this.opRename(req, root, cls, full);
      default: return { ok: false, error: FS_ERRORS.UNSUPPORTED_OP };
    }
  }

  private async opRead(full: string, cls: HiveWriteClass): Promise<FsResult> {
    const s = await statAsync(full);
    if (s.isDirectory()) return { ok: false, error: FS_ERRORS.IS_A_DIRECTORY };
    if (s.size > MAX_FS_FILE_BYTES) return { ok: false, error: FS_ERRORS.TOO_LARGE };
    const buf = await readFileAsync(full);
    // base64 of RAW BYTES — never of a decoded string. A hive folder can hold a
    // binary (an agent's screenshot, a downloaded artifact) and a UTF-8 round
    // trip would replace every invalid byte with U+FFFD.
    return { ok: true, data: buf.toString('base64'), stat: statView(s, cls) };
  }

  private async opWrite(req: FsRequest, full: string, cls: HiveWriteClass): Promise<FsResult> {
    if (!mutationAllowed(cls, 'create')) return { ok: false, error: FS_ERRORS.READ_ONLY };
    const buf = Buffer.from(req.data ?? '', 'base64');
    if (buf.length > MAX_FS_FILE_BYTES) return { ok: false, error: FS_ERRORS.TOO_LARGE };
    try {
      const existing = await lstatAsync(full);
      if (existing.isDirectory()) return { ok: false, error: FS_ERRORS.IS_A_DIRECTORY };
    } catch {
      // Not there yet — a create. The parent still has to exist (below).
    }
    // Atomic, for the same reason hive.ts writes messages atomically: the router
    // polls these directories, and a half-written outbox JSON would be parsed,
    // quarantined as malformed, and lost. The `.tmp` suffix is also what keeps
    // the in-flight file invisible to routeOnce(), which only reads `*.json`.
    const tmp = `${full}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFileAsync(tmp, buf);
      await renameAsync(tmp, full);
    } catch (err) {
      try { await unlinkAsync(tmp); } catch { /* nothing to clean up */ }
      return { ok: false, error: codeFor(err) };
    }
    const s = await statAsync(full);
    return { ok: true, stat: statView(s, cls) };
  }

  private async opReaddir(req: FsRequest, full: string): Promise<FsResult> {
    let names: string[];
    try {
      names = await readdirAsync(full);
    } catch (err) {
      return { ok: false, error: codeFor(err) };
    }
    const truncated = names.length > MAX_FS_ENTRIES;
    const entries: FsEntry[] = [];
    for (const name of names.slice(0, MAX_FS_ENTRIES)) {
      try {
        // lstat, not stat: a symlink is reported as what it is rather than as
        // whatever it points at, so a mount never sees a directory that is really
        // a door out of the sandbox.
        const s = await lstatAsync(join(full, name));
        entries.push({
          name,
          type: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other',
          size: s.size,
          mtimeMs: s.mtimeMs
        });
      } catch {
        // Vanished between readdir and lstat — a live hive is being written to.
        // Skipping it is more useful than failing the whole listing.
      }
    }
    return { ok: true, entries, ...(truncated ? { truncated: true } : {}) };
  }

  private async opStat(full: string, cls: HiveWriteClass): Promise<FsResult> {
    const s = await lstatAsync(full);
    return { ok: true, stat: statView(s, cls) };
  }

  private async opMkdir(full: string, cls: HiveWriteClass): Promise<FsResult> {
    if (!mutationAllowed(cls, 'create')) return { ok: false, error: FS_ERRORS.READ_ONLY };
    try {
      // Non-recursive on purpose: `mkdir -p` semantics would let one call create
      // a whole tree, and a FUSE mkdir is a single directory by definition.
      await mkdirAsync(full);
    } catch (err) {
      return { ok: false, error: codeFor(err) };
    }
    return { ok: true };
  }

  private async opUnlink(full: string, cls: HiveWriteClass): Promise<FsResult> {
    if (!mutationAllowed(cls, 'remove')) return { ok: false, error: FS_ERRORS.READ_ONLY };
    const s = await lstatAsync(full);
    // Windows reports EPERM for unlink-on-directory; answer the POSIX way.
    if (s.isDirectory()) return { ok: false, error: FS_ERRORS.IS_A_DIRECTORY };
    await unlinkAsync(full);
    return { ok: true };
  }

  private async opRmdir(full: string, cls: HiveWriteClass): Promise<FsResult> {
    if (!mutationAllowed(cls, 'remove')) return { ok: false, error: FS_ERRORS.READ_ONLY };
    const s = await lstatAsync(full);
    if (!s.isDirectory()) return { ok: false, error: FS_ERRORS.NOT_A_DIRECTORY };
    try {
      await rmdirAsync(full);
    } catch (err) {
      return { ok: false, error: codeFor(err) };
    }
    return { ok: true };
  }

  private async opRename(req: FsRequest, root: string, cls: HiveWriteClass, full: string): Promise<FsResult> {
    // BOTH ends get the full treatment. A rename is a delete at the source and a
    // create at the destination, and the destination is the interesting one: it
    // is how `inbox/x.json` legitimately becomes `inbox/.done/x.json`, and how a
    // careless mount would otherwise turn a writable file into `identity.md`.
    const dest = await resolveWithinAgentDir(root, req.agentId, req.newPath ?? '');
    if (!dest.ok) {
      if (dest.error === FS_ERRORS.PATH_ESCAPE) {
        this.log.warn(`[remote-fs] PATH ESCAPE REJECTED — agent "${req.agentId}" rename destination ${JSON.stringify(req.newPath)}`);
      }
      return { ok: false, error: dest.error };
    }
    if (!mutationAllowed(cls, 'remove')) return { ok: false, error: FS_ERRORS.READ_ONLY };
    if (!mutationAllowed(dest.resolved.cls, 'create')) return { ok: false, error: FS_ERRORS.READ_ONLY };
    try {
      await renameAsync(full, dest.resolved.full);
    } catch (err) {
      return { ok: false, error: codeFor(err) };
    }
    return { ok: true };
  }
}
