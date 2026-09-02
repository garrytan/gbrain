/**
 * gbrain google connect (src/commands/google.ts:runGoogleConnect) —
 * command-layer orchestration of the BYO two-step paste flow, the relay
 * gates, and the connect funnel heartbeats — plus gbrain google calendars
 * (runGoogleCalendars): account resolution, the --json envelope, and the
 * human listing.
 *
 * Serial file: swaps globalThis.fetch in beforeEach/afterEach (both commands
 * capture the global at call time), pins process.stdin.isTTY to non-TTY so
 * the paste flow deterministically takes the two-invocation agent path, and
 * stubs process.exit (handleCredError hard-exits on credential errors; the
 * calendars account-resolution branches exit 2).
 *
 * Every test runs under a fresh GBRAIN_HOME (via withEnv), so the vault,
 * the pending-connect file, and heartbeat.jsonl are all fixture-local and the
 * developer's real ~/.gbrain is never touched. Synthetic data only.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGoogleCalendars, runGoogleConnect } from '../src/commands/google.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import type { CredentialEntry, ProviderClientRecord, VaultFileShape } from '../src/core/creds/vault.ts';
import {
  currentExitCode,
  _resetCliExitVerdictForTests,
} from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const CLIENT_ID = '123456-abcdef.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret-0000';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// ── Mock global fetch (token + userinfo + sendAs + calendarList endpoints) ───

interface FetchCall {
  url: string;
  body: string;
}

let fetchCalls: FetchCall[] = [];
let userinfoEmail = 'a@example.com';
/** When set, the fake token endpoint reports this space-delimited GRANTED scope set. */
let tokenScope: string | undefined;
/** Rows the fake Calendar API's calendarList returns (runGoogleCalendars). */
let calendarListItems: Array<Record<string, unknown>> = [];

const realFetch = globalThis.fetch;
const stdinTtyDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const mockFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  fetchCalls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
  const u = new URL(url);
  if (u.hostname === 'oauth2.googleapis.com') {
    return json({
      access_token: 'ya29.fresh-access',
      refresh_token: '1//fresh-refresh',
      expires_in: 3600,
      ...(tokenScope ? { scope: tokenScope } : {}),
    });
  }
  if (u.hostname === 'openidconnect.googleapis.com') {
    return json({ email: userinfoEmail });
  }
  if (u.hostname === 'gmail.googleapis.com' && u.pathname.includes('/settings/sendAs')) {
    return json({ sendAs: [{ sendAsEmail: 'a@example.com' }, { sendAsEmail: 'alias@example.com' }] });
  }
  if (u.hostname === 'www.googleapis.com' && u.pathname === '/calendar/v3/users/me/calendarList') {
    return json({ items: calendarListItems });
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}) as typeof fetch;

beforeEach(() => {
  fetchCalls = [];
  userinfoEmail = 'a@example.com';
  tokenScope = undefined;
  calendarListItems = [];
  globalThis.fetch = mockFetch;
  // Deterministic non-TTY: the paste flow must take the two-invocation agent
  // path even when a developer runs bun test from a live terminal.
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  _resetCliExitVerdictForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (stdinTtyDesc) Object.defineProperty(process.stdin, 'isTTY', stdinTtyDesc);
  _resetCliExitVerdictForTests();
});

// ── Fixture helpers ──────────────────────────────────────────────────────────

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-connect-'));
}

function gdir(home: string): string {
  return join(home, '.gbrain');
}

function vaultPath(home: string): string {
  return join(gdir(home), 'credentials.json');
}

function pendingPath(home: string): string {
  return join(gdir(home), 'google-connect-pending.json');
}

function heartbeatPath(home: string): string {
  return join(gdir(home), 'integrations', 'google', 'heartbeat.jsonl');
}

function readVault(home: string): VaultFileShape {
  return JSON.parse(readFileSync(vaultPath(home), 'utf-8')) as VaultFileShape;
}

function writeVault(home: string, clients: ProviderClientRecord[], credentials: Record<string, CredentialEntry> = {}): void {
  mkdirSync(gdir(home), { recursive: true });
  writeFileSync(vaultPath(home), JSON.stringify({ version: 1, clients, credentials }, null, 2) + '\n', 'utf-8');
}

function googleClient(): ProviderClientRecord {
  return { provider: 'google', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, created_at: new Date().toISOString() };
}

interface PendingShape {
  state: string;
  verifier: string;
  redirect_uri: string;
  scopes: string[];
  client_id: string;
  account_hint?: string;
  created_at: string;
}

function writePendingFile(home: string, over: Partial<PendingShape> = {}): PendingShape {
  const p: PendingShape = {
    state: 'a1b2c3d4e5f60718a1b2c3d4e5f60718',
    verifier: 'test-code-verifier-0000000000000000000000000000',
    redirect_uri: 'http://127.0.0.1:41999/',
    scopes: ['openid', 'email', GMAIL_SCOPE],
    client_id: CLIENT_ID,
    created_at: new Date().toISOString(),
    ...over,
  };
  mkdirSync(gdir(home), { recursive: true });
  writeFileSync(pendingPath(home), JSON.stringify(p, null, 2), { mode: 0o600 });
  return p;
}

function readHeartbeats(home: string): Array<{ event: string; status: string; details?: Record<string, unknown> }> {
  if (!existsSync(heartbeatPath(home))) return [];
  return readFileSync(heartbeatPath(home), 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { event: string; status: string; details?: Record<string, unknown> });
}

function writeClientJsonFile(home: string): string {
  const p = join(home, 'client_secret_test.json');
  writeFileSync(
    p,
    JSON.stringify({
      installed: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uris: ['http://localhost'],
      },
    }),
    'utf-8',
  );
  return p;
}

interface Captured {
  out: string;
  err: string;
  verdict: number;
  exitCalled: number | undefined;
}

async function captured(fn: () => Promise<void>): Promise<Captured> {
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const exitOrig = process.exit;
  const prevExitCode = process.exitCode;
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  let exitCalled: number | undefined;
  _resetCliExitVerdictForTests();
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCalled = code ?? 0;
    throw new Error('__exit__');
  }) as typeof process.exit;
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = exitOrig;
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
  }
  const verdict = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = prevExitCode ?? 0;
  return { out: outChunks.join(''), err: errChunks.join(''), verdict, exitCalled };
}

/** Env base for every connect run: fixture home, no ambient client creds. */
function connectEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GBRAIN_HOME: home,
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    GBRAIN_OAUTH_RELAY_URL: undefined,
    ...extra,
  };
}

function parseErrorEnvelope(out: string): { ok: boolean; status: string; error: { code: string } } {
  return JSON.parse(out) as { ok: boolean; status: string; error: { code: string } };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runGoogleConnect — needs_client_credentials (non-TTY, no creds anywhere)', () => {
  test('--json envelope: status, [SHOW USER] checklist in next_action, verdict 2', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      const r = await captured(() => runGoogleConnect(['--json']));
      const env = JSON.parse(r.out) as {
        ok: boolean;
        status: string;
        next_action: { command: string; user_message: string };
      };
      expect(env.ok).toBe(false);
      expect(env.status).toBe('needs_client_credentials');
      expect(env.next_action.command).toContain('--client-json');
      expect(env.next_action.user_message).toContain('[SHOW USER]');
      expect(env.next_action.user_message).toContain('[/SHOW USER]');
      expect(env.next_action.user_message).toContain('console.cloud.google.com');
      expect(r.verdict).toBe(2);
      expect(r.exitCalled).toBeUndefined(); // soft verdict, not a hard exit
      // Funnel: the attempt was recorded.
      expect(readHeartbeats(home).map((h) => h.event)).toContain('connect_started');
    });
  });

  test('human output prints the GCP checklist block verbatim', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      const r = await captured(() => runGoogleConnect([]));
      expect(r.out).toContain('[SHOW USER]');
      expect(r.out).toContain('Desktop app');
      expect(r.out).toContain('gbrain google connect --client-json');
      expect(r.verdict).toBe(2);
    });
  });
});

describe('runGoogleConnect — two-step paste flow', () => {
  test('step 1: --client-json + --paste (non-TTY) → awaiting_consent, 0600 pending file, client in the vault', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      const clientJson = writeClientJsonFile(home);
      const r = await captured(() =>
        runGoogleConnect(['--client-json', clientJson, '--paste', '--scopes', 'gmail', '--json']),
      );
      const env = JSON.parse(r.out) as {
        ok: boolean;
        status: string;
        next_action: { command: string; user_message: string };
      };
      expect(env.ok).toBe(false);
      expect(env.status).toBe('awaiting_consent');
      expect(env.next_action.command).toContain('--code');
      expect(env.next_action.user_message).toContain('[SHOW USER]');
      expect(env.next_action.user_message).toContain('accounts.google.com');
      expect(r.verdict).toBe(2);

      // Pending file: exists, secret-tight permissions, narrowed scope grant.
      expect(existsSync(pendingPath(home))).toBe(true);
      expect(statSync(pendingPath(home)).mode & 0o777).toBe(0o600);
      const pending = JSON.parse(readFileSync(pendingPath(home), 'utf-8')) as PendingShape;
      expect(pending.state).toMatch(/^[0-9a-f]{32}$/);
      expect(pending.scopes).toEqual(['openid', 'email', GMAIL_SCOPE]); // gmail-only + base
      expect(pending.client_id).toBe(CLIENT_ID);

      // The OAuth client landed in the vault.
      const vault = readVault(home);
      expect(vault.clients).toHaveLength(1);
      expect(vault.clients[0].client_id).toBe(CLIENT_ID);
      expect(Object.keys(vault.credentials)).toHaveLength(0); // no tokens yet

      // Funnel heartbeats so far.
      const events = readHeartbeats(home).map((h) => h.event);
      expect(events).toContain('connect_started');
      expect(events).toContain('client_creds_ok');
      expect(events).not.toContain('consent_ok');
    });
  });

  test('step 2: --code with the matching state → vault entry with the PENDING scopes, consent_ok heartbeat', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      // Step 1 narrows to gmail; step 2 passes NO --scopes, so a naive
      // implementation would stamp the default all-services scopes.
      const clientJson = writeClientJsonFile(home);
      await captured(() =>
        runGoogleConnect(['--client-json', clientJson, '--paste', '--scopes', 'gmail', '--json']),
      );
      const pending = JSON.parse(readFileSync(pendingPath(home), 'utf-8')) as PendingShape;

      const redirect = `http://127.0.0.1:41999/?code=4%2Fauthcode-test&state=${pending.state}`;
      const r = await captured(() => runGoogleConnect(['--code', redirect, '--json']));
      const env = JSON.parse(r.out) as {
        ok: boolean;
        status: string;
        account: string;
        scopes: string[];
        client_ref: string;
        next_action: { command: string };
      };
      expect(env.ok).toBe(true);
      expect(env.status).toBe('connected');
      expect(env.account).toBe('a@example.com');
      // The step-1 grant is the truth: gmail-only + base, never the defaults.
      expect(env.scopes).toEqual(['openid', 'email', GMAIL_SCOPE]);
      expect(env.client_ref).toBe('byo');
      expect(env.next_action.command).toContain('gbrain sources add');
      expect(env.next_action.command).toContain('--kind google --account a@example.com');
      expect(r.verdict).toBe(0);

      // Vault entry written with the tokens + sendAs identity set.
      const vault = readVault(home);
      const entry = vault.credentials['google:a@example.com'];
      expect(entry).toBeDefined();
      expect(entry.secret.access_token).toBe('ya29.fresh-access');
      expect(entry.secret.refresh_token).toBe('1//fresh-refresh');
      expect(entry.meta.scopes).toEqual(['openid', 'email', GMAIL_SCOPE]);
      expect(entry.meta.sendas_aliases).toEqual(['a@example.com', 'alias@example.com']);

      // The exchange bound the PKCE verifier + code from the pending flow.
      const tokenCall = fetchCalls.find((c) => c.url.includes('oauth2.googleapis.com'));
      expect(tokenCall).toBeDefined();
      const params = new URLSearchParams(tokenCall!.body);
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(params.get('code')).toBe('4/authcode-test');
      expect(params.get('code_verifier')).toBe(pending.verifier);
      expect(params.get('redirect_uri')).toBe(pending.redirect_uri);

      // Pending state consumed; funnel complete.
      expect(existsSync(pendingPath(home))).toBe(false);
      const events = readHeartbeats(home).map((h) => h.event);
      expect(events).toContain('connect_started');
      expect(events).toContain('client_creds_ok');
      expect(events).toContain('consent_ok');
      expect(events).not.toContain('connect_error');
    });
  });

  test('narrowed grant: the token response `scope` field wins over the requested set in meta.scopes', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      // Step 1 requests the full default set (no --scopes → all 3 services)...
      const clientJson = writeClientJsonFile(home);
      await captured(() => runGoogleConnect(['--client-json', clientJson, '--paste', '--json']));
      const pending = JSON.parse(readFileSync(pendingPath(home), 'utf-8')) as PendingShape;
      expect(pending.scopes).toHaveLength(5); // openid + email + gmail/calendar/contacts

      // ...but the user unchecked calendar + contacts on the consent screen.
      // Google reports the NARROWED grant in the token response's `scope` —
      // and THAT is what the vault must persist, not the requested set.
      tokenScope = `openid email ${GMAIL_SCOPE}`;
      const redirect = `http://127.0.0.1:41999/?code=4%2Fauthcode-test&state=${pending.state}`;
      const r = await captured(() => runGoogleConnect(['--code', redirect, '--json']));
      const env = JSON.parse(r.out) as { ok: boolean; status: string; scopes: string[] };
      expect(env.ok).toBe(true);
      expect(env.status).toBe('connected');
      expect(env.scopes).toEqual(['openid', 'email', GMAIL_SCOPE]);
      expect(r.verdict).toBe(0);

      const entry = readVault(home).credentials['google:a@example.com'];
      expect(entry).toBeDefined();
      expect(entry.meta.scopes).toEqual(['openid', 'email', GMAIL_SCOPE]); // exactly the grant
    });
  });

  test('--code with a WRONG state → state_mismatch error envelope, hard exit 1', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      writeVault(home, [googleClient()]);
      const pending = writePendingFile(home);
      const redirect = `http://127.0.0.1:41999/?code=4%2Fabc&state=not-${pending.state}`;
      const r = await captured(() => runGoogleConnect(['--code', redirect, '--json']));
      const env = parseErrorEnvelope(r.out);
      expect(env.ok).toBe(false);
      expect(env.status).toBe('error');
      expect(env.error.code).toBe('state_mismatch');
      expect(r.exitCalled).toBe(1);
      // No token exchange ever fired.
      expect(fetchCalls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(0);
      // The failure funnel recorded exactly one connect_error.
      const errors = readHeartbeats(home).filter((h) => h.event === 'connect_error');
      expect(errors).toHaveLength(1);
      expect(errors[0].details?.code).toBe('state_mismatch');
    });
  });

  test('--code against an EXPIRED pending (backdated created_at) → consent_timeout', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      writeVault(home, [googleClient()]);
      const pending = writePendingFile(home, {
        created_at: new Date(Date.now() - 11 * 60_000).toISOString(), // TTL is 10min
      });
      const redirect = `http://127.0.0.1:41999/?code=4%2Fabc&state=${pending.state}`;
      const r = await captured(() => runGoogleConnect(['--code', redirect, '--json']));
      const env = parseErrorEnvelope(r.out);
      expect(env.error.code).toBe('consent_timeout');
      expect(r.exitCalled).toBe(1);
      // The stale pending file was purged on read.
      expect(existsSync(pendingPath(home))).toBe(false);
    });
  });

  test('wrong_account_consented: --account a@ but userinfo says b@ → error, NO vault entry, ONE connect_error', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      writeVault(home, [googleClient()]);
      const pending = writePendingFile(home, { account_hint: 'a@example.com' });
      userinfoEmail = 'b@example.com'; // the user picked the wrong account in the browser
      const redirect = `http://127.0.0.1:41999/?code=4%2Fabc&state=${pending.state}`;
      const r = await captured(() =>
        runGoogleConnect(['--code', redirect, '--account', 'a@example.com', '--json']),
      );
      const env = parseErrorEnvelope(r.out);
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe('wrong_account_consented');
      expect(r.exitCalled).toBe(1);
      // The tokens were never stored — for either account.
      expect(Object.keys(readVault(home).credentials)).toHaveLength(0);
      // Exactly ONE connect_error heartbeat (handleCredError is the single
      // funnel emission point), and no consent_ok.
      const beats = readHeartbeats(home);
      expect(beats.filter((h) => h.event === 'connect_error')).toHaveLength(1);
      expect(beats.map((h) => h.event)).not.toContain('consent_ok');
    });
  });
});

describe('runGoogleConnect — relay gates', () => {
  test('--via http://evil.example → relay_unreachable (refuses non-https custody)', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      const r = await captured(() => runGoogleConnect(['--via', 'http://evil.example', '--json']));
      const env = parseErrorEnvelope(r.out);
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe('relay_unreachable');
      expect(r.exitCalled).toBe(1);
      expect(fetchCalls).toHaveLength(0); // never talked to the evil host
    });
  });

  test('--via gbrain.io without GBRAIN_OAUTH_RELAY_URL → relay_disabled (feature gate off)', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      const r = await captured(() => runGoogleConnect(['--via', 'gbrain.io', '--json']));
      const env = parseErrorEnvelope(r.out);
      expect(env.error.code).toBe('relay_disabled');
      expect(r.exitCalled).toBe(1);
      expect(fetchCalls).toHaveLength(0);
    });
  });
});

// ── runGoogleCalendars ───────────────────────────────────────────────────────

const FAMILY_CAL_ID = 'family0123456789@group.calendar.google.com';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/**
 * A connected account whose cached access token is still fresh (well past the
 * provider's 5-minute refresh margin), so the Calendar client never touches
 * the token endpoint: fetchCalls holds exactly the calendarList request.
 */
function googleEntry(email: string): CredentialEntry {
  return {
    id: `google:${email}`,
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: {
      access_token: 'ya29.cached-access',
      refresh_token: '1//cached-refresh',
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    },
    meta: {
      account: email,
      scopes: ['openid', 'email', CALENDAR_SCOPE],
      client_id: CLIENT_ID,
      connected_at: new Date().toISOString(),
    },
  };
}

function connectedVault(home: string, ...emails: string[]): void {
  const credentials: Record<string, CredentialEntry> = {};
  for (const email of emails) credentials[`google:${email}`] = googleEntry(email);
  writeVault(home, [googleClient()], credentials);
}

interface CalendarsEnvelope {
  ok: boolean;
  status: string;
  account: string;
  calendars: Array<{ id: string; summary: string; primary: boolean; accessRole: string }>;
  next_action?: { command?: string; user_message?: string };
}

/**
 * Bun's console.error does NOT route through the process.stderr.write stub
 * that `captured` installs, so the account-resolution branches (which report
 * via console.error before exit 2) are observed through a spy instead.
 */
async function withConsoleErrorSpy(fn: () => Promise<void>): Promise<string> {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  let lines: string[] = [];
  try {
    await fn();
  } finally {
    lines = spy.mock.calls.map((call) => call.map(String).join(' '));
    spy.mockRestore();
  }
  return lines.join('\n');
}

describe('runGoogleCalendars', () => {
  beforeEach(() => {
    calendarListItems = [
      { id: 'a@example.com', summary: 'A Example', primary: true, accessRole: 'owner' },
      { id: FAMILY_CAL_ID, summary: 'Family', accessRole: 'reader' },
    ];
  });

  test('no connected Google account → exit 2 pointing at `gbrain google connect`, no API call', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      writeVault(home, [googleClient()]); // client on file, zero accounts
      let r: Captured | undefined;
      const errs = await withConsoleErrorSpy(async () => {
        r = await captured(() => runGoogleCalendars(['--json']));
      });
      expect(r?.exitCalled).toBe(2);
      expect(errs).toContain('No connected Google account');
      expect(errs).toContain('gbrain google connect');
      expect(r?.out).toBe('');
      expect(fetchCalls).toHaveLength(0);
    });
  });

  test('two connected accounts and no --account → exit 2 naming both', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      connectedVault(home, 'a@example.com', 'b@example.com');
      let r: Captured | undefined;
      const errs = await withConsoleErrorSpy(async () => {
        r = await captured(() => runGoogleCalendars([]));
      });
      expect(r?.exitCalled).toBe(2);
      expect(errs).toContain('Multiple Google accounts connected');
      expect(errs).toContain('--account <email>');
      expect(errs).toContain('a@example.com');
      expect(errs).toContain('b@example.com');
      expect(fetchCalls).toHaveLength(0);
    });
  });

  test('--account not in the vault → CredentialError not_connected naming the normalized account, no API call', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      connectedVault(home, 'a@example.com');
      let thrown: unknown;
      try {
        await captured(() => runGoogleCalendars(['--account', 'Nobody@Example.com']));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(CredentialError);
      const err = thrown as CredentialError;
      expect(err.code).toBe('not_connected');
      expect(err.problem).toContain('nobody@example.com');
      expect(err.problem).toContain('gbrain google connect --account nobody@example.com');
      expect(fetchCalls).toHaveLength(0);
    });
  });

  test('--json emits the standard envelope: ok + status + account + calendars[] with the primary flagged', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      connectedVault(home, 'a@example.com');
      const r = await captured(() => runGoogleCalendars(['--json']));
      expect(r.exitCalled).toBeUndefined();
      expect(r.verdict).toBe(0);
      const env = JSON.parse(r.out) as CalendarsEnvelope;
      // The shared Google command contract (docs/guides/google-connect.md,
      // "For agents"): every --json response carries ok + status.
      expect(env.ok).toBe(true);
      expect(env.status).toBe('ok');
      expect(env.account).toBe('a@example.com');
      expect(env.calendars).toEqual([
        { id: 'a@example.com', summary: 'A Example', primary: true, accessRole: 'owner' },
        { id: FAMILY_CAL_ID, summary: 'Family', primary: false, accessRole: 'reader' },
      ]);
      expect(env.calendars.filter((c) => c.primary)).toHaveLength(1);
      // The follow-on command rides in next_action so an agent needs no
      // human-text parsing to learn how to ingest a secondary calendar.
      expect(env.next_action?.command).toContain('gbrain sources add');
      expect(env.next_action?.command).toContain('--account a@example.com');
      expect(env.next_action?.command).toContain('--calendar-id');
      // One calendarList round-trip; the cached token means no refresh call.
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toContain('/calendar/v3/users/me/calendarList');
    });
  });

  test('human output marks the primary with * and prints the sources add --calendar-id hint', async () => {
    const home = freshHome();
    await withEnv(connectEnv(home), async () => {
      connectedVault(home, 'a@example.com');
      const r = await captured(() => runGoogleCalendars(['--account', 'a@example.com']));
      expect(r.exitCalled).toBeUndefined();
      expect(r.verdict).toBe(0);
      expect(r.out).toContain('Calendars readable by a@example.com');
      expect(r.out).toContain('* A Example');
      expect(r.out).not.toContain('* Family');
      expect(r.out).toContain(`id: ${FAMILY_CAL_ID}`);
      expect(r.out).toContain('access: reader');
      expect(r.out).toContain('(* = primary');
      expect(r.out).toContain(
        'gbrain sources add <id> --kind google --account a@example.com --services calendar --calendar-id "<id>"',
      );
      expect(() => JSON.parse(r.out)).toThrow(); // human mode is not JSON
    });
  });
});
