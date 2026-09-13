/**
 * remoteFsProtocol.ts — the filesystem-proxy wire format, GPD side.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ MIRRORED FILE — this is a hand-kept copy of the "Filesystem proxy" section │
 * │ of remote-daemon/src/protocol.js. The daemon is a separate npm package     │
 * │ with NO build step (plain CommonJS, two dependencies, deliberately), and   │
 * │ this process is TypeScript bundled by electron-vite, so neither can import │
 * │ the other without dragging a build into the daemon or the daemon into the  │
 * │ app bundle. Two ~200-line copies beat a shared package for that.           │
 * │                                                                            │
 * │ KEEP THEM IN LOCKSTEP. Same constants, same regexes, same error strings,   │
 * │ same accept/reject decisions. A divergence does not fail loudly: it shows  │
 * │ up as one side sending a frame the other silently drops, which looks like  │
 * │ a hung filesystem. test/remote-fs-proxy.test.cjs asserts the two copies    │
 * │ agree on every constant and on a table of adversarial paths — if you       │
 * │ change one file and not the other, that test is what tells you.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * DIRECTION. Every other message in remoteDaemon.ts is client-initiated: we ask
 * the daemon to spawn a PTY, it answers. The fs proxy is the opposite — the
 * REMOTE machine asks US, because the files it wants are the hive agent folders
 * on this machine:
 *
 *   remote -> GPD  { type:'fs-request',  reqId, agentId, op, path[, data][, newPath] }
 *   GPD -> remote  { type:'fs-response', reqId, ok:true[, data][, entries][, stat] }
 *                  { type:'fs-response', reqId, ok:false, error }
 *
 * `reqId` correlates them: many fs calls are in flight at once and complete out
 * of order (unlike `spawn`, which is one-shot per session id).
 *
 * The full contract — including the POSIX errno mapping a FUSE/WinFsp layer needs
 * — is remote-daemon/README-FS-PROXY.md. This file is only the validators; the
 * sandbox and the write policy are enforced in remoteFsHost.ts.
 */

/** Every operation an fs-request may carry. Anything else is `unsupported_op`. */
export const FS_OPS = ['read', 'write', 'readdir', 'stat', 'mkdir', 'unlink', 'rmdir', 'rename'] as const;
export type FsOp = (typeof FS_OPS)[number];

/** The ops for which `path:''` (the agent folder itself) is meaningful. */
export const FS_ROOT_OPS: readonly FsOp[] = ['readdir', 'stat'];
/** Ops that need a second path. */
export const FS_TWO_PATH_OPS: readonly FsOp[] = ['rename'];

export const MAX_FS_PATH_LENGTH = 1024;
/**
 * Largest file the proxy will move in one frame, RAW bytes.
 *
 * Bounded by the daemon's MAX_MESSAGE_BYTES (1 MiB): base64 inflates by 4/3, so
 * 512 KiB of file is ~683 KB on the wire and still leaves room for the JSON
 * envelope. Hive files are orders of magnitude smaller. A read of a larger file
 * fails with `too_large` rather than truncating — `stat`/`readdir` report the
 * true size, so a mount can see it coming.
 */
export const MAX_FS_FILE_BYTES = 512 * 1024;
/** Cap on one readdir reply, so a pathological directory cannot blow the frame. */
export const MAX_FS_ENTRIES = 4096;
/** How many fs requests one connection may have in flight before it gets `busy`. */
export const MAX_FS_INFLIGHT = 64;
/** Same bound the daemon puts on a reqId / session id. */
const MAX_ID_LENGTH = 128;

/**
 * The error strings an fs-response may carry — a CLOSED set on purpose: a
 * FUSE/WinFsp layer maps each to a POSIX errno (see README-FS-PROXY.md), and a
 * free-text message cannot be mapped, only logged.
 */
export const FS_ERRORS = {
  NOT_FOUND: 'not_found',
  NOT_A_DIRECTORY: 'not_a_directory',
  IS_A_DIRECTORY: 'is_a_directory',
  NOT_EMPTY: 'not_empty',
  EXISTS: 'exists',
  PATH_ESCAPE: 'path_escape',
  UNAUTHORIZED_AGENT: 'unauthorized_agent',
  AGENT_NOT_FOUND: 'agent_not_found',
  READ_ONLY: 'read_only',
  PERMISSION_DENIED: 'permission_denied',
  TOO_LARGE: 'too_large',
  INVALID_REQUEST: 'invalid_request',
  UNSUPPORTED_OP: 'unsupported_op',
  BUSY: 'busy',
  IO_ERROR: 'io_error',
  TIMEOUT: 'timeout',
  DISCONNECTED: 'disconnected'
} as const;
export type FsError = (typeof FS_ERRORS)[keyof typeof FS_ERRORS];
export const FS_ERROR_VALUES: readonly string[] = Object.values(FS_ERRORS);

/** One `readdir` row — enough for a FUSE layer to fill a dirent AND a getattr. */
export interface FsEntry {
  name: string;
  type: 'file' | 'dir' | 'other';
  size: number;
  mtimeMs: number;
}

/** What `stat` returns for a single path. */
export interface FsStat {
  type: 'file' | 'dir' | 'other';
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  /** POSIX-style mode bits as reported by node's fs.Stats (advisory on Windows). */
  mode: number;
  /** False when the path is inside the sandbox but the hive policy forbids writes. */
  writable: boolean;
}

export interface FsRequest {
  type: 'fs-request';
  reqId: string;
  agentId: string;
  op: FsOp;
  /** ALWAYS relative to the agent folder. '' means the folder itself. */
  path: string;
  /** base64 of the RAW file bytes (write only). */
  data?: string;
  /** rename only. */
  newPath?: string;
}

export type FsResponse =
  | { type: 'fs-response'; reqId: string; ok: true; data?: string; entries?: FsEntry[]; stat?: FsStat }
  | { type: 'fs-response'; reqId: string; ok: false; error: FsError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Base64 with no stray characters — rejected before it reaches Buffer.from. */
export function isBase64(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0;
}

/**
 * Agent ids address a DIRECTORY NAME, so the alphabet is deliberately narrower
 * than a session id's: no `:` (a `c:foo` argument makes `path.resolve` produce a
 * drive-relative path on Windows and walk straight out of the sandbox), no
 * separators, and never `.`/`..`.
 */
export function isValidAgentId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128
    && /^[A-Za-z0-9_.-]+$/.test(v) && v !== '.' && v !== '..';
}

/** Request ids are daemon-chosen; same safe alphabet as a session id. */
export function isValidReqId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH && /^[\w.:-]+$/.test(v);
}

/**
 * Is this a path we are willing to resolve against an agent folder AT ALL?
 *
 * This is the FIRST of two gates and it is purely syntactic — the second (and
 * authoritative) one is the resolve-then-verify-prefix check in remoteFsHost.ts,
 * plus a realpath check that a symlink inside the folder does not point out of
 * it. Neither replaces the other: this one rejects the obvious attacks cheaply
 * and identically on both sides of the wire, so a malformed path never even
 * reaches an `fs` call.
 *
 * Rejected: absolute paths (POSIX or Windows), UNC paths, drive-relative paths,
 * any `..` segment, `:` anywhere (drive letters and NTFS alternate data streams),
 * NUL and other control characters, and anything over MAX_FS_PATH_LENGTH.
 * Accepted: '' (meaning the agent folder itself) and forward- or back-slash
 * separated relative paths.
 */
export function isSafeRelPath(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v.length > MAX_FS_PATH_LENGTH) return false;
  if (v === '') return true;
  // Control characters (NUL included) never belong in a hive path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  // Drive letters, ADS, and anything else that gives `:` meaning to a path API.
  if (v.includes(':')) return false;
  // Absolute (both flavours) and UNC.
  if (v.startsWith('/') || v.startsWith('\\')) return false;
  const segments = v.split(/[/\\]+/);
  for (const seg of segments) {
    if (seg === '..') return false;
    // A trailing separator leaves an empty last segment; that is benign.
    if (seg === '' || seg === '.') continue;
    // Windows silently strips trailing dots/spaces, which would let
    // `identity.md ` address `identity.md` while classifying as something else.
    if (/[. ]$/.test(seg)) return false;
  }
  return true;
}

/** Validate an inbound fs-request (remote -> GPD). */
export function validateFsRequest(
  msg: unknown
): { ok: true; request: FsRequest } | { ok: false; error: FsError; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, error: FS_ERRORS.INVALID_REQUEST, reason });
  if (!isPlainObject(msg)) return bad('fs-request must be a JSON object');
  if (msg.type !== 'fs-request') return bad('not an fs-request');
  if (!isValidReqId(msg.reqId)) return bad('fs-request requires a valid "reqId"');
  if (!isValidAgentId(msg.agentId)) return bad('fs-request requires a valid "agentId"');
  if (typeof msg.op !== 'string' || !(FS_OPS as readonly string[]).includes(msg.op)) {
    return { ok: false, error: FS_ERRORS.UNSUPPORTED_OP, reason: `unknown op "${String(msg.op).slice(0, 32)}"` };
  }
  const op = msg.op as FsOp;
  if (!isSafeRelPath(msg.path)) {
    return { ok: false, error: FS_ERRORS.PATH_ESCAPE, reason: 'fs-request "path" is not a safe relative path' };
  }
  if (msg.path === '' && !FS_ROOT_OPS.includes(op)) {
    return bad(`op "${op}" needs a non-empty "path"`);
  }
  if (FS_TWO_PATH_OPS.includes(op)) {
    if (!isSafeRelPath(msg.newPath)) {
      return { ok: false, error: FS_ERRORS.PATH_ESCAPE, reason: 'fs-request "newPath" is not a safe relative path' };
    }
    // '' is a legal PATH (the agent folder) but never a legal DESTINATION.
    if (msg.newPath === '') return bad(`op "${op}" needs a non-empty "newPath"`);
  }
  if (op === 'write') {
    if (!isBase64(msg.data)) return bad('write "data" must be base64');
    // 4 base64 chars per 3 bytes — check before allocating a Buffer for it.
    if (msg.data.length > Math.ceil(MAX_FS_FILE_BYTES / 3) * 4) {
      return { ok: false, error: FS_ERRORS.TOO_LARGE, reason: 'write "data" exceeds the size limit' };
    }
  }
  return {
    ok: true,
    request: {
      type: 'fs-request',
      reqId: msg.reqId as string,
      agentId: msg.agentId as string,
      op,
      path: msg.path as string,
      ...(typeof msg.data === 'string' ? { data: msg.data } : {}),
      ...(typeof msg.newPath === 'string' ? { newPath: msg.newPath } : {})
    }
  };
}

/**
 * Validate an fs-response (GPD -> remote). Structural only — the daemon's
 * FsProxy still matches it to a pending request before anything acts on it.
 * Mirrors `validateFsResponse` in remote-daemon/src/protocol.js.
 */
export function validateFsResponse(msg: unknown): { ok: true } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!isPlainObject(msg)) return bad('fs-response must be a JSON object');
  if (!isValidReqId(msg.reqId)) return bad('fs-response requires a valid "reqId"');
  if (typeof msg.ok !== 'boolean') return bad('fs-response requires boolean "ok"');
  if (!msg.ok) {
    if (typeof msg.error !== 'string' || !FS_ERROR_VALUES.includes(msg.error)) {
      return bad('fs-response "error" is not a known code');
    }
    return { ok: true };
  }
  if (msg.data !== undefined) {
    if (!isBase64(msg.data)) return bad('fs-response "data" must be base64');
    if (msg.data.length > Math.ceil(MAX_FS_FILE_BYTES / 3) * 4) return bad('fs-response "data" too large');
  }
  if (msg.entries !== undefined) {
    if (!Array.isArray(msg.entries) || msg.entries.length > MAX_FS_ENTRIES) {
      return bad('fs-response "entries" must be a bounded array');
    }
    for (const e of msg.entries) {
      if (!isPlainObject(e) || typeof e.name !== 'string' || typeof e.type !== 'string') {
        return bad('fs-response entry must be { name, type, size, mtimeMs }');
      }
    }
  }
  if (msg.stat !== undefined && !isPlainObject(msg.stat)) return bad('fs-response "stat" must be an object');
  return { ok: true };
}
