/**
 * creds-vault — unit tests for the file-backed credential vault.
 *
 * Covers: put/get/list/delete round-trips, list() redaction (no secret
 * material ever leaves list()), the 0600 file-mode discipline, provider
 * client record CRUD, and the corrupt-file loud-failure contract (a broken
 * credentials.json must never be silently reset — that would orphan refresh
 * tokens the user cannot recover).
 *
 * Every test points GBRAIN_HOME at a fresh mkdtemp dir so the vault path
 * (configDir()/credentials.json) is hermetic; env is restored afterwards.
 * All fixture values are synthetic (a@example.com, GOCSPX-test..., etc.).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileVaultBackend,
  credentialId,
  credentialsPath,
  parseVaultFile,
  redactEntry,
  type CredentialEntry,
  type ProviderClientRecord,
} from '../src/core/creds/vault.ts';

// ── Fixtures (synthetic only) ────────────────────────────────────────────────

function makeEntry(overrides: Partial<CredentialEntry> = {}): CredentialEntry {
  return {
    id: 'google:a@example.com',
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: {
      access_token: 'ya29.test-access-token-value',
      refresh_token: '1//test-refresh-token-value',
      expiry: '2026-08-25T12:00:00.000Z',
    },
    meta: {
      account: 'a@example.com',
      scopes: ['openid', 'email'],
      client_id: '12345-abc.apps.googleusercontent.com',
      connected_at: '2026-08-20T00:00:00.000Z',
      last_refresh_ok_at: '2026-08-24T00:00:00.000Z',
      sendas_aliases: ['a@example.com', 'alias@example.com'],
      consent_publish_state: 'production',
    },
    ...overrides,
  };
}

function makeClient(overrides: Partial<ProviderClientRecord> = {}): ProviderClientRecord {
  return {
    provider: 'google',
    client_id: '12345-abc.apps.googleusercontent.com',
    client_secret: 'GOCSPX-test1234567890',
    created_at: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

// ── Env harness: fresh GBRAIN_HOME per test ─────────────────────────────────

let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-creds-vault-'));
  process.env.GBRAIN_HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('credentialId + redactEntry helpers', () => {
  it('credentialId lowercases and trims the account', () => {
    expect(credentialId('google', '  A@Example.COM ')).toBe('google:a@example.com');
  });

  it('redactEntry keeps metadata, drops every secret field', () => {
    const meta = redactEntry(makeEntry());
    expect(meta.id).toBe('google:a@example.com');
    expect(meta.expiry).toBe('2026-08-25T12:00:00.000Z');
    expect(meta.account).toBe('a@example.com');
    const s = JSON.stringify(meta);
    expect(s).not.toContain('access_token');
    expect(s).not.toContain('refresh_token');
    expect(s).not.toContain('ya29.test-access-token-value');
    expect(s).not.toContain('1//test-refresh-token-value');
  });
});

describe('FileVaultBackend credentials CRUD', () => {
  it('put/get/list/delete round-trip', async () => {
    const vault = new FileVaultBackend();
    const entry = makeEntry();

    expect(await vault.get(entry.id)).toBeNull();
    await vault.put(entry);
    expect(await vault.get(entry.id)).toEqual(entry);

    const listed = await vault.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(entry.id);

    expect(await vault.delete(entry.id)).toBe(true);
    expect(await vault.get(entry.id)).toBeNull();
    // Deleting again reports "nothing deleted".
    expect(await vault.delete(entry.id)).toBe(false);
  });

  it('list() is redacted — no secret values or secret keys anywhere', async () => {
    const vault = new FileVaultBackend();
    await vault.put(makeEntry());
    await vault.put(
      makeEntry({
        id: 'dropbox:b@example.com',
        provider: 'dropbox',
        secret: {
          access_token: 'dbx-access-secret-value',
          refresh_token: 'dbx-refresh-secret-value',
          expiry: '2026-08-25T13:00:00.000Z',
        },
      }),
    );
    // Also stash a client so the vault file holds a client_secret; list()
    // must not surface it either.
    await vault.putClient(makeClient());

    const all = await vault.list();
    expect(all.map((m) => m.id)).toEqual(['dropbox:b@example.com', 'google:a@example.com']);

    const s = JSON.stringify(all);
    expect(s).not.toContain('access_token');
    expect(s).not.toContain('refresh_token');
    expect(s).not.toContain('client_secret');
    expect(s).not.toContain('ya29.test-access-token-value');
    expect(s).not.toContain('1//test-refresh-token-value');
    expect(s).not.toContain('dbx-access-secret-value');
    expect(s).not.toContain('dbx-refresh-secret-value');
    expect(s).not.toContain('GOCSPX-test1234567890');

    // Provider filter works.
    const google = await vault.list({ provider: 'google' });
    expect(google.map((m) => m.id)).toEqual(['google:a@example.com']);
  });

  it('creates the vault file with mode 0600', async () => {
    const vault = new FileVaultBackend();
    await vault.put(makeEntry());
    const path = credentialsPath();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The mode survives subsequent atomic rewrites too.
    await vault.put(makeEntry({ id: 'google:c@example.com' }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('FileVaultBackend provider client records', () => {
  it('putClient/getClient/deleteClient round-trip', async () => {
    const vault = new FileVaultBackend();
    expect(await vault.getClient('google')).toBeNull();

    const rec = makeClient();
    await vault.putClient(rec);
    expect(await vault.getClient('google')).toEqual(rec);

    expect(await vault.deleteClient('google')).toBe(true);
    expect(await vault.getClient('google')).toBeNull();
    expect(await vault.deleteClient('google')).toBe(false);
  });

  it('putClient replaces the existing record for the same provider', async () => {
    const vault = new FileVaultBackend();
    await vault.putClient(makeClient({ client_id: '11111-old.apps.googleusercontent.com' }));
    await vault.putClient(makeClient({ client_id: '22222-new.apps.googleusercontent.com' }));

    const got = await vault.getClient('google');
    expect(got?.client_id).toBe('22222-new.apps.googleusercontent.com');

    // Exactly one google record persists on disk — no accumulation.
    const raw = JSON.parse(readFileSync(credentialsPath(), 'utf-8')) as {
      clients: ProviderClientRecord[];
    };
    expect(raw.clients.filter((c) => c.provider === 'google')).toHaveLength(1);
  });
});

describe('FileVaultBackend corrupt / unknown / missing files', () => {
  function seedRawVaultFile(content: string): string {
    const path = credentialsPath();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  it('invalid JSON: get() throws loudly, naming the path', async () => {
    const path = seedRawVaultFile('{this is not json');
    const vault = new FileVaultBackend();
    await expect(vault.get('google:a@example.com')).rejects.toThrow(path);
    await expect(vault.get('google:a@example.com')).rejects.toThrow('Refusing to overwrite');
  });

  it('invalid JSON: put() throws and never resets the file', async () => {
    const path = seedRawVaultFile('{this is not json');
    const vault = new FileVaultBackend();
    await expect(vault.put(makeEntry())).rejects.toThrow(path);
    // The corrupt content is untouched — no silent reset.
    expect(readFileSync(path, 'utf-8')).toBe('{this is not json');
  });

  it('unknown version throws (parseVaultFile and backend read)', async () => {
    expect(() => parseVaultFile(JSON.stringify({ version: 2, clients: [], credentials: {} }))).toThrow(
      'Unsupported credentials.json version: 2',
    );
    seedRawVaultFile(JSON.stringify({ version: 2, clients: [], credentials: {} }));
    const vault = new FileVaultBackend();
    await expect(vault.get('google:a@example.com')).rejects.toThrow('Unsupported credentials.json version');
  });

  it('missing file → empty vault, no throw', async () => {
    const vault = new FileVaultBackend();
    expect(await vault.get('google:a@example.com')).toBeNull();
    expect(await vault.list()).toEqual([]);
    expect(await vault.getClient('google')).toBeNull();
    expect(await vault.delete('google:a@example.com')).toBe(false);
  });

  it('empty file → empty vault, no throw', async () => {
    seedRawVaultFile('   \n');
    const vault = new FileVaultBackend();
    expect(await vault.get('google:a@example.com')).toBeNull();
    expect(await vault.list()).toEqual([]);
    expect(await vault.getClient('google')).toBeNull();
  });

  it('parseVaultFile tolerates missing clients/credentials sections', () => {
    const shape = parseVaultFile(JSON.stringify({ version: 1 }));
    expect(shape.clients).toEqual([]);
    expect(shape.credentials).toEqual({});
  });
});
