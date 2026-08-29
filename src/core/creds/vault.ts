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

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';

import { atomicWriteFileSync } from '../atomic-write.ts';
import { gbrainPath } from '../config.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type CredentialKind = 'oauth2' | 'bearer' | 'api_key';

/** Which OAuth client minted this credential; routes token refresh. */
export type ClientRef = 'byo' | 'hosted-relay';

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
  /** OAuth client id that minted the tokens (byo entries). */
  client_id?: string;
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
}

/** A provider's OAuth client credentials (byo). One per provider in v1. */
export interface ProviderClientRecord {
  provider: string;
  client_id: string;
  client_secret: string;
  created_at: string;
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
  };
}

// ── File backend ─────────────────────────────────────────────────────────────

export interface VaultFileShape {
  version: 1;
  clients: ProviderClientRecord[];
  credentials: Record<string, CredentialEntry>;
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
  if (parsed.version !== 1) {
    throw new Error(`Unsupported credentials.json version: ${String(parsed.version)}`);
  }
  return {
    version: 1,
    clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    credentials:
      parsed.credentials && typeof parsed.credentials === 'object'
        ? (parsed.credentials as Record<string, CredentialEntry>)
        : {},
  };
}

/**
 * Cross-process mutation lock: the vault is read-modify-write, and a sync's
 * token refresh racing a `connect`/`disconnect` would lose one side's update
 * (worst case resurrecting a deleted credential). O_EXCL lockfile with a
 * stale-takeover after 10s (crashed holders).
 */
function withVaultLock<T>(vaultPath: string, fn: () => T): T {
  const lockPath = `${vaultPath}.lock`;
  const deadline = Date.now() + 5_000;
  // The vault dir may not exist yet (first write on a fresh GBRAIN_HOME) —
  // an ENOENT from openSync must not read as "lock held".
  mkdirSync(gbrainPath(), { recursive: true });
  // Only the process that CREATED the lock may remove it — a fail-open exit
  // (deadline, odd fs error) that deleted a live holder's lock would let a
  // third writer in, recreating the exact lost-update race the lock prevents.
  let acquired = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      // Only EEXIST means contention; any other failure (permissions, odd
      // fs) fails open — the atomic write still guarantees no torn file.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > 10_000) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* lock vanished between attempts */ }
      if (Date.now() > deadline) {
        process.stderr.write(`[creds] vault lock busy >5s (${lockPath}); proceeding without it\n`);
        break;
      }
      const until = Date.now() + 50;
      while (Date.now() < until) { /* brief sync spin — CLI-scale contention */ }
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) rmSync(lockPath, { force: true });
  }
}

export class FileVaultBackend implements CredentialVault {
  constructor(private readonly path: string = credentialsPath()) {}

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
    atomicWriteFileSync(this.path, JSON.stringify(shape, null, 2) + '\n');
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

  async delete(id: string): Promise<boolean> {
    return withVaultLock(this.path, () => {
      const shape = this.read();
      if (!(id in shape.credentials)) return false;
      delete shape.credentials[id];
      this.write(shape);
      return true;
    });
  }

  async getClient(provider: string): Promise<ProviderClientRecord | null> {
    return this.read().clients.find((c) => c.provider === provider) ?? null;
  }

  async putClient(rec: ProviderClientRecord): Promise<void> {
    withVaultLock(this.path, () => {
      const shape = this.read();
      shape.clients = shape.clients.filter((c) => c.provider !== rec.provider);
      shape.clients.push(rec);
      this.write(shape);
    });
  }

  async deleteClient(provider: string): Promise<boolean> {
    return withVaultLock(this.path, () => {
      const shape = this.read();
      const before = shape.clients.length;
      shape.clients = shape.clients.filter((c) => c.provider !== provider);
      if (shape.clients.length === before) return false;
      this.write(shape);
      return true;
    });
  }
}

/** The default vault for CLI/self-host callers. */
export function openVault(): CredentialVault {
  return new FileVaultBackend();
}
