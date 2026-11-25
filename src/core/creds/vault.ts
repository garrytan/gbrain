/**
 * creds/vault — the generic credential vault.
 *
 * One home for every outbound credential gbrain holds: Google OAuth tokens
 * today; Dropbox OAuth, Mac-companion bearer tokens, and any future provider
 * tomorrow. Providers register in src/core/creds/providers/; nothing in this
 * module is Google-specific.
 *
 * Two backends behind one interface:
 *  - FileVaultBackend — ~/.gbrain/credentials.json, 0600, atomic writes.
 *    The CLI / self-host default.
 *  - EngineVaultBackend — a DB-backed vault for hosted gbrain.io (per-user
 *    rows + encryption-at-rest hook). The interface is frozen here; the
 *    hosted implementation lives with the hosted product.
 *
 * Custody rules:
 *  - Secrets live ONLY in this vault (or env intake at connect time). Never
 *    in the config DB plane, never in sources.config (sources store a
 *    credential id pointer, mirroring how github sources store an env NAME).
 *  - list() returns redacted metadata only.
 *
 * No CLI imports here — prompts live in src/commands/. The hosted product
 * reuses this module unmodified.
 */

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWriteFileSync } from '../atomic-write.ts';
import { gbrainPath } from '../config.ts';
import { CredentialError } from './errors.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type CredentialKind = 'oauth2' | 'bearer' | 'api_key';

/** Which OAuth client minted this credential; routes token refresh. */
export type ClientRef = 'byo' | 'hosted-relay';

/**
 * How a byo client was made: 'personal' is Google's one-click Personal-mode
 * agent client (one Cloud project per account; only the creating account can
 * consent), 'byo' a client the owner configured by hand.
 */
export type ClientMode = 'personal' | 'byo';

export interface CredentialSecret {
  /** oauth2 */
  access_token?: string;
  refresh_token?: string;
  /** ISO expiry of access_token. */
  expiry?: string;
  /** bearer / api_key */
  token?: string;
}

export interface CredentialMetaFields {
  /** Account identity, e.g. the Google account email. */
  account?: string;
  scopes?: string[];
  /** OAuth client id that minted the tokens (byo entries). Refresh selects the client record by this id. */
  client_id?: string;
  /** How that client was made; absent on entries written before Personal mode. */
  client_mode?: ClientMode;
  /**
   * Bumped by every consent, reconnect and import of this account. A token
   * write carries the generation it read; a write whose generation no longer
   * matches (a disconnect or reconnect landed meanwhile) is refused.
   */
  grant_generation?: number;
  /** First refresh that succeeded 7+ days after consent: proof the client is not in Testing mode. */
  personal_confirmed_at?: string;
  /** Set when a refresh confirmed the stored access token is read-only (GST-3849); a cached token is trusted only then, or when the grant holds no write scope. */
  access_token_read_only?: boolean;
  connected_at: string;
  last_refresh_ok_at?: string;
  /** Gmail send-as aliases — the "my addresses" identity set. */
  sendas_aliases?: string[];
  label?: string;
  /** Best-effort inference of the consent screen's publish state. */
  consent_publish_state?: 'unknown' | 'testing' | 'production';
}

export interface CredentialEntry {
  /** Stable id: '<provider>:<account>', e.g. 'google:a@example.com'. */
  id: string;
  provider: string;
  kind: CredentialKind;
  client_ref: ClientRef;
  secret: CredentialSecret;
  meta: CredentialMetaFields;
}

/** Redacted view for list() — safe to print. */
export interface CredentialMeta {
  id: string;
  provider: string;
  kind: CredentialKind;
  client_ref: ClientRef;
  account?: string;
  scopes?: string[];
  expiry?: string;
  connected_at: string;
  last_refresh_ok_at?: string;
  sendas_aliases?: string[];
  consent_publish_state?: string;
  client_mode?: ClientMode;
  grant_generation?: number;
}

/**
 * A provider's OAuth client credentials (byo). A record without `account` is
 * the provider-wide client (the only shape a v1 vault holds); a record with
 * `account` belongs to that one account (Personal mode: one client per
 * mailbox). Writing an account record moves the file to version 2, which a v1
 * binary refuses to read instead of clobbering the per-account records.
 */
export interface ProviderClientRecord {
  provider: string;
  client_id: string;
  client_secret: string;
  created_at: string;
  account?: string;
  mode?: ClientMode;
}

export interface CredentialVault {
  get(id: string): Promise<CredentialEntry | null>;
  put(entry: CredentialEntry): Promise<void>;
  list(filter?: { provider?: string }): Promise<CredentialMeta[]>;
  delete(id: string): Promise<boolean>;
  getClient(provider: string): Promise<ProviderClientRecord | null>;
  putClient(rec: ProviderClientRecord): Promise<void>;
  deleteClient(provider: string): Promise<boolean>;
}

export function credentialId(provider: string, account: string): string {
  return `${provider}:${account.trim().toLowerCase()}`;
}

export function redactEntry(e: CredentialEntry): CredentialMeta {
  return {
    id: e.id,
    provider: e.provider,
    kind: e.kind,
    client_ref: e.client_ref,
    ...(e.meta.account !== undefined ? { account: e.meta.account } : {}),
    ...(e.meta.scopes !== undefined ? { scopes: e.meta.scopes } : {}),
    ...(e.secret.expiry !== undefined ? { expiry: e.secret.expiry } : {}),
    connected_at: e.meta.connected_at,
    ...(e.meta.last_refresh_ok_at !== undefined
      ? { last_refresh_ok_at: e.meta.last_refresh_ok_at }
      : {}),
    ...(e.meta.sendas_aliases !== undefined ? { sendas_aliases: e.meta.sendas_aliases } : {}),
    ...(e.meta.consent_publish_state !== undefined
      ? { consent_publish_state: e.meta.consent_publish_state }
      : {}),
    ...(e.meta.client_mode !== undefined ? { client_mode: e.meta.client_mode } : {}),
    ...(e.meta.grant_generation !== undefined ? { grant_generation: e.meta.grant_generation } : {}),
  };
}

/**
 * Atomic grant operations: every token write either lands against the grant
 * generation it read or is refused. The file backend implements it; the
 * Google provider uses it whenever the vault offers it.
 */
export interface GrantVault extends CredentialVault {
  /** Every client record of a provider, provider-wide and per-account. */
  listClients(provider: string): Promise<ProviderClientRecord[]>;
  /**
   * The client record whose client_id matches, or null. With `account`, that
   * account's own record wins, then the provider-wide record; another
   * account's record is returned only when nothing else matches.
   */
  getClientById(provider: string, clientId: string, account?: string): Promise<ProviderClientRecord | null>;
  /**
   * Writes a consented (or imported) grant and, when given, its per-account
   * client record, in one locked write. `expectedGeneration` is the
   * generation read before consent started (null: no entry existed). The entry
   * is written with the next generation; returns it.
   */
  commitGrant(input: { entry: CredentialEntry; client?: ProviderClientRecord; expectedGeneration: number | null }): Promise<CredentialEntry>;
  /**
   * Writes refreshed token fields onto the entry only when its generation is
   * still `expectedGeneration`. Refuses with not_connected when the entry is
   * gone and vault_generation_changed when another consent replaced it.
   */
  casUpdateTokens(id: string, expectedGeneration: number, patch: { secret: Partial<CredentialSecret>; meta: Partial<CredentialMetaFields> }): Promise<CredentialEntry>;
  /**
   * Takes the per-grant refresh lease, held across the network refresh so one
   * refresh token is never rotated twice at once; resolves to its release.
   * Refuses with refresh_lease_busy after a bounded wait. Optional: a vault
   * without it refreshes unleased and relies on casUpdateTokens alone.
   */
  leaseRefresh?(id: string, generation: number): Promise<() => void>;
}

export function isGrantVault(v: CredentialVault): v is GrantVault {
  const g = v as Partial<GrantVault>;
  return typeof g.commitGrant === 'function' && typeof g.casUpdateTokens === 'function' && typeof g.getClientById === 'function';
}

/** The generation an entry was read at (entries written before generations exist read as 0). */
export function grantGeneration(e: CredentialEntry | null): number | null {
  return e ? (e.meta.grant_generation ?? 0) : null;
}

// ── File backend ─────────────────────────────────────────────────────────────

export interface VaultFileShape {
  version: 1 | 2;
  clients: ProviderClientRecord[];
  credentials: Record<string, CredentialEntry>;
  /** Last generation per credential id, kept past a disconnect so a reconnect never reuses a number. */
  grant_generations?: Record<string, number>;
}

export function credentialsPath(): string {
  return gbrainPath('credentials.json');
}

function emptyVault(): VaultFileShape {
  return { version: 1, clients: [], credentials: {} };
}

/**
 * Parse tolerantly: unknown fields are preserved-by-drop (we re-serialize
 * known fields only), a corrupt file surfaces loudly rather than silently
 * resetting — a reset would orphan refresh tokens the user can't recover.
 */
export function parseVaultFile(raw: string): VaultFileShape {
  const parsed = JSON.parse(raw) as Partial<VaultFileShape>;
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`Unsupported credentials.json version: ${String(parsed.version)}`);
  }
  const generations = parsed.grant_generations && typeof parsed.grant_generations === 'object' ? parsed.grant_generations : undefined;
  return {
    version: parsed.version,
    clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    credentials:
      parsed.credentials && typeof parsed.credentials === 'object'
        ? (parsed.credentials as Record<string, CredentialEntry>)
        : {},
    ...(generations ? { grant_generations: generations } : {}),
  };
}

/**
 * The version a shape must be written as: 2 as soon as it holds a
 * per-account client record, because a v1 binary's putClient would delete
 * every record of the provider and its getClient could hand a per-account
 * client to a sibling account. v1 refuses to read a version 2 file.
 */
export function vaultVersionFor(shape: Pick<VaultFileShape, 'clients'>): 1 | 2 {
  return shape.clients.some((c) => typeof c.account === 'string' && c.account.length > 0) ? 2 : 1;
}

function sameClientSlot(a: ProviderClientRecord, b: ProviderClientRecord): boolean {
  return a.provider === b.provider && (a.account ?? '') === (b.account ?? '');
}

const LOCK_WAIT_MS = 5_000;
/** No network call runs inside the vault lock, so a holder this old is gone. */
const LOCK_STALE_MS = 60_000;

interface LockOwner { pid: number; nonce: string; at: number }

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<LockOwner>;
    return typeof o.pid === 'number' && typeof o.nonce === 'string' && typeof o.at === 'number' ? (o as LockOwner) : null;
  } catch { // silent-read-ok: a lock file that is gone or half-written has no owner to judge; the caller retries or judges it by age
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A steal takes microseconds, so a steal guard this old was left by a stealer that died. */
const STEAL_GUARD_STALE_MS = 5_000;

/**
 * Takes over a lock whose holder is dead (or older than LOCK_STALE_MS). Only
 * one process steals at a time (an exclusive `.steal` guard), and it removes
 * the lock only while the file there is still the one it judged stale, so a
 * successor's live lock is never moved or removed. Returns false while another
 * process holds the guard, so the caller waits instead of spinning.
 */
function stealStaleLock(lockPath: string, judged: LockOwner | null, mtimeMs: number): boolean {
  const guard = `${lockPath}.steal`;
  try {
    closeSync(openSync(guard, 'wx', 0o600));
  } catch {
    try {
      if (Date.now() - statSync(guard).mtimeMs > STEAL_GUARD_STALE_MS) rmSync(guard, { force: true });
    } catch { /* silent-read-ok: the guard was released while we looked; the caller retries */ }
    return false;
  }
  try {
    const got = readLockOwner(lockPath);
    let same = false;
    if (judged) same = got?.nonce === judged.nonce;
    else {
      try { same = got === null && Math.abs(statSync(lockPath).mtimeMs - mtimeMs) < 1; } catch { /* silent-read-ok: the lock is already gone; nothing to remove */ }
    }
    if (same) rmSync(lockPath, { force: true });
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
}

/**
 * Cross-process mutation lock for the vault's read-modify-write. It fails
 * closed: when the lock cannot be taken within LOCK_WAIT_MS, or the lock file
 * cannot be created at all, the write is refused with vault_lock_busy and
 * nothing is written or issued unlocked. Only a lock whose holder process is
 * gone, or one older than LOCK_STALE_MS, is taken over. Exported for tests.
 */
export function withVaultLock<T>(vaultPath: string, fn: () => T, waitMs: number = LOCK_WAIT_MS): T {
  const lockPath = `${vaultPath}.lock`;
  mkdirSync(dirname(vaultPath), { recursive: true });
  const me: LockOwner = { pid: process.pid, nonce: randomBytes(8).toString('hex'), at: Date.now() };
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw new CredentialError('vault_lock_busy', ` (${lockPath}: ${code ?? 'unknown error'})`, e);
      let mtimeMs: number | null = null;
      try { mtimeMs = statSync(lockPath).mtimeMs; } catch { continue; }
      const owner = readLockOwner(lockPath);
      const ownerHere = owner !== null && owner.pid !== process.pid;
      if ((ownerHere && !pidAlive(owner.pid)) || Date.now() - mtimeMs > LOCK_STALE_MS) {
        if (stealStaleLock(lockPath, owner, mtimeMs)) continue;
      }
      if (Date.now() > deadline) throw new CredentialError('vault_lock_busy', ` (${lockPath} held${owner ? ` by pid ${owner.pid}` : ''})`);
      const until = Date.now() + 25;
      while (Date.now() < until) { /* brief sync spin — CLI-scale contention */ }
      continue;
    }
    try {
      writeSync(fd, JSON.stringify(me));
    } finally {
      closeSync(fd);
    }
    break;
  }
  try {
    return fn();
  } finally {
    if (readLockOwner(lockPath)?.nonce === me.nonce) rmSync(lockPath, { force: true });
  }
}

const LEASE_WAIT_MS = 30_000;
const LEASE_STALE_MS = 120_000;

function readLease(leasePath: string): { pid?: number; nonce?: string } | null {
  try { return JSON.parse(readFileSync(leasePath, 'utf-8')) as { pid?: number; nonce?: string }; } catch { return null; } // silent-read-ok: a lease file that is gone or half-written has no holder to judge; the caller retries the create
}

/**
 * The per-grant refresh lease: a lock file beside the vault, recording pid,
 * generation and a nonce, held across the network refresh so two refreshes,
 * in this process or another, never rotate one refresh token at once. It is
 * separate from the vault lock, which is never held across a network call.
 * A holder in this same process is waited for, never taken over.
 */
async function acquireRefreshLease(vaultPath: string, id: string, generation: number): Promise<() => void> {
  const leasePath = `${vaultPath}.${createHash('sha256').update(id).digest('hex').slice(0, 12)}.lease`;
  mkdirSync(dirname(vaultPath), { recursive: true });
  const nonce = randomBytes(8).toString('hex');
  const deadline = Date.now() + LEASE_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(leasePath, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, generation, nonce, at: Date.now() })); } finally { closeSync(fd); }
      return () => { if (readLease(leasePath)?.nonce === nonce) rmSync(leasePath, { force: true }); };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw new CredentialError('refresh_lease_busy', ` (${code ?? 'unknown error'})`, e);
    }
    const holder = readLease(leasePath);
    let age = 0;
    try { age = Date.now() - statSync(leasePath).mtimeMs; } catch { continue; }
    const dead = typeof holder?.pid === 'number' && holder.pid !== process.pid && !pidAlive(holder.pid);
    if (dead || age > LEASE_STALE_MS) {
      if (readLease(leasePath)?.nonce === holder?.nonce) rmSync(leasePath, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new CredentialError('refresh_lease_busy', ` for ${id}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export class FileVaultBackend implements GrantVault {
  constructor(readonly path: string = credentialsPath()) {}

  leaseRefresh(id: string, generation: number): Promise<() => void> {
    return acquireRefreshLease(this.path, id, generation);
  }

  private read(): VaultFileShape {
    if (!existsSync(this.path)) return emptyVault();
    const raw = readFileSync(this.path, 'utf-8');
    if (raw.trim() === '') return emptyVault();
    try {
      return parseVaultFile(raw);
    } catch (e) {
      throw new Error(
        `Credential vault at ${this.path} is unreadable (${e instanceof Error ? e.message : String(e)}). ` +
          `Refusing to overwrite it — inspect or move the file, then retry.`,
      );
    }
  }

  /**
   * 0600 discipline: atomicWriteFileSync preserves an EXISTING target's mode
   * but creates new files at 0644 — so a missing vault is pre-created empty
   * at 0600 first, and the atomic write inherits that mode. No window where
   * secrets sit group/world-readable.
   */
  private write(shape: VaultFileShape): void {
    const dir = gbrainPath();
    mkdirSync(dir, { recursive: true });
    if (!existsSync(this.path)) {
      closeSync(openSync(this.path, 'w', 0o600));
    }
    const out: VaultFileShape = { ...shape, version: vaultVersionFor(shape) };
    atomicWriteFileSync(this.path, JSON.stringify(out, null, 2) + '\n');
  }

  async get(id: string): Promise<CredentialEntry | null> {
    return this.read().credentials[id] ?? null;
  }

  async put(entry: CredentialEntry): Promise<void> {
    withVaultLock(this.path, () => {
      const shape = this.read();
      shape.credentials[entry.id] = entry;
      this.write(shape);
    });
  }

  async list(filter?: { provider?: string }): Promise<CredentialMeta[]> {
    const shape = this.read();
    return Object.values(shape.credentials)
      .filter((e) => !filter?.provider || e.provider === filter.provider)
      .map(redactEntry)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Deletes the entry; its generation stays recorded so a late refresh can't write a reconnect's slot. */
  async delete(id: string): Promise<boolean> {
    return withVaultLock(this.path, () => {
      const shape = this.read();
      const existing = shape.credentials[id];
      if (!existing) return false;
      shape.grant_generations = { ...(shape.grant_generations ?? {}), [id]: Math.max(existing.meta.grant_generation ?? 0, shape.grant_generations?.[id] ?? 0) };
      delete shape.credentials[id];
      this.write(shape);
      return true;
    });
  }

  /** The provider-wide client (the v1 record); per-account records are read by id or account. */
  async getClient(provider: string): Promise<ProviderClientRecord | null> {
    return this.read().clients.find((c) => c.provider === provider && !c.account) ?? null;
  }

  async listClients(provider: string): Promise<ProviderClientRecord[]> {
    return this.read().clients.filter((c) => c.provider === provider);
  }

  async getClientById(provider: string, clientId: string, account?: string): Promise<ProviderClientRecord | null> {
    const matches = this.read().clients.filter((c) => c.provider === provider && c.client_id === clientId);
    const own = account ? matches.find((c) => c.account === account.toLowerCase()) : undefined;
    return own ?? matches.find((c) => !c.account) ?? matches[0] ?? null;
  }

  /** Replaces the record in the same slot (provider-wide, or the same account); other accounts' records stay. */
  async putClient(rec: ProviderClientRecord): Promise<void> {
    withVaultLock(this.path, () => {
      const shape = this.read();
      shape.clients = shape.clients.filter((c) => !sameClientSlot(c, rec));
      shape.clients.push(rec);
      this.write(shape);
    });
  }

  /** Deletes the provider-wide client; per-account records go with their account (deleteAccountClient). */
  async deleteClient(provider: string): Promise<boolean> {
    return withVaultLock(this.path, () => {
      const shape = this.read();
      const before = shape.clients.length;
      shape.clients = shape.clients.filter((c) => !(c.provider === provider && !c.account));
      if (shape.clients.length === before) return false;
      this.write(shape);
      return true;
    });
  }

  async deleteAccountClient(provider: string, account: string): Promise<boolean> {
    const acct = account.trim().toLowerCase();
    return withVaultLock(this.path, () => {
      const shape = this.read();
      const before = shape.clients.length;
      shape.clients = shape.clients.filter((c) => !(c.provider === provider && c.account === acct));
      if (shape.clients.length === before) return false;
      this.write(shape);
      return true;
    });
  }

  async commitGrant(input: { entry: CredentialEntry; client?: ProviderClientRecord; expectedGeneration: number | null }): Promise<CredentialEntry> {
    return withVaultLock(this.path, () => {
      const shape = this.read();
      const current = shape.credentials[input.entry.id] ?? null;
      const currentGen = grantGeneration(current);
      if (currentGen !== input.expectedGeneration) {
        throw new CredentialError('vault_generation_changed', ` for ${input.entry.id} (read ${String(input.expectedGeneration)}, now ${String(currentGen)})`);
      }
      const next = Math.max(currentGen ?? 0, shape.grant_generations?.[input.entry.id] ?? 0) + 1;
      const entry: CredentialEntry = { ...input.entry, meta: { ...input.entry.meta, grant_generation: next } };
      if (input.client) {
        shape.clients = shape.clients.filter((c) => !sameClientSlot(c, input.client!));
        shape.clients.push(input.client);
      }
      shape.credentials[entry.id] = entry;
      shape.grant_generations = { ...(shape.grant_generations ?? {}), [entry.id]: next };
      this.write(shape);
      return entry;
    });
  }

  async casUpdateTokens(id: string, expectedGeneration: number, patch: { secret: Partial<CredentialSecret>; meta: Partial<CredentialMetaFields> }): Promise<CredentialEntry> {
    return withVaultLock(this.path, () => {
      const shape = this.read();
      const current = shape.credentials[id];
      if (!current) throw new CredentialError('not_connected', ` for ${id} (removed mid-refresh)`);
      const gen = grantGeneration(current);
      if (gen !== expectedGeneration) {
        throw new CredentialError('vault_generation_changed', ` for ${id} (read ${expectedGeneration}, now ${String(gen)})`);
      }
      const updated: CredentialEntry = {
        ...current,
        secret: { ...current.secret, ...patch.secret },
        meta: { ...current.meta, ...patch.meta, grant_generation: current.meta.grant_generation ?? 0 },
      };
      if (current.meta.grant_generation === undefined) delete (updated.meta as { grant_generation?: number }).grant_generation;
      shape.credentials[id] = updated;
      this.write(shape);
      return updated;
    });
  }
}

/** The default vault for CLI/self-host callers. */
export function openVault(): CredentialVault {
  return new FileVaultBackend();
}
