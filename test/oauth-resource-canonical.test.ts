/**
 * #5222 — one RFC 8707 resource canonicalizer across /authorize, code
 * exchange and refresh, derived from the configured public URL.
 *
 * Pre-fix, /authorize stored any `resource` and minted a token bound to it,
 * then /mcp rejected that token forever (ChatGPT sends the origin root). Pins:
 *   1. the issuer origin (any trailing slash, default port, host case) is an
 *      alias of the canonical /mcp resource at every stage;
 *   2. any other resource is refused with `invalid_target` naming the
 *      accepted URL, at /authorize before a request is pending and at /token
 *      without consuming the code;
 *   3. pre-resource grants and origin-bound grants minted before the fix keep
 *      working and now yield /mcp-bound tokens.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import express from 'express';
import cookieParser from 'cookie-parser';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { canonicalOAuthResource } from '../src/core/oauth-grants.ts';
import type { SqlQuery } from '../src/core/sql-query.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { mountConfidentialOAuth, mountOAuthConsent } from '../src/commands/serve-http-oauth.ts';
import { generateToken, hashToken } from '../src/core/utils.ts';
import { pgliteOAuthTransaction, TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from './helpers/oauth.ts';

const PUBLIC_URL = 'https://brain.example';
const CANONICAL = `${PUBLIC_URL}/mcp`;
const REDIRECT = 'https://client.example/callback';
const OWNER = 'gbrain_admin=synthetic-owner-session';

let db: PGlite;
let sql: SqlQuery;
let provider: GBrainOAuthProvider;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let base: string;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings, ...values) => (await db.query<Record<string, unknown>>(
    strings.reduce((query, fragment, i) => query + fragment + (i < values.length ? `$${i + 1}` : ''), ''), values)).rows;
  provider = new GBrainOAuthProvider({ sql, transaction: pgliteOAuthTransaction(db), resourceUrl: new URL(CANONICAL) });
  const app = express();
  app.use(cookieParser());
  const pass: express.RequestHandler = (_req, _res, next) => next();
  const requireAdmin: express.RequestHandler = (req, res, next) => {
    if (req.cookies?.gbrain_admin !== 'synthetic-owner-session') { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  };
  mountConfidentialOAuth(app, provider, pass);
  mountOAuthConsent(app, provider, requireAdmin, pass);
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(PUBLIC_URL), scopesSupported: ['read', 'write'] }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  base = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (db) await db.close();
});

async function register(): Promise<string> {
  const { clientId } = await provider.registerClientManual('resource-client', ['authorization_code', 'refresh_token'], 'read write', [REDIRECT], 'default', undefined, 'none');
  return clientId;
}

function authorizeUrl(clientId: string, resource?: string): string {
  const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT,
    code_challenge: TEST_PKCE_CHALLENGE, code_challenge_method: 'S256', scope: 'read write', state: 's1' });
  if (resource !== undefined) query.set('resource', resource);
  return `${base}/authorize?${query}`;
}

async function approve(clientId: string, resource?: string): Promise<{ code: string; requested: string | null }> {
  const response = await fetch(authorizeUrl(clientId, resource), { redirect: 'manual' });
  expect(response.status).toBe(302);
  const id = new URL(response.headers.get('location')!, base).searchParams.get('oauth_request')!;
  expect(id).toBeTruthy();
  const details = await (await fetch(`${base}/admin/api/oauth-requests/${id}`, { headers: { Cookie: OWNER } })).json() as any;
  const decided = await fetch(`${base}/admin/api/oauth-requests/${id}`, { method: 'POST',
    headers: { Cookie: OWNER, 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf: details.csrf, decision: 'approve' }) });
  expect(decided.status).toBe(200);
  return { code: new URL((await decided.json() as any).redirectUrl).searchParams.get('code')!, requested: details.resource };
}

async function exchange(clientId: string, code: string, resource?: string): Promise<Response> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: TEST_PKCE_VERIFIER });
  if (resource !== undefined) body.set('resource', resource);
  return fetch(`${base}/token`, { method: 'POST', body });
}

async function refresh(clientId: string, refreshToken: string, resource?: string): Promise<Response> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  if (resource !== undefined) body.set('resource', resource);
  return fetch(`${base}/token`, { method: 'POST', body });
}

async function boundResource(accessToken: string): Promise<string | undefined> {
  return (await provider.verifyAccessToken(accessToken)).resource?.toString();
}

describe('canonicalOAuthResource (#5222)', () => {
  const canonical = new URL(CANONICAL);
  for (const alias of ['https://brain.example', 'https://brain.example/', 'https://BRAIN.example:443/', 'https://brain.example/mcp', 'https://brain.example/mcp/']) {
    test(`${alias} canonicalizes to ${CANONICAL}`, () => {
      expect(canonicalOAuthResource(alias, canonical).toString()).toBe(CANONICAL);
    });
  }
  for (const foreign of ['https://other.example/mcp', 'http://brain.example/mcp', 'https://brain.example:8443/mcp',
    'https://brain.example/other', 'https://brain.example/mcp?x=1', 'https://brain.example/mcp#frag', 'https://user@brain.example/mcp']) {
    test(`${foreign} is invalid_target naming the accepted resource`, () => {
      let thrown: unknown;
      try { canonicalOAuthResource(foreign, canonical); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(InvalidTargetError);
      expect((thrown as Error).message).toContain(CANONICAL);
    });
  }
});

describe('OAuth resource lifecycle over HTTP (#5222)', () => {
  test('an origin-root resource yields a /mcp-bound token at authorize, exchange and refresh', async () => {
    const clientId = await register();
    const { code, requested } = await approve(clientId, `${PUBLIC_URL}/`);
    expect(requested).toBe(CANONICAL);
    const response = await exchange(clientId, code, `${PUBLIC_URL}/`);
    expect(response.status).toBe(200);
    const tokens = await response.json() as any;
    expect(await boundResource(tokens.access_token)).toBe(CANONICAL);
    const rotated = await refresh(clientId, tokens.refresh_token, PUBLIC_URL);
    expect(rotated.status).toBe(200);
    expect(await boundResource((await rotated.json() as any).access_token)).toBe(CANONICAL);
  });

  test('the canonical /mcp resource is unchanged', async () => {
    const clientId = await register();
    const { code, requested } = await approve(clientId, CANONICAL);
    expect(requested).toBe(CANONICAL);
    const tokens = await (await exchange(clientId, code)).json() as any;
    expect(await boundResource(tokens.access_token)).toBe(CANONICAL);
  });

  test('any other resource is refused at /authorize with invalid_target and no pending request', async () => {
    const clientId = await register();
    const response = await fetch(authorizeUrl(clientId, 'https://other.example/'), { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_target');
    expect(location.searchParams.get('error_description')).toContain(CANONICAL);
    expect(location.searchParams.get('state')).toBe('s1');
    expect(await sql`SELECT * FROM oauth_codes WHERE client_id = ${clientId}`).toHaveLength(0);
  });

  test('a resource matching the request Host but not the configured public URL is refused', async () => {
    const clientId = await register();
    const response = await fetch(authorizeUrl(clientId, `${base}/mcp`), { redirect: 'manual' });
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  test('a foreign resource at /token is invalid_target and does not consume the code', async () => {
    const clientId = await register();
    const { code } = await approve(clientId, CANONICAL);
    const refused = await exchange(clientId, code, 'https://other.example/mcp');
    expect(refused.status).toBe(400);
    const body = await refused.json() as any;
    expect(body.error).toBe('invalid_target');
    expect(body.error_description).toContain(CANONICAL);
    const response = await exchange(clientId, code, PUBLIC_URL);
    expect(response.status).toBe(200);
    expect(await boundResource((await response.json() as any).access_token)).toBe(CANONICAL);
  });

  test('a pre-resource grant keeps working and binds the canonical resource when one is requested', async () => {
    const clientId = await register();
    const { code, requested } = await approve(clientId);
    expect(requested).toBeNull();
    const tokens = await (await exchange(clientId, code, `${PUBLIC_URL}/`)).json() as any;
    expect(await boundResource(tokens.access_token)).toBe(CANONICAL);
    const unbound = await approve(clientId);
    const legacy = await (await exchange(clientId, unbound.code)).json() as any;
    expect(await boundResource(legacy.access_token)).toBeUndefined();
  });

  test('an origin-bound refresh token minted before the fix refreshes to a /mcp-bound token', async () => {
    const clientId = await register();
    const legacyRefresh = generateToken('gbrain_rt_');
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
      VALUES (${hashToken(legacyRefresh)}, ${'refresh'}, ${clientId}, ${'{"read","write"}'}, ${expires}, ${`${PUBLIC_URL}/`})`;
    const rotated = await refresh(clientId, legacyRefresh);
    expect(rotated.status).toBe(200);
    expect(await boundResource((await rotated.json() as any).access_token)).toBe(CANONICAL);
  });
});
