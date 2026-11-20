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
import { GoogleTokenProvider, type FetchImpl } from '../src/core/creds/providers/google.ts';

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
  it('refreshes both accounts through their issuing clients after a second client is stored', async () => {
    const vault = new FileVaultBackend();
    const first = makeClient();
    const second = makeClient({ client_id: '22222-second.apps.googleusercontent.com', client_secret: 'synthetic-second-secret' });
    const a = makeEntry();
    const b = makeEntry({ id: 'google:b@example.com', meta: { ...a.meta, account: 'b@example.com', client_id: second.client_id } });
    await vault.putClient(first);
    await vault.put(a);
    // Starting another consent flow alone must not break a's refresh.
    await vault.putClient(second);
    await vault.put(b);
    const calls: URLSearchParams[] = [];
    const fetchImpl: FetchImpl = async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      calls.push(body);
      return Response.json({ access_token: `synthetic-access-${calls.length}`, refresh_token: `synthetic-rotation-${calls.length}`, expires_in: 3600 });
    };
    const reopened = new FileVaultBackend();
    await new GoogleTokenProvider(reopened, a.id, fetchImpl).forceRefresh();
    await new GoogleTokenProvider(reopened, b.id, fetchImpl).forceRefresh();
    expect(calls.map(c => c.get('client_id'))).toEqual([first.client_id, second.client_id]);
    expect(calls.map(c => c.get('client_secret'))).toEqual([first.client_secret, second.client_secret]);
    expect((await reopened.get(a.id))?.secret.refresh_token).toBe('synthetic-rotation-1');
    expect((await reopened.get(b.id))?.secret.refresh_token).toBe('synthetic-rotation-2');
    expect((await reopened.get(a.id))?.meta.client_id).toBe(first.client_id);
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('pins legacy unbound BYO entries before another client is added, but not relay entries', async () => {
    const vault = new FileVaultBackend();
    const first = makeClient();
    await vault.putClient(first);
    const legacy = makeEntry();
    delete legacy.meta.client_id;
    await vault.put(legacy);
    const relay = makeEntry({ id: 'google:relay@example.com', client_ref: 'hosted-relay', meta: { ...legacy.meta } });
    await vault.put(relay);
    await vault.putClient(makeClient({ client_id: '22222-second.apps.googleusercontent.com' }));
    expect((await vault.get(legacy.id))?.meta.client_id).toBe(first.client_id);
    expect((await vault.get(relay.id))?.meta.client_id).toBeUndefined();
  });

  it('refuses a missing issuing client before any token request', async () => {
    const vault = new FileVaultBackend();
    await vault.putClient(makeClient({ client_id: '22222-other.apps.googleusercontent.com' }));
    const entry = makeEntry();
    await vault.put(entry);
    let calls = 0;
    const fetchImpl: FetchImpl = async () => { calls++; return Response.json({ access_token: 'synthetic-wrong', expires_in: 3600 }); };
    await expect(new GoogleTokenProvider(vault, entry.id, fetchImpl).forceRefresh()).rejects.toMatchObject({ code: 'not_connected' });
    expect(calls).toBe(0);
    expect(await vault.get(entry.id)).toEqual(entry);
  });

  it('isolates client keys by provider, rotates one secret, and purges the whole provider only on explicit deleteClient', async () => {
    const vault = new FileVaultBackend();
    const first = makeClient();
    const second = makeClient({ client_id: '22222-second.apps.googleusercontent.com' });
    const other = makeClient({ provider: 'other' });
    await vault.putClient(first);
    await vault.putClient(second);
    await vault.putClient(other);
    const rotated = { ...first, client_secret: 'synthetic-rotated-secret' };
    await vault.putClient(rotated);
    expect(await vault.getClient('google', first.client_id)).toEqual(rotated);
    expect(await vault.getClient('google', second.client_id)).toEqual(second);
    expect(await vault.getClient('other', first.client_id)).toEqual(other);
    expect(await vault.getClient('google')).toEqual(rotated);
    expect(await vault.getClient('google', 'missing-client')).toBeNull();
    expect(await vault.deleteClient('google')).toBe(true);
    expect(await vault.getClient('google', first.client_id)).toBeNull();
    expect(await vault.getClient('google', second.client_id)).toBeNull();
    expect(await vault.getClient('other', first.client_id)).toEqual(other);
  });

  it('does not attach an old refresh response to an account reconnected with another client', async () => {
    const vault = new FileVaultBackend();
    await vault.putClient(makeClient());
    const entry = makeEntry();
    await vault.put(entry);
    const reconnected = makeEntry({ secret: { access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh' },
      meta: { ...entry.meta, client_id: '22222-second.apps.googleusercontent.com' } });
    const fetchImpl: FetchImpl = async () => {
      await vault.putClient(makeClient({ client_id: reconnected.meta.client_id! }));
      await vault.put(reconnected);
      return Response.json({ access_token: 'synthetic-obsolete-access', refresh_token: 'synthetic-obsolete-refresh', expires_in: 3600 });
    };
    await expect(new GoogleTokenProvider(vault, entry.id, fetchImpl).forceRefresh()).rejects.toMatchObject({ code: 'not_connected' });
    expect(await vault.get(entry.id)).toEqual(reconnected);
  });

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
    await vault.putClient(makeClient({ client_secret: 'synthetic-old-secret' }));
    await vault.putClient(makeClient({ client_secret: 'synthetic-new-secret' }));

    const got = await vault.getClient('google');
    expect(got?.client_id).toBe(makeClient().client_id);
    expect(got?.client_secret).toBe('synthetic-new-secret');

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
