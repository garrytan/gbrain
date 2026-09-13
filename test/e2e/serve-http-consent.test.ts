/** Full production admin/login/consent route wiring on an isolated in-memory brain. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { TEST_PKCE_CHALLENGE } from '../helpers/oauth.ts';

let child: ChildProcess;
let home: string;
let base: string;
const BOOTSTRAP = 'synthetic-consent-admin-test-token';
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-consent-test-'));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  await new Promise<void>((resolve, reject) => probe.close(err => err ? reject(err) : resolve()));
  base = `http://127.0.0.1:${address.port}`;
  child = spawn(process.execPath, [join(import.meta.dir, '../fixtures/oauth-consent-server.ts')], {
    cwd: join(import.meta.dir, '../..'),
    env: { ...process.env, NODE_ENV: 'test', GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '',
      GBRAIN_TEST_HTTP_PORT: String(address.port), GBRAIN_ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr?.on('data', chunk => { output += chunk.toString(); });
  child.stdout?.on('data', chunk => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Consent server exited: ${output.slice(-2000)}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ }
    await Bun.sleep(100);
  }
  throw new Error(`Consent server did not start: ${output.slice(-2000)}`);
}, 30_000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, Bun.sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

test('login, magic-link recovery, consent authentication and single-use approval are wired in the real server', async () => {
  const registration = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    client_name: 'synthetic consent client', redirect_uris: [`${base}/callback`], grant_types: ['authorization_code', 'refresh_token'], scope: 'read write', token_endpoint_auth_method: 'none',
  }) });
  expect(registration.status).toBe(201);
  const client = await registration.json() as any;
  const query = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: `${base}/callback`, code_challenge: TEST_PKCE_CHALLENGE, code_challenge_method: 'S256', scope: 'read write', state: 'synthetic-state' });
  const authorization = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  const pendingUrl = new URL(authorization.headers.get('location')!, base);
  expect(pendingUrl.pathname).toBe('/admin/');
  const id = pendingUrl.searchParams.get('oauth_request')!;
  expect((await fetch(pendingUrl)).status).toBe(200); // unauthenticated page shell
  expect((await fetch(`${base}/admin/api/oauth-requests/${id}`)).status).toBe(401);
  const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: BOOTSTRAP }) });
  expect(login.status).toBe(200);
  const oldCookie = login.headers.get('set-cookie')!.split(';')[0];
  expect(login.headers.get('set-cookie')).toContain('SameSite=Strict');
  const oldDetails = await (await fetch(`${base}/admin/api/oauth-requests/${id}`, { headers: { Cookie: oldCookie } })).json() as any;
  const magic = await fetch(`${base}/admin/api/issue-magic-link`, { method: 'POST', headers: { Authorization: `Bearer ${BOOTSTRAP}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ oauth_request: id, return_url: 'https://untrusted.example' }) });
  expect(magic.status).toBe(200);
  const magicUrl = (await magic.json() as any).url.replace(`http://localhost:${new URL(base).port}`, base);
  const redemption = await fetch(magicUrl, { redirect: 'manual' });
  expect(redemption.status).toBe(302);
  expect(redemption.headers.get('location')).toBe(`/admin/?oauth_request=${id}#oauth-consent`);
  const newCookie = redemption.headers.get('set-cookie')!.split(';')[0];
  expect(newCookie).not.toBe(oldCookie);
  const endpoint = `${base}/admin/api/oauth-requests/${id}`;
  const headers = { Cookie: newCookie, 'Content-Type': 'application/json' };
  expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve', csrf: oldDetails.csrf }) })).status).toBe(403);
  const details = await (await fetch(endpoint, { headers })).json() as any;
  expect(details.clientName).toBe('synthetic consent client');
  const approved = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve', csrf: details.csrf }) });
  expect(approved.status).toBe(200);
  const redirect = new URL((await approved.json() as any).redirectUrl);
  expect(redirect.origin).toBe(base);
  expect(redirect.searchParams.get('state')).toBe('synthetic-state');
  expect(redirect.searchParams.get('code')).toStartWith('gbrain_code_');
  expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve', csrf: details.csrf }) })).status).toBe(410);
}, 15_000);
