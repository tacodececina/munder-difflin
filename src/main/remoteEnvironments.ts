/**
 * Remote environments registry + encrypted secret store (Phase 3b, main process).
 *
 * A deliberate sibling of src/main/integrations.ts, following the SAME pattern
 * for the same reasons — this file is not inventing a secret-handling policy, it
 * is reusing the one that already shipped:
 *
 *   1. Registry — config-backed CRUD over RemoteEnvironment metadata (NO secrets).
 *   2. Secret store — the daemon's 32-byte HMAC secret ENCRYPTED AT REST via
 *      Electron `safeStorage`, in a file SEPARATE from config.json, decrypted
 *      only here, only in main.
 *
 * SECURITY: a secret is never written unless `safeStorage.isEncryptionAvailable()`
 * (fail closed — no plaintext fallback), never returned to the renderer, never
 * logged, never placed in agent env/transcript. The environment record the
 * renderer sees has no field a secret could live in.
 *
 * Why a separate file from integration-secrets.json rather than a shared blob:
 * the two lifecycles are independent (unpair a machine, keep your API keys), and
 * a corrupt/undecryptable blob in one must not take the other down with it.
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type RemoteEnvironment,
  remoteSecretRefFor,
  isValidRemoteHost,
  isValidRemotePort,
  toRemoteEnvironmentView
} from '../shared/remoteEnvironment';
import { readConfig, writeConfig } from './config';

// ─── Registry (config-backed) ────────────────────────────────────────────────

/** Every paired environment (metadata only — this IS the renderer-safe shape). */
export function listEnvironments(): RemoteEnvironment[] {
  return (readConfig().remoteEnvironments ?? []).map(toRemoteEnvironmentView);
}

export function getEnvironment(id: string): RemoteEnvironment | undefined {
  return listEnvironments().find((e) => e.id === id);
}

/** Persist a newly-paired environment. Metadata only; the secret goes through
 *  `setRemoteSecret` and never touches config.json. */
export function addEnvironment(env: RemoteEnvironment): { ok: true; env: RemoteEnvironment } | { ok: false; error: string } {
  if (!env.id) return { ok: false, error: 'id required' };
  if (!env.name?.trim()) return { ok: false, error: 'name required' };
  if (!isValidRemoteHost(env.host)) return { ok: false, error: 'invalid host' };
  if (!isValidRemotePort(env.port)) return { ok: false, error: 'invalid port' };
  if (!env.clientId) return { ok: false, error: 'clientId required' };
  const record = toRemoteEnvironmentView({ ...env, name: env.name.trim(), host: env.host.trim() });
  const next = listEnvironments().filter((e) => e.id !== record.id);
  next.push(record);
  writeConfig({ remoteEnvironments: next });
  return { ok: true, env: record };
}

/** Forget an environment AND its stored secret. Idempotent. */
export function removeEnvironment(id: string): { ok: boolean } {
  const next = listEnvironments().filter((e) => e.id !== id);
  writeConfig({ remoteEnvironments: next });
  deleteRemoteSecret(id);
  return { ok: true };
}

// ─── Secret store (encrypted at rest) ────────────────────────────────────────

function secretsPath(): string {
  return join(app.getPath('userData'), 'remote-environment-secrets.json');
}

function readSecretBlob(): Record<string, string> {
  const p = secretsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeSecretBlob(blob: Record<string, string>): void {
  const p = secretsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(blob, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Store an environment's HMAC secret ENCRYPTED. Fail closed if OS encryption is
 *  unavailable — a pairing that cannot be stored safely is reported as a failure
 *  rather than persisted in the clear. */
export function setRemoteSecret(envId: string, plaintext: string): { ok: boolean; error?: string } {
  if (!envId) return { ok: false, error: 'environment id required' };
  if (typeof plaintext !== 'string' || plaintext === '') return { ok: false, error: 'secret required' };
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS secret encryption is unavailable; refusing to store a pairing secret in plaintext' };
    }
    const cipher = safeStorage.encryptString(plaintext).toString('base64');
    const blob = readSecretBlob();
    blob[remoteSecretRefFor(envId)] = cipher;
    writeSecretBlob(blob);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Decrypt an environment's secret. MAIN-INTERNAL ONLY — never expose this over
 *  IPC. Returns undefined if absent or undecryptable, which callers surface as
 *  "re-pair this machine". */
export function getRemoteSecret(envId: string): string | undefined {
  if (!envId) return undefined;
  const cipher = readSecretBlob()[remoteSecretRefFor(envId)];
  if (!cipher) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  } catch {
    return undefined;
  }
}

/** Whether a secret is stored for this environment (no decryption). */
export function hasRemoteSecret(envId: string): boolean {
  if (!envId) return false;
  return !!readSecretBlob()[remoteSecretRefFor(envId)];
}

/** Delete a stored secret. Idempotent. */
export function deleteRemoteSecret(envId: string): void {
  if (!envId) return;
  const ref = remoteSecretRefFor(envId);
  const blob = readSecretBlob();
  if (ref in blob) {
    delete blob[ref];
    if (Object.keys(blob).length === 0) {
      try { rmSync(secretsPath(), { force: true }); } catch { /* best-effort */ }
    } else {
      writeSecretBlob(blob);
    }
  }
}

/** Everything `RemoteDaemonClient` needs for one environment, assembled here so
 *  the decryption stays in this file. Undefined when the environment is unknown
 *  or its secret is missing/undecryptable. */
export function credentialsFor(envId: string): { host: string; port: number; clientId: string; secret: string } | undefined {
  const env = getEnvironment(envId);
  if (!env) return undefined;
  const secret = getRemoteSecret(envId);
  if (!secret) return undefined;
  return { host: env.host, port: env.port, clientId: env.clientId, secret };
}
