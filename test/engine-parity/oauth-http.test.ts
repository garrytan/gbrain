/**
 * BrainEngine parity: the OAuth authorization-code and refresh flow over HTTP as `serve --http` mounts it
 * (src/commands/serve-http-oauth.ts with the SDK's `mcpAuthRouter`), and the grant revoke `OAuthGrants.revokeClient`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm a registered client walks GET /authorize (a 302 to the owner's consent page, no code),
 *    the owner's approval (a code on the redirect with the original state), POST /token with the PKCE verifier (an access
 *    and a refresh token the bearer check accepts), POST /token with the refresh token (a new pair the bearer check
 *    accepts) and a second use of the old refresh token (PGLite and Postgres: 200 with the pair that replaced it, inside the 60 s grace window of #9364). The Rust store keeps no refresh families (it does not report
 *    `oauth_refresh_families`), so it fails closed (RUST_ENGINE.md row OA-1): its /token answer has no refresh_token key
 *    and otherwise the same keys, and a refresh token already in its store is refused with invalid_grant and issues nothing.
 *    On PGLite and Postgres the /token answers stay byte for byte what they were before that rule
 *    (test/fixtures/oauth-token-response-bytes.json, token values masked). A public client (`none`) and a confidential
 *    one (`client_secret_post`) answer the same way, and a wrong secret is 401 invalid_client. `revokeClient` keeps the
 *    client row with `deleted_at` set, deletes its codes and tokens, leaves another client alone, and a second revoke is
 *    a no-op; on PGLite and Postgres the raw-SQL path of the same call leaves the same state.
 *  - Regression: a client lookup or a refresh read the Rust store cannot serve (raw SQL), so /authorize or /token fails on
 *    a Rust brain; a refresh token replay that issues a pair other than the one that replaced it; a Rust
 *    token answer that carries a refresh token, or a Rust refresh grant that rotates one, while no replay can revoke its sign-in; a revoke on one path that hard-deletes the row the other keeps.
 *  - Why existing coverage misses it: test/oauth-consent-security.test.ts runs the HTTP flow on PGLite through raw SQL, and
 *    test/engine-parity/access-tokens.test.ts drives OAuthGrants directly, never the clients store or a refresh.
 *  - Seam: none. Real engines, a real express app on a loopback port; the tables are read through typed members only.
 */
import { describe } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { BrainEngine } from '../../src/core/engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { OAuthGrants } from '../../src/core/oauth-grants.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mountConfidentialOAuth, mountOAuthConsent } from '../../src/commands/serve-http-oauth.ts';
import { hashToken } from '../../src/core/utils.ts';
import { TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from '../helpers/oauth.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const REDIRECT = 'https://client.example/callback';
const RESOURCE = 'https://brain.example/mcp';
const OWNER = 'gbrain_admin=synthetic-owner-session';
const SECRET = 'synthetic-client-secret';

/**
 * The /token answers' bytes on PGLite and Postgres, with each token value masked, captured on the commit before the
 * Rust fail-closed change (34636529a1) with CAPTURE_OAUTH_TOKEN_BYTES=1. Both SQL engines must keep answering byte for byte.
 */
const TOKEN_BYTES_PATH = join(import.meta.dir, '..', 'fixtures', 'oauth-token-response-bytes.json');
const TOKEN_BYTES: Record<string, string> = existsSync(TOKEN_BYTES_PATH) ? JSON.parse(readFileSync(TOKEN_BYTES_PATH, 'utf8')) : {};
const maskTokens = (text: string) => text.replace(/gbrain_(at|rt)_[A-Za-z0-9_-]+/g, 'gbrain_$1_<masked>');
function tokenBytes(key: string, text: string): void {
  const masked = maskTokens(text);
  if (process.env.CAPTURE_OAUTH_TOKEN_BYTES === '1') {
    const all = existsSync(TOKEN_BYTES_PATH) ? JSON.parse(readFileSync(TOKEN_BYTES_PATH, 'utf8')) : {};
    writeFileSync(TOKEN_BYTES_PATH, `${JSON.stringify({ ...all, [key]: masked }, Object.keys({ ...all, [key]: masked }).sort(), 2)}\n`);
    return;
  }
  if (TOKEN_BYTES[key] !== masked) throw new Error(`token answer bytes changed for ${key}: ${JSON.stringify({ was: TOKEN_BYTES[key], now: masked })}`);
}

/** The provider `serve --http` builds (serve-http.ts): grant work runs on the engine's transaction. */
function providerFor(engine: BrainEngine): GBrainOAuthProvider {
  return new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine,
    transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx), tx)) });
}

/** An express app with the OAuth routes `serve --http` mounts, on a loopback port, until `close`. */
async function serve(provider: GBrainOAuthProvider): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(cookieParser());
  const pass: express.RequestHandler = (_req, _res, next) => next();
  const requireAdmin: express.RequestHandler = (req, res, next) => {
    if (req.cookies?.gbrain_admin !== 'synthetic-owner-session') { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  };
  mountConfidentialOAuth(app, provider, pass);
  mountOAuthConsent(app, provider, requireAdmin, pass);
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL('http://localhost:3131'), scopesSupported: ['read', 'write', 'admin'] }));
  const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** What a caller sees of an HTTP answer: the status and the OAuth error code, if any. */
async function answer(res: Response): Promise<{ status: number; error?: unknown; body?: Record<string, unknown> }> {
  const text = await res.text();
  let body: Record<string, unknown> | undefined;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return res.status === 200 ? { status: 200, body } : { status: res.status, error: body?.error ?? text };
}

/** A bearer check as `serve --http` runs it: the client, scopes and resource, or the refusal. */
async function bearer(provider: GBrainOAuthProvider, token: string): Promise<Record<string, unknown>> {
  try {
    const auth = await provider.verifyAccessToken(token) as unknown as Record<string, unknown>;
    return { clientId: auth.clientId, scopes: auth.scopes, resource: String(auth.resource), principal: auth.principal };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'engine_capability_missing') throw error;
    return { refused: (error as Error).constructor.name };
  }
}

/** The full code flow and refresh over HTTP for one client; the tokens' shapes, never their values. */
async function codeFlow(base: string, provider: GBrainOAuthProvider, clientId: string, backend: string, secret?: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT,
    code_challenge: TEST_PKCE_CHALLENGE, code_challenge_method: 'S256', scope: 'read', state: 'original-state', resource: RESOURCE });
  const authorize = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  const location = new URL(authorize.headers.get('location') ?? '/', base);
  out.authorize = { status: authorize.status, path: location.pathname, hasCode: location.searchParams.has('code') };
  if (authorize.status !== 302) throw new Error(`authorize: ${JSON.stringify({ ...out, body: await authorize.text() })}`);
  const id = location.searchParams.get('oauth_request')!;
  const details = await (await fetch(`${base}/admin/api/oauth-requests/${id}`, { headers: { Cookie: OWNER } })).json() as Record<string, unknown>;
  out.details = { clientId: details.clientId, scopes: details.scopes, resource: details.resource, sourceId: details.sourceId, sourceChoice: details.sourceChoice };
  const decided = await fetch(`${base}/admin/api/oauth-requests/${id}`, { method: 'POST', headers: { Cookie: OWNER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrf: details.csrf, decision: 'approve' }) });
  const decision = await answer(decided);
  if (decision.status !== 200) throw new Error(`decide: ${JSON.stringify(decision)}`);
  const redirect = new URL(String(decision.body!.redirectUrl));
  const code = redirect.searchParams.get('code')!;
  out.redirect = { origin: redirect.origin, state: redirect.searchParams.get('state'), codeShape: /^gbrain_code_/.test(code) };
  const form = (fields: Record<string, string>) => {
    const body = new URLSearchParams({ client_id: clientId, ...fields });
    if (secret !== undefined) body.set('client_secret', secret);
    return fetch(`${base}/token`, { method: 'POST', body });
  };
  if (secret !== undefined) {
    const wrong = new URLSearchParams({ client_id: clientId, client_secret: 'not-the-secret', grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: TEST_PKCE_VERIFIER });
    out.wrongSecret = await answer(await fetch(`${base}/token`, { method: 'POST', body: wrong }));
  }
  const exchangedText = await (await form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: TEST_PKCE_VERIFIER })).text();
  const tokens = JSON.parse(exchangedText) as { access_token: string; refresh_token?: string; token_type: string; scope: string; expires_in: number };
  if (typeof tokens.access_token !== 'string') throw new Error(`token: ${maskTokens(exchangedText)}`);
  out.tokens = { type: tokens.token_type, scope: tokens.scope, expiresIn: tokens.expires_in };
  out.access = await bearer(provider, tokens.access_token);
  out.codeAgain = await answer(await form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: TEST_PKCE_VERIFIER }));
  out.unknownRefresh = await answer(await form({ grant_type: 'refresh_token', refresh_token: 'gbrain_rt_never-issued' }));
  // Not vacuous: the exchange issued an access token the bearer check accepts, and the repeated code was refused.
  if ('refused' in (out.access as object) || (out.codeAgain as { status: number }).status !== 400) throw new Error(`code flow: ${JSON.stringify(out)}`);
  // The refresh part is checked for its own backend, never compared. The Rust store keeps no refresh families (#9364), so it
  // fails closed: its token endpoint issues no refresh token (RUST_ENGINE.md row OA-1), and an app signs in again when its
  // access token expires. PGLite and Postgres issue one, rotate it, and give a replay inside the grace window the pair that
  // replaced it.
  if (backend === 'rust') {
    // The key is absent, not null or empty; the other keys are the SQL engines' (out.tokens is compared across arms).
    const keys = Object.keys(tokens).sort().join(',');
    if (keys !== 'access_token,expires_in,scope,token_type') throw new Error(`rust token answer keys: ${keys}`);
    return out;
  }
  tokenBytes(`${backend}/${clientId}/authorization_code`, exchangedText);
  if (!/^gbrain_rt_/.test(tokens.refresh_token ?? '')) throw new Error(`no refresh token: ${JSON.stringify(out)}`);
  const refreshedRes = await form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token! });
  const refreshedText = await refreshedRes.text();
  if (refreshedRes.status !== 200) throw new Error(`refresh: ${refreshedRes.status} ${maskTokens(refreshedText)}`);
  tokenBytes(`${backend}/${clientId}/refresh_token`, refreshedText);
  const rotated = JSON.parse(refreshedText) as { access_token: string; refresh_token: string; scope: string };
  const rotatedAccess = await bearer(provider, rotated.access_token);
  const oldAccessAfterRefresh = await bearer(provider, tokens.access_token);
  const replayed = await answer(await form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token! }));
  const replayBody = replayed.body as { access_token?: string; refresh_token?: string } | undefined;
  // The rotated pair carries the client's current grant, which the bearer check reads for the old and the new access token.
  if (rotated.refresh_token === tokens.refresh_token || rotatedAccess.clientId !== clientId
    || rotated.scope !== (rotatedAccess.scopes as string[] | undefined)?.join(' ') || JSON.stringify(oldAccessAfterRefresh) !== JSON.stringify(rotatedAccess)
    || replayed.status !== 200 || replayBody?.access_token !== rotated.access_token || replayBody?.refresh_token !== rotated.refresh_token) {
    throw new Error(`refresh flow: ${JSON.stringify({ rotated: { scope: rotated.scope }, rotatedAccess, oldAccessAfterRefresh, replayed: replayed.status })}`);
  }
  return out;
}

describe('engine parity: OAuth over HTTP', () => {
  parityTest('the authorization code flow and a refresh over HTTP: /authorize, owner approval, /token, a rotated refresh, and each repeat refused',
    { methods: ['insertOauthClient', 'readOauthClient', 'readOauthClientForUpdate', 'insertOauthCode',
      'readOauthCodeForUpdate', 'deleteOauthCode', 'issueOauthTokens', 'readOauthAccessTokenRows',
      'insertSource', 'listAllSources', 'oauthClientHoldsAuthorization', 'persistOauthClientGrant', 'transaction'], timeout: 120_000 }, async (engine, backend) => {
      await engine.insertSource({ id: 'wikia', name: 'Wiki A', local_path: null, config: {} });
      await engine.insertSource({ id: 'wiki-b', name: 'Wiki B', local_path: null, config: {} });
      const client = (id: string, extra: Record<string, unknown> = {}) => engine.insertOauthClient({ client_id: id, client_name: `Client ${id}`, scope: 'read write',
        grant_types: ['authorization_code', 'refresh_token'], redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', source_id: 'default', federated_read: ['default'],
        client_id_issued_at: 1_700_000_000, ...extra });
      await client('oc-public');
      await client('oc-confidential', { client_secret_hash: hashToken(SECRET), token_endpoint_auth_method: 'client_secret_post' });
      // A self-registered client at revision 0: the owner picks its source on first consent (begin lists the sources).
      await client('oc-dcr', { registered_via: 'dcr', grant_revision: 0 });
      const provider = providerFor(engine);
      const http = await serve(provider);
      try {
        const out = { public: await codeFlow(http.base, provider, 'oc-public', backend), confidential: await codeFlow(http.base, provider, 'oc-confidential', backend, SECRET),
          dcr: await codeFlow(http.base, provider, 'oc-dcr', backend) };
        const dcr = await engine.readOauthClient('oc-dcr');
        return { ...out, dcrAfterConsent: { revision: dcr?.grant_revision, sourceId: dcr?.source_id } };
      } finally {
        await http.close();
      }
    });

  parityTest('a refresh token already in the store: PGLite and Postgres rotate it; Rust refuses it with invalid_grant and issues nothing',
    { methods: ['insertOauthClient', 'insertOauthToken', 'readOauthClientForUpdate', 'readOauthRefreshTokenForUpdate', 'deleteOauthRefreshToken',
      'countOauthAccessTokens', 'transaction'], timeout: 60_000 }, async (engine, backend) => {
      const now = Math.floor(Date.now() / 1000);
      const seeded = 'gbrain_rt_seeded-before-the-rule';
      await engine.insertOauthClient({ client_id: 'oc-seeded', client_name: 'Client oc-seeded', scope: 'read', grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', source_id: 'default', federated_read: ['default'], client_id_issued_at: 1_700_000_000 });
      // Straight into the store, as a refresh token issued before the rule (the swap gate should mean none exists on Rust).
      await engine.insertOauthToken({ token_hash: hashToken(seeded), token_type: 'refresh', client_id: 'oc-seeded', scopes: ['read'], expires_at: now + 3600, resource: null, created_at: now });
      const stored = () => engine.transaction(tx => tx.readOauthRefreshTokenForUpdate(hashToken(seeded), 'oc-seeded')).then(row => row !== null);
      const provider = providerFor(engine);
      const http = await serve(provider);
      try {
        const accessBefore = await engine.countOauthAccessTokens(0, null);
        const res = await fetch(`${http.base}/token`, { method: 'POST', body: new URLSearchParams({ client_id: 'oc-seeded', grant_type: 'refresh_token', refresh_token: seeded }) });
        const body = JSON.parse(await res.text()) as Record<string, unknown>;
        const seen = { status: res.status, error: body.error, issued: 'access_token' in body || 'refresh_token' in body,
          newAccess: await engine.countOauthAccessTokens(0, null) - accessBefore, seededKept: await stored() };
        // Checked for each backend, never compared: the rule differs by design (RUST_ENGINE.md row OA-1).
        const want = backend === 'rust'
          ? { status: 400, error: 'invalid_grant', issued: false, newAccess: 0, seededKept: true }
          : { status: 200, error: undefined, issued: true, newAccess: 1, seededKept: false };
        if (JSON.stringify(seen) !== JSON.stringify(want)) throw new Error(`seeded refresh (${backend}): ${JSON.stringify(seen)}`);
        // A refused refresh token stays deletable by the owner (a revoke or a sweep), the same on every arm.
        await engine.transaction(tx => tx.deleteOauthRefreshToken(hashToken(seeded), 'oc-seeded'));
        return { afterDelete: await stored() };
      } finally {
        await http.close();
      }
    });

  parityTest('revoking a client keeps its row with deleted_at, deletes its codes and tokens, leaves another client alone, and a second revoke is a no-op',
    { methods: ['insertOauthClient', 'insertOauthCode', 'insertOauthToken', 'readOauthClient', 'readOauthClientForUpdate', 'softDeleteOauthClient',
      'deleteOauthClientCodes', 'deleteOauthClientTokens', 'readOauthCodeChallenge', 'readOauthAccessTokenRows', 'transaction'] }, async (engine, backend) => {
      const now = Math.floor(Date.now() / 1000);
      const seed = async (id: string) => {
        await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read', client_id_issued_at: 1_700_000_000 });
        await engine.insertOauthCode({ code_hash: hashToken(`${id}-code`), client_id: id, scopes: ['read'], code_challenge: TEST_PKCE_CHALLENGE,
          code_challenge_method: 'S256', redirect_uri: REDIRECT, state: null, resource: null, expires_at: now + 600 });
        await engine.insertOauthToken({ token_hash: hashToken(`${id}-access`), token_type: 'access', client_id: id, scopes: ['read'], expires_at: now + 600, resource: null, created_at: now });
        await engine.insertOauthToken({ token_hash: hashToken(`${id}-refresh`), token_type: 'refresh', client_id: id, scopes: ['read'], expires_at: now + 600, resource: null, created_at: now });
      };
      const state = async (id: string) => {
        const row = await engine.readOauthClient(id);
        return {
          row: row ? { client_id: row.client_id, deleted: row.deleted_at instanceof Date } : null,
          code: await engine.readOauthCodeChallenge(hashToken(`${id}-code`), id, now) !== null,
          access: (await engine.readOauthAccessTokenRows(hashToken(`${id}-access`), 0)).length,
        };
      };
      const grants = (sqlOnly: boolean) => new OAuthGrants({ sql: sqlQueryForEngine(engine), engine,
        transaction: fn => engine.transaction(tx => sqlOnly ? fn(sqlQueryForEngine(tx)) : fn(sqlQueryForEngine(tx), tx)), tokenTtl: 3600, refreshTtl: 86400 });
      await seed('oc-revoke');
      await seed('oc-other');
      await grants(false).revokeClient('oc-revoke');
      const first = await state('oc-revoke');
      await grants(false).revokeClient('oc-revoke');
      const out = { first, second: await state('oc-revoke'), other: await state('oc-other'), unknown: await grants(false).revokeClient('nobody') ?? null };
      if (backend !== 'rust') {
        // The raw-SQL path of the same call (no engine transaction) must leave what the engine path left.
        await seed('oc-raw');
        await grants(true).revokeClient('oc-raw');
        const raw = await state('oc-raw');
        if (JSON.stringify({ ...raw, row: { ...raw.row, client_id: 'oc-revoke' } }) !== JSON.stringify(first)) throw new Error(`raw path differs: ${JSON.stringify({ raw, first })}`);
      }
      // Not vacuous: the revoked client keeps a soft-deleted row and loses its code and token; the other keeps all three.
      if (!first.row?.deleted || first.code || first.access !== 0 || out.other.row?.deleted || !out.other.code || out.other.access !== 1) throw new Error(`revoke: ${JSON.stringify(out)}`);
      return out;
    });
});
