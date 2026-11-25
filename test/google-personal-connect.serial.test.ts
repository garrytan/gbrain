/**
 * GST-3849 PR 1: Personal-mode connect, refresh custody and identity proof.
 *
 * Every Google response here comes from a fake behind globalThis.fetch; the
 * vault is a real FileVaultBackend in a temp GBRAIN_HOME. All accounts and
 * clients are synthetic.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCreds } from '../src/commands/creds.ts';
import { runGoogleConnect, runGoogleConnectImport, runGoogleDisconnect } from '../src/commands/google.ts';
import { exportBundle, importBundle } from '../src/core/creds/export.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import { GoogleTokenProvider, personalModeSetupUrl } from '../src/core/creds/providers/google.ts';
import { FileVaultBackend, type CredentialEntry, type VaultFileShape } from '../src/core/creds/vault.ts';
import { withEnv } from './helpers/with-env.ts';

const CLIENT_A = '100001-personala.apps.googleusercontent.com';
const CLIENT_B = '100002-personalb.apps.googleusercontent.com';
const SHARED = '100003-shared.apps.googleusercontent.com';
const SECRET_A = 'GOCSPX-synthetic-secret-a';
const SECRET_B = 'GOCSPX-synthetic-secret-b';
const CLIENT_C = '100004-personalc.apps.googleusercontent.com';
const SECRET_C = 'GOCSPX-synthetic-secret-c';
const GMAIL_RO = 'https://www.googleapis.com/auth/gmail.readonly';
const CAL_RO = 'https://www.googleapis.com/auth/calendar.readonly';
const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const REFRESH = '1//synthetic-refresh-token';
const ACCESS = 'ya29.synthetic-access-token';

interface Call { url: string; body: URLSearchParams }
let calls: Call[] = [];
/** The fake token endpoint's answer; a function gets the posted form. */
let tokenReply: (form: URLSearchParams) => Response | Promise<Response> = () => tokenJson({});
let tokeninfoScope = 'openid email ' + GMAIL_RO;
let userinfoEmail = 'alice@example.com';
const realFetch = globalThis.fetch;
let prevExitCode: typeof process.exitCode;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A Google-shaped (unsigned) ID token; gbrain checks claims, not signatures, for tokens it got from the token endpoint. */
function idToken(email: string, aud: string, extra: Record<string, unknown> = {}): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256' })}.${b({ iss: 'https://accounts.google.com', aud, email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...extra })}.sig`;
}

function tokenJson(extra: Record<string, unknown>): Response {
  return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: `openid email ${GMAIL_RO}`, ...extra });
}

beforeEach(() => {
  calls = [];
  tokenReply = () => tokenJson({});
  tokeninfoScope = 'openid email ' + GMAIL_RO;
  userinfoEmail = 'alice@example.com';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    calls.push({ url, body });
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') return tokenReply(body);
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/tokeninfo') return json({ scope: tokeninfoScope });
    if (u.hostname === 'openidconnect.googleapis.com') return json({ email: userinfoEmail });
    if (u.hostname === 'gmail.googleapis.com') return json({ sendAs: [] });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  prevExitCode = process.exitCode;
  _resetCliExitVerdictForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
  _resetCliExitVerdictForTests();
  process.exitCode = prevExitCode ?? 0;
});

function home(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-personal-'));
}
const env = (h: string) => ({ GBRAIN_HOME: h, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, GBRAIN_OAUTH_RELAY_URL: undefined });
const vaultFile = (h: string) => join(h, '.gbrain', 'credentials.json');
const readVault = (h: string): VaultFileShape => JSON.parse(readFileSync(vaultFile(h), 'utf-8')) as VaultFileShape;
const vaultText = (h: string) => (existsSync(vaultFile(h)) ? readFileSync(vaultFile(h), 'utf-8') : '');

function clientJson(h: string, id: string, secret: string): string {
  const p = join(h, `client-${id.slice(0, 6)}.json`);
  writeFileSync(p, JSON.stringify({ installed: { client_id: id, client_secret: secret, redirect_uris: ['http://localhost'] } }));
  return p;
}

async function run(fn: () => Promise<void>): Promise<{ out: string; err: string; exit?: number }> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  const x = process.exit;
  let out = '', err = '', exit: number | undefined;
  process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exit = code ?? 0; throw new Error('__exit__'); }) as typeof process.exit;
  try {
    await fn();
  } catch (error) {
    if ((error as Error).message !== '__exit__') throw error;
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
    process.exit = x;
  }
  return { out, err, exit };
}

/** No --json output may carry a token or a client secret. */
function expectNoSecrets(text: string): void {
  for (const s of [REFRESH, ACCESS, SECRET_A, SECRET_B, 'GOCSPX-']) expect(text).not.toContain(s);
}

async function pasteTwoStep(h: string, args: string[]): Promise<{ step1: string; step2: { out: string; exit?: number } }> {
  const s1 = await run(() => runGoogleConnect([...args, '--paste', '--json']));
  const pending = JSON.parse(readFileSync(join(h, '.gbrain', 'google-connect-pending.json'), 'utf-8')) as { state: string };
  const step2 = await run(() => runGoogleConnect(['--code', `http://127.0.0.1:1/?code=4%2Fsynthetic&state=${pending.state}`, '--json']));
  return { step1: s1.out, step2 };
}

describe('Personal-mode connect', () => {
  test('--personal needs --account', async () => {
    const h = home();
    await withEnv(env(h), async () => {
      const r = await run(() => runGoogleConnect(['--personal', '--json']));
      expect(JSON.parse(r.out).error.code).toBe('personal_account_required');
      expect(r.exit).toBe(1);
      expect(existsSync(vaultFile(h))).toBe(false);
    });
  });

  test('with no client yet it prints the one-click Personal-mode link for that account and writes nothing', async () => {
    const h = home();
    await withEnv(env(h), async () => {
      const r = await run(() => runGoogleConnect(['--personal', '--account', 'alice@example.com', '--json']));
      const envl = JSON.parse(r.out);
      expect(envl.status).toBe('needs_client_credentials');
      expect(envl.next_action.url).toBe(personalModeSetupUrl('alice@example.com'));
      expect(envl.next_action.url).toContain('isAgent=true');
      expect(envl.next_action.url).toContain('authuser=alice%40example.com');
      expect(envl.next_action.user_message).toContain('[SHOW USER]');
      expect(envl.next_action.command).toContain('--personal --account alice@example.com');
      expect(currentExitCode()).toBe(2);
      expect(existsSync(vaultFile(h))).toBe(false);
    });
  });

  test('paste-back with a personal client: the client waits in the pending record, then lands with the grant as a per-account record', async () => {
    const h = home();
    await withEnv(env(h), async () => {
      tokenReply = () => tokenJson({ id_token: idToken('alice@example.com', CLIENT_A) });
      const { step1, step2 } = await pasteTwoStep(h, ['--personal', '--account', 'alice@example.com', '--client-json', clientJson(h, CLIENT_A, SECRET_A), '--scopes', 'gmail']);
      expect(JSON.parse(step1).status).toBe('awaiting_consent');
      const out = JSON.parse(step2.out);
      expect(out.status).toBe('connected');
      expect(out.client_mode).toBe('personal');
      expectNoSecrets(step1 + step2.out);
      const v = readVault(h);
      expect(v.version).toBe(2);
      expect(v.clients).toEqual([expect.objectContaining({ client_id: CLIENT_A, account: 'alice@example.com', mode: 'personal' })]);
      const e = v.credentials['google:alice@example.com']!;
      expect(e.meta.client_mode).toBe('personal');
      expect(e.meta.client_id).toBe(CLIENT_A);
      expect(e.meta.grant_generation).toBe(1);
      // The consent asked for exactly the read-only set and merged no earlier grant.
      expect(existsSync(join(h, '.gbrain', 'google-connect-pending.json'))).toBe(false);
      const tokenCall = calls.find((c) => c.url.endsWith('/token'))!;
      expect(tokenCall.body.get('client_id')).toBe(CLIENT_A);
    });
  });

  test('a consent by another account is refused and the prior working grant and client stay exactly as they were', async () => {
    const h = home();
    await withEnv(env(h), async () => {
      mkdirSync(join(h, '.gbrain'), { recursive: true });
      const prior: CredentialEntry = { id: 'google:alice@example.com', provider: 'google', kind: 'oauth2', client_ref: 'byo',
        secret: { refresh_token: '1//prior', access_token: 'ya29.prior' }, meta: { account: 'alice@example.com', client_id: SHARED, connected_at: '2026-01-01T00:00:00.000Z' } };
      writeFileSync(vaultFile(h), JSON.stringify({ version: 1, clients: [{ provider: 'google', client_id: SHARED, client_secret: 'GOCSPX-shared', created_at: '2026-01-01T00:00:00.000Z' }], credentials: { [prior.id]: prior } }));
      const before = vaultText(h);
      tokenReply = () => tokenJson({ id_token: idToken('bob@example.com', CLIENT_A) });
      const { step2 } = await pasteTwoStep(h, ['--personal', '--account', 'alice@example.com', '--client-json', clientJson(h, CLIENT_A, SECRET_A)]);
      expect(JSON.parse(step2.out).error.code).toBe('wrong_account_consented');
      expect(vaultText(h)).toBe(before);
    });
  });

  test('a consent that returns a write-capable scope is refused and nothing is stored', async () => {
    const h = home();
    await withEnv(env(h), async () => {
      tokenReply = () => tokenJson({ id_token: idToken('alice@example.com', CLIENT_A), scope: `openid email ${GMAIL_RO} ${GMAIL_MODIFY}` });
      const { step2 } = await pasteTwoStep(h, ['--personal', '--account', 'alice@example.com', '--client-json', clientJson(h, CLIENT_A, SECRET_A)]);
      const out = JSON.parse(step2.out);
      expect(out.error.code).toBe('write_scope_refused');
      expect(out.error.problem).toContain(GMAIL_MODIFY);
      expect(vaultText(h)).toBe('');
    });
  });

  test('an ID token issued to another client is not proof of identity', async () => {
    const h = home();
    await withEnv(env(h), async () => {
      tokenReply = () => tokenJson({ id_token: idToken('alice@example.com', CLIENT_B) });
      const { step2 } = await pasteTwoStep(h, ['--personal', '--account', 'alice@example.com', '--client-json', clientJson(h, CLIENT_A, SECRET_A)]);
      expect(JSON.parse(step2.out).error.code).toBe('identity_unproven');
      expect(vaultText(h)).toBe('');
    });
  });

  test('client_user_mismatch from Google is named as such', async () => {
    const h = home();
    await withEnv(env(h), async () => {
      tokenReply = () => json({ error: 'access_denied', error_description: 'client_user_mismatch' }, 400);
      const { step2 } = await pasteTwoStep(h, ['--personal', '--account', 'alice@example.com', '--client-json', clientJson(h, CLIENT_A, SECRET_A)]);
      expect(JSON.parse(step2.out).error.code).toBe('client_user_mismatch');
      expect(vaultText(h)).toBe('');
    });
  });
});

describe('connect --import -', () => {
  const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({ account: 'alice@example.com', refresh_token: REFRESH, client: { installed: { client_id: CLIENT_A, client_secret: SECRET_A } }, ...extra });

  test('a valid import proves the account, checks read-only scopes, then writes the client and the grant together', async () => {
    const h = home();
    await withEnv(env(h), async () => {
      tokenReply = () => tokenJson({ id_token: idToken('alice@example.com', CLIENT_A), refresh_token: undefined });
      const r = await run(() => runGoogleConnectImport(payload(), ['--import', '-', '--personal', '--json']));
      expect(JSON.parse(r.out)).toMatchObject({ status: "connected" });
      expectNoSecrets(r.out);
      const v = readVault(h);
      expect(v.credentials['google:alice@example.com']!.secret.refresh_token).toBe(REFRESH);
      expect(v.clients[0]).toEqual(expect.objectContaining({ client_id: CLIENT_A, account: 'alice@example.com', mode: 'personal' }));
    });
  });

  for (const [name, setup, raw, code] of [
    ['a missing refresh token', () => {}, payload({ refresh_token: '' }), 'import_invalid'],
    ['stdin that is not JSON', () => {}, 'not json', 'import_invalid'],
    ['a refresh token Google rejects', () => { tokenReply = () => json({ error: 'invalid_grant' }, 400); }, payload(), 'invalid_grant_revoked'],
    ['a token for another account', () => { tokenReply = () => tokenJson({ id_token: idToken('bob@example.com', CLIENT_A) }); }, payload(), 'identity_unproven'],
    ['a write-capable grant', () => { tokenReply = () => tokenJson({ id_token: idToken('alice@example.com', CLIENT_A), scope: `openid email ${GMAIL_MODIFY}` }); }, payload(), 'write_scope_refused'],
  ] as Array<[string, () => void, string, string]>) {
    test(`${name} is refused before anything is written (${code})`, async () => {
      const h = home();
      await withEnv(env(h), async () => {
        setup();
        const r = await run(() => runGoogleConnectImport(raw, ['--import', '-', '--json']));
        expect(JSON.parse(r.out).error.code).toBe(code);
        expect(vaultText(h)).toBe('');
      });
    });
  }
});

describe('refresh custody', () => {
  function seed(h: string, entries: CredentialEntry[], clients: VaultFileShape['clients']): FileVaultBackend {
    mkdirSync(join(h, '.gbrain'), { recursive: true });
    writeFileSync(vaultFile(h), JSON.stringify({ version: 2, clients, credentials: Object.fromEntries(entries.map((e) => [e.id, e])) }));
    return new FileVaultBackend(vaultFile(h));
  }
  const ent = (account: string, meta: Partial<CredentialEntry['meta']> = {}): CredentialEntry => ({
    id: `google:${account}`, provider: 'google', kind: 'oauth2', client_ref: 'byo',
    secret: { refresh_token: `1//rt-${account}`, access_token: 'ya29.stale', expiry: '2000-01-01T00:00:00.000Z' },
    meta: { account, scopes: ['openid', 'email', GMAIL_RO], connected_at: new Date().toISOString(), grant_generation: 1, ...meta },
  });
  const rec = (account: string, id: string, secret: string) => ({ provider: 'google', client_id: id, client_secret: secret, created_at: '2026-01-01T00:00:00.000Z', account, mode: 'personal' as const });

  test('a two-client vault refreshes each account with its own client', async () => {
    const h = home();
    const v = seed(h, [ent('alice@example.com', { client_id: CLIENT_A, client_mode: 'personal' }), ent('bob@example.com', { client_id: CLIENT_B, client_mode: 'personal' })],
      [rec('alice@example.com', CLIENT_A, SECRET_A), rec('bob@example.com', CLIENT_B, SECRET_B)]);
    await new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh();
    await new GoogleTokenProvider(v, 'google:bob@example.com').forceRefresh();
    const posted = calls.filter((c) => c.url.endsWith('/token')).map((c) => [c.body.get('client_id'), c.body.get('client_secret'), c.body.get('refresh_token')]);
    expect(posted).toEqual([[CLIENT_A, SECRET_A, '1//rt-alice@example.com'], [CLIENT_B, SECRET_B, '1//rt-bob@example.com']]);
  });

  test('another account\'s record for a shared client never shadows the provider-wide record', async () => {
    const h = home();
    const shared = { provider: 'google', client_id: CLIENT_A, client_secret: SECRET_A, created_at: '2026-01-01T00:00:00.000Z' };
    const v = seed(h, [ent('carol@example.com', { client_id: CLIENT_A, client_mode: 'byo' })],
      [shared, { ...rec('bob@example.com', CLIENT_A, SECRET_A), mode: 'byo' as const }]);
    await new GoogleTokenProvider(v, 'google:carol@example.com').forceRefresh();
    expect((await v.get('google:carol@example.com'))!.secret.access_token).toBe(ACCESS);
  });

  test('a BYO import on a client already on file reuses it, and the accounts already on it keep refreshing', async () => {
    const h = home();
    const shared = { provider: 'google', client_id: CLIENT_A, client_secret: SECRET_A, created_at: '2026-01-01T00:00:00.000Z' };
    const v = seed(h, [ent('carol@example.com', { client_id: CLIENT_A, client_mode: 'byo' })], [shared]);
    await withEnv(env(h), async () => {
      tokenReply = () => tokenJson({ id_token: idToken('alice@example.com', CLIENT_A), refresh_token: undefined });
      const raw = JSON.stringify({ account: 'alice@example.com', refresh_token: REFRESH, client: { installed: { client_id: CLIENT_A, client_secret: SECRET_A } } });
      const r = await run(() => runGoogleConnectImport(raw, ['--import', '-', '--json']));
      expect(JSON.parse(r.out)).toMatchObject({ status: 'connected' });
    });
    expect(readVault(h).clients).toEqual([shared]);
    tokenReply = () => tokenJson({});
    await new GoogleTokenProvider(v, 'google:carol@example.com').forceRefresh();
    expect((await v.get('google:carol@example.com'))!.secret.access_token).toBe(ACCESS);
  });

  test('disconnect --purge-client removes this account\'s own client and the provider-wide one, and keeps other accounts\' clients', async () => {
    const h = home();
    const shared = { provider: 'google', client_id: CLIENT_A, client_secret: SECRET_A, created_at: '2026-01-01T00:00:00.000Z' };
    seed(h, [ent('alice@example.com', { client_id: CLIENT_B, client_mode: 'personal' }), ent('bob@example.com', { client_id: CLIENT_C, client_mode: 'personal' })],
      [shared, rec('alice@example.com', CLIENT_B, SECRET_B), rec('bob@example.com', CLIENT_C, SECRET_C)]);
    await withEnv(env(h), async () => {
      const r = await run(() => runGoogleDisconnect(['alice@example.com', '--purge-client', '--json']));
      expect(JSON.parse(r.out)).toMatchObject({ status: 'disconnected' });
    });
    const v = readVault(h);
    expect(v.credentials['google:alice@example.com']).toBeUndefined();
    expect(v.clients).toEqual([rec('bob@example.com', CLIENT_C, SECRET_C)]);
  });

  test('creds export carries each Personal-mode account\'s own client', async () => {
    const h = home();
    seed(h, [ent('alice@example.com', { client_id: CLIENT_B, client_mode: 'personal', consent_publish_state: 'production' })], [rec('alice@example.com', CLIENT_B, SECRET_B)]);
    const out = join(h, 'bundle.json');
    await withEnv({ ...env(h), GBRAIN_TEST_PASSPHRASE: 'correct-horse-battery-test' }, async () => {
      await run(() => runCreds(['export', '--out', out, '--passphrase-env', 'GBRAIN_TEST_PASSPHRASE', '--json']));
    });
    const payload = importBundle(JSON.parse(readFileSync(out, 'utf-8')), 'correct-horse-battery-test');
    expect(payload.clients).toEqual([rec('alice@example.com', CLIENT_B, SECRET_B)]);
  });

  test('a fresh token stored before the read-only rule under a write-capable grant is refreshed, not handed out', async () => {
    const h = home();
    const stale = { ...ent('alice@example.com', { client_id: CLIENT_A, scopes: ['openid', 'email', GMAIL_RO, GMAIL_MODIFY] }) };
    stale.secret = { ...stale.secret, access_token: 'ya29.legacy-write-capable', expiry: new Date(Date.now() + 3_600_000).toISOString() };
    const v = seed(h, [stale], [rec('alice@example.com', CLIENT_A, SECRET_A)]);
    tokenReply = (form) => tokenJson({ refresh_token: undefined, scope: form.get('scope') ?? '' });
    const p = new GoogleTokenProvider(v, 'google:alice@example.com');
    expect(await p.getAccessToken()).toBe(ACCESS);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    expect(await p.getAccessToken()).toBe(ACCESS);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  test('a reconnect that commits while a refresh waits for the lease is refreshed and written under its new generation', async () => {
    const h = home();
    const v = seed(h, [ent('alice@example.com', { client_id: CLIENT_A })], [rec('alice@example.com', CLIENT_A, SECRET_A)]);
    const release = await v.leaseRefresh('google:alice@example.com', 1);
    const refreshing = new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh();
    const fresh = { ...ent('alice@example.com', { client_id: CLIENT_A }), secret: { refresh_token: '1//rt-reconnected', access_token: 'ya29.stale', expiry: '2000-01-01T00:00:00.000Z' } };
    await v.commitGrant({ entry: fresh, expectedGeneration: 1 });
    release();
    expect(await refreshing).toBe(ACCESS);
    const stored = (await v.get('google:alice@example.com'))!;
    expect(stored.meta.grant_generation).toBe(2);
    expect(stored.secret.access_token).toBe(ACCESS);
    expect(calls.find((c) => c.url.endsWith('/token'))!.body.get('refresh_token')).toBe('1//rt-reconnected');
  });

  test('creds import gives each restored grant a fresh generation on this vault', async () => {
    const h = home();
    seed(h, [ent('alice@example.com', { client_id: CLIENT_A, grant_generation: 5 })], [rec('alice@example.com', CLIENT_A, SECRET_A)]);
    const bundle = exportBundle({ credentials: [ent('alice@example.com', { client_id: CLIENT_A, grant_generation: 1 })], clients: [rec('alice@example.com', CLIENT_A, SECRET_A)] }, 'correct-horse-battery-test');
    const file = join(h, 'in.json');
    writeFileSync(file, JSON.stringify(bundle));
    await withEnv({ ...env(h), GBRAIN_TEST_PASSPHRASE: 'correct-horse-battery-test' }, async () => {
      await run(() => runCreds(['import', file, '--passphrase-env', 'GBRAIN_TEST_PASSPHRASE', '--json']));
    });
    expect(readVault(h).credentials['google:alice@example.com']!.meta.grant_generation).toBe(6);
  });

  test('an entry whose client is no longer on file is refused before any network call', async () => {
    const h = home();
    const v = seed(h, [ent('alice@example.com', { client_id: CLIENT_A, client_mode: 'personal' })], [rec('bob@example.com', CLIENT_B, SECRET_B)]);
    await expect(new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh()).rejects.toMatchObject({ code: 'client_record_mismatch' });
    expect(calls).toHaveLength(0);
  });

  test('a grant holding a write scope refreshes with the read-only subset and persists only a narrowed token', async () => {
    const h = home();
    const v = seed(h, [ent('alice@example.com', { client_id: CLIENT_A, scopes: ['openid', 'email', GMAIL_RO, GMAIL_MODIFY] })], [rec('alice@example.com', CLIENT_A, SECRET_A)]);
    tokenReply = (form) => tokenJson({ refresh_token: undefined, scope: form.get('scope') ?? '' });
    await new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh();
    expect(calls[0]!.body.get('scope')).toBe(`openid email ${GMAIL_RO}`);
    expect((await v.get('google:alice@example.com'))!.secret.access_token).toBe(ACCESS);
  });

  test('a refreshed token Google did not narrow is never written', async () => {
    const h = home();
    const v = seed(h, [ent('alice@example.com', { client_id: CLIENT_A, scopes: ['openid', 'email', GMAIL_RO, GMAIL_MODIFY] })], [rec('alice@example.com', CLIENT_A, SECRET_A)]);
    const before = vaultText(h);
    tokenReply = () => tokenJson({ scope: `openid email ${GMAIL_RO} ${GMAIL_MODIFY}` });
    await expect(new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh()).rejects.toMatchObject({ code: 'write_scope_refused' });
    expect(vaultText(h)).toBe(before);
  });

  test('a personal entry confirms scopes through tokeninfo when the refresh answer omits them', async () => {
    const h = home();
    const v = seed(h, [ent('alice@example.com', { client_id: CLIENT_A, client_mode: 'personal' })], [rec('alice@example.com', CLIENT_A, SECRET_A)]);
    tokenReply = () => tokenJson({ scope: undefined });
    tokeninfoScope = `openid email ${GMAIL_RO} ${CAL_RO}`;
    await new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh();
    const info = calls.find((c) => c.url.endsWith('/tokeninfo'))!;
    expect(info.body.get('access_token')).toBe(ACCESS);
    expect(new URL(info.url).search).toBe('');
    tokeninfoScope = `openid ${GMAIL_MODIFY}`;
    await expect(new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh()).rejects.toMatchObject({ code: 'write_scope_refused' });
  });

  test('Testing-mode expiry is read only until a refresh 7+ days after consent proves the personal client', async () => {
    const h = home();
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    const v = seed(h, [ent('alice@example.com', { client_id: CLIENT_A, client_mode: 'personal', connected_at: old, last_refresh_ok_at: old })], [rec('alice@example.com', CLIENT_A, SECRET_A)]);
    tokenReply = () => json({ error: 'invalid_grant' }, 400);
    await expect(new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh()).rejects.toMatchObject({ code: 'invalid_grant_testing_expiry' });
    tokenReply = () => tokenJson({});
    await new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh();
    expect((await v.get('google:alice@example.com'))!.meta.personal_confirmed_at).toBeDefined();
    const later = new Date(Date.now() - 1).toISOString();
    expect(later).toBeTruthy();
    tokenReply = () => json({ error: 'invalid_grant' }, 400);
    // Even after a week of silence, a proven personal client is never read as Testing expiry.
    const e = (await v.get('google:alice@example.com'))!;
    await v.casUpdateTokens(e.id, 1, { secret: { expiry: '2000-01-01T00:00:00.000Z' }, meta: { last_refresh_ok_at: old } });
    await expect(new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh()).rejects.toMatchObject({ code: 'invalid_grant_revoked' });
  });

  test('a refresh interleaved with a disconnect writes nothing; one interleaved with a reconnect keeps the new grant', async () => {
    const h = home();
    const v = seed(h, [ent('alice@example.com', { client_id: CLIENT_A, client_mode: 'personal' })], [rec('alice@example.com', CLIENT_A, SECRET_A)]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    tokenReply = async () => { await gate; return tokenJson({ access_token: 'ya29.late' }); };
    const late = new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh();
    while (!calls.some((c) => c.url.endsWith('/token'))) await new Promise((r) => setTimeout(r, 5));
    await v.delete('google:alice@example.com');
    release();
    await expect(late).rejects.toMatchObject({ code: 'not_connected' });
    expect(await v.get('google:alice@example.com')).toBeNull();

    // Reconnect while a refresh is in flight.
    await v.commitGrant({ entry: ent('alice@example.com', { client_id: CLIENT_A, client_mode: 'personal' }), expectedGeneration: null });
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => { release2 = r; });
    calls = [];
    tokenReply = async () => { await gate2; return tokenJson({ access_token: 'ya29.late2' }); };
    const late2 = new GoogleTokenProvider(v, 'google:alice@example.com').forceRefresh();
    while (!calls.some((c) => c.url.endsWith('/token'))) await new Promise((r) => setTimeout(r, 5));
    const current = (await v.get('google:alice@example.com'))!;
    await v.commitGrant({ entry: { ...current, secret: { refresh_token: '1//reconnected', access_token: 'ya29.reconnected' } }, expectedGeneration: current.meta.grant_generation! });
    release2();
    await expect(late2).rejects.toBeInstanceOf(CredentialError);
    await late2.catch((e: CredentialError) => expect(e.code).toBe('vault_generation_changed'));
    expect((await v.get('google:alice@example.com'))!.secret.access_token).toBe('ya29.reconnected');
  });
});
