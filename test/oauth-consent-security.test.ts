import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import express from 'express';
import cookieParser from 'cookie-parser';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { OAuthGrants } from '../src/core/oauth-grants.ts';
import type { SqlQuery } from '../src/core/sql-query.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { mountConfidentialOAuth, mountOAuthConsent } from '../src/commands/serve-http-oauth.ts';
import { hashToken } from '../src/core/utils.ts';
import { pgliteOAuthTransaction, TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from './helpers/oauth.ts';

let db: PGlite;
let sql: SqlQuery;
let provider: GBrainOAuthProvider;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let base: string;
const REDIRECT = 'https://client.example/callback';
const RESOURCE = 'https://brain.example/mcp';
const OWNER = 'gbrain_admin=synthetic-owner-session';
const OTHER_SESSION = 'gbrain_admin=synthetic-new-owner-session';

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings, ...values) => (await db.query<Record<string, unknown>>(
    strings.reduce((query, fragment, i) => query + fragment + (i < values.length ? `$${i + 1}` : ''), ''), values)).rows;
  provider = new GBrainOAuthProvider({ sql, transaction: pgliteOAuthTransaction(db) });
  const app = express();
  app.use(cookieParser());
  const pass: express.RequestHandler = (_req, _res, next) => next();
  const requireAdmin: express.RequestHandler = (req, res, next) => {
    if (!['synthetic-owner-session', 'synthetic-new-owner-session'].includes(req.cookies?.gbrain_admin)) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  };
  mountConfidentialOAuth(app, provider, pass);
  mountOAuthConsent(app, provider, requireAdmin, pass);
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL('http://localhost:3131'), scopesSupported: ['read', 'write', 'admin'] }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  base = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())); }
  if (db) await db.close();
});

async function register(method: 'none' | 'client_secret_post' | 'client_secret_basic' = 'none', scope = 'read write') {
  return provider.registerClientManual('synthetic-client', ['authorization_code', 'refresh_token', 'client_credentials'], scope, [REDIRECT], 'default', undefined, method);
}
async function begin(clientId: string, scopes = 'read', state = 'original-state') {
  const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT,
    code_challenge: TEST_PKCE_CHALLENGE, code_challenge_method: 'S256', scope: scopes, state, resource: RESOURCE });
  const response = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!, base);
  expect(location.pathname).toBe('/admin/');
  expect(location.searchParams.has('code')).toBe(false);
  return location.searchParams.get('oauth_request')!;
}
async function details(id: string, cookie = OWNER): Promise<any> {
  const response = await fetch(`${base}/admin/api/oauth-requests/${id}`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  return response.json();
}
async function decide(id: string, csrf: string, decision = 'approve', cookie = OWNER, extra: Record<string, unknown> = {}) {
  return fetch(`${base}/admin/api/oauth-requests/${id}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf, decision, ...extra }) });
}
async function approve(clientId: string) {
  const id = await begin(clientId);
  const request = await details(id);
  const response = await decide(id, request.csrf);
  expect(response.status).toBe(200);
  return new URL((await response.json() as any).redirectUrl).searchParams.get('code')!;
}
async function token(clientId: string, code: string, verifier?: string, secret?: string, basic = false, resource?: string) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
  const headers: Record<string, string> = {};
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
  else { body.set('client_id', clientId); if (secret) body.set('client_secret', secret); }
  if (verifier !== undefined) body.set('code_verifier', verifier);
  if (resource !== undefined) body.set('resource', resource);
  return fetch(`${base}/token`, { method: 'POST', headers, body });
}

describe('owner-approved HTTP authorization', () => {
  test('anonymous authorization creates no code, and consent requires owner authentication and session-bound CSRF', async () => {
    const { clientId } = await register('none', 'admin');
    const id = await begin(clientId, 'admin');
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(0);
    expect((await fetch(`${base}/admin/api/oauth-requests/${id}`)).status).toBe(401);
    const request = await details(id);
    expect(request).toMatchObject({ clientId, redirectUri: REDIRECT, scopes: ['admin'], sourceId: 'default', resource: RESOURCE });
    expect((await decide(id, '0'.repeat(64))).status).toBe(403);
    expect((await decide(id, request.csrf, 'approve', OTHER_SESSION)).status).toBe(403);
    expect((await decide(id, request.csrf, 'approve', OWNER, { scopes: ['write'] })).status).toBe(403);
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(0);
    const renewed = await details(id, OTHER_SESSION);
    const response = await decide(id, renewed.csrf, 'approve', OTHER_SESSION);
    expect(response.status).toBe(200);
    const redirect = new URL((await response.json() as any).redirectUrl);
    expect(redirect.searchParams.get('state')).toBe('original-state');
    expect(redirect.searchParams.get('code')).toStartWith('gbrain_code_');
    expect((await decide(id, renewed.csrf, 'approve', OTHER_SESSION)).status).toBe(410);
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(1);
  });

  test('denial returns access_denied with original state and never creates a code', async () => {
    const { clientId } = await register();
    const id = await begin(clientId);
    const request = await details(id);
    const response = await decide(id, request.csrf, 'deny');
    const redirect = new URL((await response.json() as any).redirectUrl);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('original-state');
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(0);
  });

  test('policy changes and concurrent approvals cannot issue unseen or duplicate grants', async () => {
    const { clientId } = await register();
    const id = await begin(clientId);
    const request = await details(id);
    await sql`UPDATE oauth_clients SET scope = 'admin' WHERE client_id = ${clientId}`;
    expect((await decide(id, request.csrf)).status).toBe(409);
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(0);
    const nextId = await begin(clientId);
    const next = await details(nextId);
    const responses = await Promise.all([decide(nextId, next.csrf), decide(nextId, next.csrf)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 410]);
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(1);
  });

  for (const method of ['none', 'client_secret_post', 'client_secret_basic'] as const) {
    test(`${method}: real token endpoint requires PKCE and preserves resource through redemption and refresh`, async () => {
      const { clientId, clientSecret } = await register(method);
      const code = await approve(clientId);
      const isBasic = method === 'client_secret_basic';
      for (const verifier of [undefined, 'wrong-verifier-that-is-long-enough-to-pass-syntax']) {
        const response = await token(clientId, code, verifier, clientSecret, isBasic);
        expect(response.status).toBe(400);
        expect((await response.json() as any).error).toBe(method === 'none' && verifier === undefined ? 'invalid_request' : 'invalid_grant');
      }
      const widened = await token(clientId, code, TEST_PKCE_VERIFIER, clientSecret, isBasic, 'https://other.example/mcp');
      expect(widened.status).toBe(400);
      const response = await token(clientId, code, TEST_PKCE_VERIFIER, clientSecret, isBasic);
      expect(response.status).toBe(200);
      const tokens = await response.json() as any;
      const verified = await provider.verifyAccessToken(tokens.access_token) as any;
      expect(verified.resource.toString()).toBe(RESOURCE);
      expect(verified.principal).toEqual({ kind: 'oauth_client', id: clientId });
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      const headers: Record<string, string> = {};
      if (isBasic) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      else { body.set('client_id', clientId); if (clientSecret) body.set('client_secret', clientSecret); }
      const refreshed = await fetch(`${base}/token`, { method: 'POST', headers, body });
      expect(refreshed.status).toBe(200);
      const rotated = await refreshed.json() as any;
      expect((await provider.verifyAccessToken(rotated.access_token)).resource?.toString()).toBe(RESOURCE);
      expect((await fetch(`${base}/token`, { method: 'POST', headers, body })).status).toBe(400);
    });
  }

  test('client revocation invalidates outstanding codes, access and refresh tokens, and client lookup', async () => {
    const { clientId } = await register();
    const code = await approve(clientId);
    const response = await token(clientId, code, TEST_PKCE_VERIFIER);
    const tokens = await response.json() as any;
    const client = (await provider.clientsStore.getClient(clientId))!;
    const unredeemed = await approve(clientId);
    await provider.revokeClient(clientId);
    expect(await provider.clientsStore.getClient(clientId)).toBeUndefined();
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(provider.exchangeAuthorizationCode(client, unredeemed, TEST_PKCE_VERIFIER, REDIRECT)).rejects.toThrow();
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token)).rejects.toThrow();
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(0);
    expect(await sql`SELECT * FROM oauth_tokens WHERE client_id = ${clientId}`).toHaveLength(0);
  });

  test('failed token-pair creation rolls back code consumption and preserves pre-upgrade grants', async () => {
    const { clientId } = await register();
    const client = (await provider.clientsStore.getClient(clientId))!;
    const legacyCode = 'synthetic-pre-upgrade-code';
    await sql`INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge, code_challenge_method, redirect_uri, expires_at)
      VALUES (${hashToken(legacyCode)}, ${clientId}, ${'{read}'}, ${TEST_PKCE_CHALLENGE}, ${'S256'}, ${REDIRECT}, ${Math.floor(Date.now() / 1000) + 600})`;
    const transaction = pgliteOAuthTransaction(db);
    const failing = new GBrainOAuthProvider({ sql, transaction: fn => transaction(tx => fn(async (strings, ...values) => {
      if (strings.join('').includes('INSERT INTO oauth_tokens') && values.includes('refresh')) throw new Error('synthetic storage failure');
      return tx(strings, ...values);
    })) });
    await expect(failing.exchangeAuthorizationCode(client, legacyCode, TEST_PKCE_VERIFIER, REDIRECT)).rejects.toThrow('synthetic storage failure');
    expect(await sql`SELECT * FROM oauth_codes WHERE code_hash = ${hashToken(legacyCode)}`).toHaveLength(1);
    expect(await sql`SELECT * FROM oauth_tokens WHERE client_id = ${clientId}`).toHaveLength(0);
    const tokens = await provider.exchangeAuthorizationCode(client, legacyCode, TEST_PKCE_VERIFIER, REDIRECT);
    const restarted = new GBrainOAuthProvider({ sql, transaction });
    expect((await restarted.verifyAccessToken(tokens.access_token)).clientId).toBe(clientId);
    await expect(restarted.exchangeRefreshToken(client, tokens.refresh_token!)).resolves.toHaveProperty('access_token');
  });

  test('uncertain approval completion is terminal and cannot issue a second code', async () => {
    const { clientId } = await register();
    const transaction = pgliteOAuthTransaction(db);
    const uncertain = new GBrainOAuthProvider({ sql, transaction: async fn => {
      await transaction(fn);
      throw new Error('synthetic connection loss after commit');
    } });
    const id = await uncertain.grants.begin(clientId, { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: REDIRECT });
    await expect(uncertain.grants.decide(id, true)).rejects.toThrow('synthetic connection loss');
    await expect(uncertain.grants.decide(id, true)).rejects.toThrow('completed');
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(1);
  });

  test('an existing access token cannot retain a permission removed from current client policy', async () => {
    const { clientId, clientSecret } = await register('client_secret_post', 'read write');
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'write');
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(['write']);
    await sql`UPDATE oauth_clients SET scope = 'read' WHERE client_id = ${clientId}`;
    // Preserve the read capability implied by the original write grant,
    // while dropping the write capability removed by the owner.
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(['read']);
  });
});

/** In-memory grant store whose client row echoes the queried client_id, so many distinct clients can be simulated. */
function memoryGrants() {
  const row = { client_name: 'synthetic', scope: 'read', grant_types: ['authorization_code'], redirect_uris: [REDIRECT] };
  const clock = { now: 0 };
  const options = { sql: (async (_strings: TemplateStringsArray, ...values: unknown[]) => [{ ...row, client_id: values[0] }]) as SqlQuery, tokenTtl: 60, refreshTtl: 3600, now: () => clock.now };
  return { grants: new OAuthGrants(options), options, clock, params: { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: REDIRECT } };
}

/** Anonymous dynamic registration (the advisory shape) must land on the same owner-consent gate as operator-registered clients. */
describe('dynamically registered public clients', () => {
  const ATTACKER_REDIRECT = 'https://client-example.invalid/cb';
  async function registerDcr(overrides: Record<string, unknown> = {}, omit: string[] = []) {
    const body: Record<string, unknown> = { client_name: 'synthetic self-registered client', redirect_uris: [ATTACKER_REDIRECT],
      grant_types: ['authorization_code'], response_types: ['code'], scope: 'read write', token_endpoint_auth_method: 'none', ...overrides };
    for (const key of omit) delete body[key];
    const response = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(201);
    return response.json() as Promise<any>;
  }
  async function authorizeRaw(clientId: string, scope?: string) {
    const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: ATTACKER_REDIRECT,
      code_challenge: TEST_PKCE_CHALLENGE, code_challenge_method: 'S256', state: 'attacker-state' });
    if (scope !== undefined) query.set('scope', scope);
    return fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  }
  async function expectPending(clientId: string, scope?: string) {
    const response = await authorizeRaw(clientId, scope);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!, base);
    expect(location.pathname).toBe('/admin/');
    expect(location.searchParams.has('code')).toBe(false);
    expect(location.hash).toBe('#oauth-consent');
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(0);
    return location.searchParams.get('oauth_request')!;
  }

  test('anonymous registration with a foreign redirect_uri yields a consent request, never a code, and forged codes do not redeem', async () => {
    const client = await registerDcr();
    expect(client.client_id).toStartWith('gbrain_cl_');
    expect(client.client_secret).toBeUndefined();
    const id = await expectPending(client.client_id, 'read write');
    expect(provider.grants.hasPending(id)).toBe(true);
    const forged = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code: 'gbrain_code_' + 'a'.repeat(43), code_verifier: TEST_PKCE_VERIFIER,
      client_id: client.client_id, redirect_uri: ATTACKER_REDIRECT }) });
    expect(forged.status).toBe(400);
    expect((await forged.json() as any).error).toBe('invalid_grant');
    expect(await sql`SELECT * FROM oauth_tokens WHERE client_id = ${client.client_id}`).toHaveLength(0);
  });

  test('registration omitting grant_types defaults to the consent-bearing authorization_code flow', async () => {
    const client = await registerDcr({}, ['grant_types']);
    expect(client.grant_types ?? ['authorization_code']).toEqual(['authorization_code']);
    await expectPending(client.client_id, 'read write');
  });

  test('registration omitting scope registers no scope and its consent request carries no scopes', async () => {
    const client = await registerDcr({}, ['scope']);
    expect(client.scope ?? '').toBe('');
    const id = await expectPending(client.client_id);
    expect((await details(id)).scopes).toEqual([]);
  });

  test('the eleventh pending request for one client is a redirect carrying error=too_many_requests, not a 429', async () => {
    // Contract pin for the docs: the per-client cap trips inside
    // provider.authorize(), which the MCP SDK's phase-2 catch turns into a
    // 302 back to the registered redirect_uri with error parameters. A 429
    // body on /authorize only ever comes from the SDK's per-IP limiter.
    const client = await registerDcr();
    for (let i = 0; i < 10; i++) await expectPending(client.client_id, 'read');
    const response = await authorizeRaw(client.client_id, 'read');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(ATTACKER_REDIRECT);
    expect(location.searchParams.get('error')).toBe('too_many_requests');
    expect(location.searchParams.get('error_description')).toMatch(/pending requests for this client/);
    expect(location.searchParams.get('state')).toBe('attacker-state');
    expect(location.searchParams.has('code')).toBe(false);
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${client.client_id}`).toHaveLength(0);
  });

  test('a revoked self-registered client is rejected before any consent request is created', async () => {
    const client = await registerDcr();
    await provider.revokeClient(client.client_id);
    const response = await authorizeRaw(client.client_id, 'read write');
    expect(response.status).toBe(400);
    expect((await response.json() as any).error).toBe('invalid_client');
    await expect(provider.grants.begin(client.client_id, { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: ATTACKER_REDIRECT, scopes: ['read'] }))
      .rejects.toThrow('revoked');
  });
});

test('pending authorization expires, restart forgets it, and capacity is bounded without evicting live requests', async () => {
  // Fill the global store from many distinct clients (the per-client cap bounds any single client well below this).
  const { grants, options, clock, params } = memoryGrants();
  const first = await grants.begin('synthetic', params);
  for (let i = 1; i < 1000; i++) await grants.begin(`synthetic-${i}`, params);
  await expect(grants.begin('synthetic-overflow', params)).rejects.toThrow('Too many pending');
  expect(grants.details(first).clientId).toBe('synthetic');
  expect(() => new OAuthGrants(options).details(first)).toThrow('server restarted');
  clock.now = 600_001;
  expect(() => grants.details(first)).toThrow('expired');
  await expect(grants.begin('synthetic', params)).resolves.toBeString();
});

test('a single client cannot hold more than ten pending requests, without starving other clients', async () => {
  const { grants, clock, params } = memoryGrants();
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push(await grants.begin('noisy', params));
  await expect(grants.begin('noisy', params)).rejects.toThrow('Too many pending');
  await expect(grants.begin('noisy', params)).rejects.toThrow('this client');
  await expect(grants.begin('quiet', params)).resolves.toBeString();
  expect(grants.details(ids[0]).clientId).toBe('noisy');
  // Only requests still awaiting a decision count against the client's budget.
  await grants.decide(ids[0], false);
  await expect(grants.begin('noisy', params)).resolves.toBeString();
  await expect(grants.begin('noisy', params)).rejects.toThrow('Too many pending');
  clock.now = 600_001;
  await expect(grants.begin('noisy', params)).resolves.toBeString();
});
