/** Full production admin/login/consent route wiring on an isolated in-memory brain. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from '../helpers/oauth.ts';

let child: ChildProcess;
let home: string;
let base: string;
// ONE admin login for the whole file (the shared admin auth limiter is
// 10/min/IP and the consent routes draw from the same bucket), taken in
// beforeAll so every test is order-independent. `adminSetCookie` keeps the
// raw header for the attribute assertions.
let adminCookie = '';
let adminSetCookie = '';
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
  let up = false;
  for (let attempt = 0; attempt < 150 && !up; attempt++) {
    if (child.exitCode !== null) throw new Error(`Consent server exited: ${output.slice(-2000)}`);
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* starting */ }
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error(`Consent server did not start: ${output.slice(-2000)}`);
  const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: BOOTSTRAP }) });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  adminSetCookie = login.headers.get('set-cookie') ?? '';
  adminCookie = adminSetCookie.split(';')[0];
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
  expect(pendingUrl.searchParams.has('code')).toBe(false);
  const id = pendingUrl.searchParams.get('oauth_request')!;
  expect((await fetch(pendingUrl)).status).toBe(200); // unauthenticated page shell
  expect((await fetch(`${base}/admin/api/oauth-requests/${id}`)).status).toBe(401);
  expect(adminCookie).not.toBe('');
  const oldCookie = adminCookie; // the beforeAll login session
  expect(adminSetCookie).toContain('SameSite=Strict');
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

/** Anonymous self-registration with a foreign redirect_uri: no code without the owner, forged codes do not redeem, revocation closes /authorize. */
test('a self-registered public client cannot obtain or redeem a code without owner approval', async () => {
  const foreignRedirect = 'https://client-example.invalid/cb';
  const register = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      client_name: 'synthetic self-registered client', redirect_uris: [foreignRedirect], token_endpoint_auth_method: 'none', ...body }) });
    expect(response.status).toBe(201);
    return response.json() as Promise<any>;
  };
  const authorize = async (clientId: string, scope?: string) => {
    const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: foreignRedirect, code_challenge: TEST_PKCE_CHALLENGE, code_challenge_method: 'S256', state: 'attacker-state' });
    if (scope !== undefined) query.set('scope', scope);
    return fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  };
  const expectPending = async (clientId: string, scope?: string) => {
    const response = await authorize(clientId, scope);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!, base);
    expect(location.pathname).toBe('/admin/');
    expect(location.searchParams.has('code')).toBe(false);
    return location.searchParams.get('oauth_request')!;
  };

  // grant_types omitted: the default is the consent-bearing authorization_code flow.
  const client = await register({ scope: 'read write' });
  expect(client.client_secret).toBeUndefined();
  await expectPending(client.client_id, 'read write');
  const forged = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', code: 'gbrain_code_' + 'a'.repeat(43), code_verifier: TEST_PKCE_VERIFIER,
    client_id: client.client_id, redirect_uri: foreignRedirect }) });
  expect(forged.status).toBe(400);
  expect((await forged.json() as any).error).toBe('invalid_grant');

  // scope omitted: nothing is registered and the consent request carries no scopes (one consent GET).
  const unscoped = await register({ grant_types: ['authorization_code'] });
  expect(unscoped.scope ?? '').toBe('');
  const id = await expectPending(unscoped.client_id);
  const details = await fetch(`${base}/admin/api/oauth-requests/${id}`, { headers: { Cookie: adminCookie } });
  expect(details.status).toBe(200);
  expect((await details.json() as any).scopes).toEqual([]);

  // Revoked self-registered client: /authorize is refused before any consent request exists.
  const revoked = await fetch(`${base}/admin/api/revoke-client`, { method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: client.client_id }) });
  expect(revoked.status).toBe(200);
  const refused = await authorize(client.client_id, 'read write');
  expect(refused.status).toBe(400);
  expect((await refused.json() as any).error).toBe('invalid_client');
}, 15_000);

/** With self-registration on, discovery advertises exactly what a self-registering client may request — and a client that copies it registers. */
test('OAuth discovery advertises the self-registration ceiling and a client that copies it registers', async () => {
  const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as any;
  expect(metadata.scopes_supported).toEqual(['read', 'write']);
  expect(new URL(metadata.registration_endpoint).pathname).toBe('/register');
  const register = (scope: string) => fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    client_name: 'synthetic discovered-scopes client', redirect_uris: ['https://client-example.invalid/cb'], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none', scope }) });
  const response = await register(metadata.scopes_supported.join(' '));
  expect(response.status).toBe(201);
  const client = await response.json() as any;
  expect(client.scope.split(' ')).toEqual(metadata.scopes_supported);
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const resource = await (await fetch(`${base}${path}`)).json() as any;
    expect(resource.scopes_supported).toEqual(metadata.scopes_supported);
  }
  // Narrowed discovery does not loosen the ceiling: an explicit privileged request is still refused.
  const refused = await register('read write admin');
  expect(refused.status).toBe(400);
  expect((await refused.json() as any).error).toBe('invalid_client_metadata');
}, 15_000);
