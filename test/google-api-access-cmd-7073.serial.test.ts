/**
 * #7073: `gbrain google status` and `gbrain google setup` probe Gmail,
 * Calendar and People together and name every disabled API (project, API,
 * the console link from Google's error body) and missing scope in one report
 * with an agent-protocol fix. Setup stops before registering a source.
 *
 * Serial file: swaps globalThis.fetch. Every run uses a fresh GBRAIN_HOME
 * with no brain configured, so only the fixture vault is read. Synthetic
 * data only: example.invalid addresses and a made-up project number.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGoogleStatus } from '../src/commands/google.ts';
import { runGoogleSetup } from '../src/commands/google-setup.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const ACCOUNT = 'owner@example.invalid';
const PROJECT = '987654321';
const CLIENT_ID = `${PROJECT}-abcdef.apps.googleusercontent.com`;
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/contacts.readonly'];
/** Synthetic token values, built so no literal reads as a credential. */
const FIXTURE_ACCESS = ['fixture', 'access'].join('-');
const FIXTURE_REFRESH = ['fixture', 'refresh'].join('-');
const enableUrl = (api: string) => `https://console.developers.google.com/apis/api/${api}/overview?project=${PROJECT}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const disabled = (api: string, title: string) => json({ error: { code: 403, status: 'PERMISSION_DENIED', message: `${title} has not been used in project ${PROJECT} before or it is disabled.`,
  errors: [{ reason: 'accessNotConfigured' }],
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED',
    metadata: { service: api, serviceTitle: title, consumer: `projects/${PROJECT}`, activationUrl: enableUrl(api) } }] } }, 403);

let disabledApis = new Set<string>();
const realFetch = globalThis.fetch;
const mockFetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: FIXTURE_ACCESS, expires_in: 3600 });
  if (url.hostname === 'openidconnect.googleapis.com') return json({ email: ACCOUNT });
  if (url.pathname.endsWith('/users/me/profile')) return disabledApis.has('gmail') ? disabled('gmail.googleapis.com', 'Gmail API') : json({ emailAddress: ACCOUNT, historyId: '1' });
  if (url.pathname.endsWith('/calendars/primary')) return disabledApis.has('calendar') ? disabled('calendar-json.googleapis.com', 'Google Calendar API') : json({ id: ACCOUNT });
  if (url.pathname.endsWith('/people/me')) return disabledApis.has('people') ? disabled('people.googleapis.com', 'People API') : json({ emailAddresses: [{ value: ACCOUNT, metadata: { primary: true } }] });
  if (url.pathname.endsWith('/people/me/connections')) return disabledApis.has('people') ? disabled('people.googleapis.com', 'People API') : json({ connections: [] });
  throw new Error(`unexpected fetch in test: ${url}`);
}) as typeof fetch;

beforeEach(() => { disabledApis = new Set(); globalThis.fetch = mockFetch; _resetCliExitVerdictForTests(); });
afterEach(() => { globalThis.fetch = realFetch; _resetCliExitVerdictForTests(); });

function home(scopes = SCOPES): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-7073-'));
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, '.gbrain', 'credentials.json'), JSON.stringify({ version: 1,
    clients: [{ provider: 'google', client_id: CLIENT_ID, client_secret: 'GOCSPX-test-secret-0000', created_at: now }],
    credentials: { [`google:${ACCOUNT}`]: { id: `google:${ACCOUNT}`, provider: 'google', kind: 'oauth2', client_ref: 'byo',
      secret: { access_token: FIXTURE_ACCESS, refresh_token: FIXTURE_REFRESH, expiry: new Date(Date.now() + 3_600_000).toISOString() },
      meta: { account: ACCOUNT, scopes, client_id: CLIENT_ID, connected_at: now, last_refresh_ok_at: now, consent_publish_state: 'production' } } } }), { mode: 0o600 });
  return dir;
}

async function run(fn: () => Promise<void>): Promise<{ out: string; err: string; verdict: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const prevExitCode = process.exitCode;
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try { await fn(); } finally { process.stdout.write = outOrig; process.stderr.write = errOrig; }
  const verdict = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = prevExitCode ?? 0;
  return { out: out.join(''), err: err.join(''), verdict };
}

const env = (dir: string) => ({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });

describe('#7073 gbrain google status probes every service at once', () => {
  test('Gmail and People disabled: one account report lists both with project and link, ok:false, exit 1', async () => {
    disabledApis = new Set(['gmail', 'people']);
    const dir = home();
    const r = await withEnv(env(dir), () => run(() => runGoogleStatus(['--json'])));
    const body = JSON.parse(r.out) as { ok: boolean; accounts: Array<{ refresh_probe: string; api_access: { resolved_account: string; problems: Array<Record<string, unknown>>; fix: { next: string; user_message: string } } }> };
    expect(body.ok).toBe(false);
    expect(r.verdict).toBe(1);
    const access = body.accounts[0]!.api_access;
    expect(access.resolved_account).toBe(ACCOUNT);
    expect(access.problems).toEqual([
      { service: 'gmail', code: 'api_not_enabled', api: 'gmail.googleapis.com', api_title: 'Gmail API', project: PROJECT, enable_url: enableUrl('gmail.googleapis.com') },
      { service: 'contacts', code: 'api_not_enabled', api: 'people.googleapis.com', api_title: 'People API', project: PROJECT, enable_url: enableUrl('people.googleapis.com') },
    ]);
    expect(access.fix.next).toBe('ask_user');
    expect(access.fix.user_message).toContain(enableUrl('gmail.googleapis.com'));
    expect(access.fix.user_message).toContain(enableUrl('people.googleapis.com'));
  });

  test('human output names each disabled API on its own line', async () => {
    disabledApis = new Set(['gmail', 'calendar']);
    const r = await withEnv(env(home()), () => run(() => runGoogleStatus([])));
    expect(r.out).toContain(`gmail: api_not_enabled — Gmail API (gmail.googleapis.com) is disabled for project ${PROJECT}; enable: ${enableUrl('gmail.googleapis.com')}`);
    expect(r.out).toContain(`calendar: api_not_enabled — Google Calendar API (calendar-json.googleapis.com) is disabled for project ${PROJECT}`);
    expect(r.verdict).toBe(1);
  });

  test('every API enabled: ok:true and no problems', async () => {
    const r = await withEnv(env(home()), () => run(() => runGoogleStatus(['--json'])));
    const body = JSON.parse(r.out) as { ok: boolean; accounts: Array<{ api_access: { problems: unknown[] } }> };
    expect(body.ok).toBe(true);
    expect(body.accounts[0]!.api_access.problems).toEqual([]);
    expect(r.verdict).toBe(0);
  });
});

describe('#7073 gbrain google setup probes before registering anything', () => {
  test('two disabled APIs and an ungranted scope stop setup with one report and exit 2', async () => {
    disabledApis = new Set(['gmail', 'people']);
    const dir = home(SCOPES.filter(s => !s.includes('calendar')));
    const r = await withEnv(env(dir), () => run(() => runGoogleSetup(['--json'])));
    const body = JSON.parse(r.out) as { ok: boolean; status: string; api_access: { problems: Array<{ service: string; code: string }>; fix: { next: string } } };
    expect(body).toMatchObject({ ok: false, status: 'api_access_blocked' });
    expect(body.api_access.problems.map(p => `${p.service}:${p.code}`)).toEqual(['gmail:api_not_enabled', 'calendar:scope_missing', 'contacts:api_not_enabled']);
    expect(body.api_access.fix.next).toBe('ask_user');
    expect(r.verdict).toBe(2);
  });

  test('human output names every API and the narrower setup, with the fix in one [SHOW USER] relay', async () => {
    disabledApis = new Set(['people']);
    const r = await withEnv(env(home()), () => run(() => runGoogleSetup([])));
    expect(r.err).toContain('[SHOW USER]');
    expect(r.err).toContain('next: ask_user');
    expect(r.err).toContain(`People API (people.googleapis.com) is disabled for Google Cloud project ${PROJECT}. Enable it: ${enableUrl('people.googleapis.com')}`);
    expect(r.err).toContain(`gbrain google setup --account ${ACCOUNT} --services gmail,calendar`);
    expect(r.err).not.toContain('Registered source');
    expect(r.verdict).toBe(2);
  });

  test('every API reachable: setup continues past the probe to the brain step', async () => {
    const r = await withEnv(env(home()), () => run(() => runGoogleSetup(['--json'])));
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, status: 'no_brain' });
    expect(r.verdict).toBe(2);
  });
});
