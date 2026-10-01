/**
 * Request-outcome gates for the serve-http module split (refactor wave 1,
 * TE1 / T-6 / S-1): the production app from `buildServeHttpApp` on an
 * in-memory PGLite brain, driven over real HTTP.
 *
 * Protects: state the split moved into one shared ServeHttpContext and the
 * auth decisions the moved routes make: a rate limiter shared across two
 * modules, owner cookie vs OAuth admin bearer at /admin/api/*, session
 * revocation, the PKCE authorization-code and refresh-token flows through
 * owner consent, resource-audience rejection at /mcp, the /mcp dispatch
 * context (remote, auth, source scope, surface) and the OAuth CORS gate
 * ordered ahead of the SDK router's own `*` CORS.
 * Fails when: a module builds its own limiter or session map, an OAuth token
 * can administer, sign-out leaves a session alive, a flow step breaks, a
 * foreign-audience token reaches dispatch, dispatch loses remote/auth/source
 * or surface, or a denied preflight reaches the SDK's permissive CORS.
 * Why new: the route goldens pin registration order and middleware identity,
 * not the outcome of requests through the real stack.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { VERB_NAMES } from '../src/core/verbs.ts';
import { TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from './helpers/oauth.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

interface RunningApp {
  base: string;
  bootstrap: string;
  close: () => Promise<void>;
}

const running: RunningApp[] = [];

afterAll(async () => {
  for (const app of running) await app.close();
});

async function startApp(opts: { enableDcr?: boolean; surface?: 'verbs' | 'starter' | 'full' } = {}): Promise<RunningApp> {
  const app = express();
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  const built = await buildServeHttpApp(app, engine, {
    port: address.port, tokenTtl: 3600, enableDcr: opts.enableDcr ?? false, publicUrl: base, surface: opts.surface,
  });
  const handle: RunningApp = {
    base,
    bootstrap: built.bootstrapToken,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
  running.push(handle);
  return handle;
}

async function ownerCookie(app: RunningApp): Promise<string> {
  const login = await fetch(`${app.base}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.bootstrap }),
  });
  expect(login.status).toBe(200);
  return login.headers.get('set-cookie')!.split(';')[0];
}

let clientSeq = 0;
async function registerClient(app: RunningApp, cookie: string, body: Record<string, unknown>): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetch(`${app.base}/admin/api/register-client`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `outcome-client-${++clientSeq}`, ...body }),
  });
  expect(res.status).toBe(200);
  return await res.json() as { clientId: string; clientSecret?: string };
}

async function clientCredentialsToken(app: RunningApp, clientId: string, secret: string, scope: string): Promise<string> {
  const res = await fetch(`${app.base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope }),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { access_token: string }).access_token;
}

function mcpPost(app: RunningApp, token: string, method: string, params?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
}

async function mcpResult(app: RunningApp, token: string, method: string, params?: unknown): Promise<any> {
  const res = await mcpPost(app, token, method, params);
  expect(res.status).toBe(200);
  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  const rpc = JSON.parse(dataLine ? dataLine.slice('data:'.length) : text);
  expect(rpc.error).toBeUndefined();
  return rpc.result;
}

function toolPayload(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('shared context: one limiter spans two modules (T-6)', () => {
  test('failed owner logins in serve-http-admin-api.ts exhaust the magic-link route in serve-http-oauth.ts', async () => {
    const app = await startApp();
    const redeem = () => fetch(`${app.base}/admin/auth/not-a-real-nonce`, { redirect: 'manual' });
    expect((await redeem()).status).toBe(401);
    for (let i = 0; i < 9; i++) {
      const res = await fetch(`${app.base}/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong-owner-credential' }),
      });
      expect(res.status).toBe(401);
    }
    // One redemption attempt plus nine failed logins = the 10-failure allowance.
    // The magic-link route saw a single request, so its 429 is the login
    // module's failures spending the SAME adminLimits.failures store.
    expect((await redeem()).status).toBe(429);
    const mint = await fetch(`${app.base}/admin/api/issue-magic-link`, { method: 'POST', headers: { Authorization: 'Bearer wrong-owner-credential' } });
    expect(mint.status).toBe(429);
  });
});

describe('owner administration vs OAuth admin tokens', () => {
  test('the owner cookie can use /admin/api/*; an OAuth admin-scoped bearer token cannot', async () => {
    const app = await startApp();
    const cookie = await ownerCookie(app);
    expect((await fetch(`${app.base}/admin/api/stats`, { headers: { Cookie: cookie } })).status).toBe(200);

    const { clientId, clientSecret } = await registerClient(app, cookie, { scopes: 'read write admin', grantTypes: ['client_credentials'] });
    const token = await clientCredentialsToken(app, clientId, clientSecret!, 'read write admin');
    const bearer = await fetch(`${app.base}/admin/api/stats`, { headers: { Authorization: `Bearer ${token}` } });
    expect(bearer.status).toBe(401);
    expect(await bearer.json()).toEqual({ error: 'Admin authentication required' });
    const asOwner = await fetch(`${app.base}/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    expect(asOwner.status).toBe(401);
    expect((await asOwner.json() as { error: string }).error).toContain('an OAuth token cannot administer it');
    expect((await fetch(`${app.base}/metrics`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await fetch(`${app.base}/metrics`, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  test('sign-out-everywhere revokes every owner session, including the caller', async () => {
    const app = await startApp();
    const first = await ownerCookie(app);
    const second = await ownerCookie(app);
    const signOut = await fetch(`${app.base}/admin/api/sign-out-everywhere`, { method: 'POST', headers: { Cookie: first } });
    expect(signOut.status).toBe(200);
    expect(await signOut.json()).toEqual({ revoked_sessions: 2 });
    for (const cookie of [first, second]) {
      expect((await fetch(`${app.base}/admin/api/stats`, { headers: { Cookie: cookie } })).status).toBe(401);
    }
    expect((await fetch(`${app.base}/admin/api/stats`, { headers: { Cookie: await ownerCookie(app) } })).status).toBe(200);
  });
});

describe('OAuth flows through the split modules', () => {
  test('PKCE authorization code via owner consent, then a rotating refresh token', async () => {
    const app = await startApp();
    const cookie = await ownerCookie(app);
    const redirectUri = `${app.base}/callback`;
    const { clientId } = await registerClient(app, cookie, {
      scopes: 'read', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none',
    });
    const authorize = await fetch(`${app.base}/authorize?${new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri, code_challenge: TEST_PKCE_CHALLENGE,
      code_challenge_method: 'S256', scope: 'read', state: 'outcome-state',
    })}`, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const pending = new URL(authorize.headers.get('location')!, app.base);
    expect(pending.pathname).toBe('/admin/');
    const id = pending.searchParams.get('oauth_request')!;
    const consentUrl = `${app.base}/admin/api/oauth-requests/${id}`;
    expect((await fetch(consentUrl)).status).toBe(401);
    const details = await (await fetch(consentUrl, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const approved = await fetch(consentUrl, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', csrf: details.csrf }),
    });
    expect(approved.status).toBe(200);
    const callback = new URL((await approved.json() as { redirectUrl: string }).redirectUrl);
    expect(callback.searchParams.get('state')).toBe('outcome-state');
    const code = callback.searchParams.get('code')!;

    const token = (body: Record<string, string>) => fetch(`${app.base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
    });
    const wrongVerifier = await token({ grant_type: 'authorization_code', code, code_verifier: `${TEST_PKCE_VERIFIER}-wrong`, client_id: clientId, redirect_uri: redirectUri });
    expect(wrongVerifier.status).toBe(400);
    const exchanged = await token({ grant_type: 'authorization_code', code, code_verifier: TEST_PKCE_VERIFIER, client_id: clientId, redirect_uri: redirectUri });
    expect(exchanged.status).toBe(200);
    const first = await exchanged.json() as { access_token: string; refresh_token: string };
    expect(first.refresh_token).toBeTruthy();
    expect((await mcpResult(app, first.access_token, 'tools/list')).tools.length).toBeGreaterThan(0);

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
    const second = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(second.access_token).not.toBe(first.access_token);
    expect((await mcpResult(app, second.access_token, 'tools/list')).tools.length).toBeGreaterThan(0);
    const reused = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(reused.status).toBe(400);
  });

  test('/mcp rejects a token bound to a different resource before dispatch', async () => {
    const app = await startApp();
    const cookie = await ownerCookie(app);
    const { clientId, clientSecret } = await registerClient(app, cookie, { scopes: 'read', grantTypes: ['client_credentials'] });
    const token = await clientCredentialsToken(app, clientId, clientSecret!, 'read');
    expect((await mcpPost(app, token, 'tools/list')).status).toBe(200);
    await engine.executeRaw(`UPDATE oauth_tokens SET resource = $1 WHERE token_hash = $2`, [
      'https://different-resource.example/mcp', createHash('sha256').update(token).digest('hex'),
    ]);
    const res = await mcpPost(app, token, 'tools/list');
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('invalid_token');
  });
});

describe('/mcp dispatch context', () => {
  test('tools/call runs remote with the caller auth and source scope', async () => {
    const app = await startApp();
    const cookie = await ownerCookie(app);
    const { clientId, clientSecret } = await registerClient(app, cookie, { scopes: 'read write admin', grantTypes: ['client_credentials'] });
    const token = await clientCredentialsToken(app, clientId, clientSecret!, 'read write admin');
    const who = toolPayload(await mcpResult(app, token, 'tools/call', { name: 'whoami', arguments: {} }));
    expect(who.transport).toBe('oauth');
    expect(who.client_id).toBe(clientId);
    expect(who.source_id).toBe('default');
    expect(who.scopes).toEqual(expect.arrayContaining(['read', 'write', 'admin']));
    // submit_job routes any caller whose ctx.remote is not strictly false
    // through remote-submission authority; an admin-scoped token asking for a
    // shell job is refused there, so dispatch ran with remote: true.
    const shell = await mcpResult(app, token, 'tools/call', { name: 'submit_job', arguments: { name: 'shell', data: { cmd: 'true' } } });
    expect(shell.isError).toBe(true);
    expect(shell.content[0].text).toContain('permission_denied');
    expect(shell.content[0].text).toContain('through remote submit_job');
  });

  test('a verbs surface ceiling narrows both the list and dispatch', async () => {
    const app = await startApp({ surface: 'verbs' });
    const cookie = await ownerCookie(app);
    const { clientId, clientSecret } = await registerClient(app, cookie, { scopes: 'read write', grantTypes: ['client_credentials'] });
    const token = await clientCredentialsToken(app, clientId, clientSecret!, 'read write');
    const listed = (await mcpResult(app, token, 'tools/list')).tools.map((t: { name: string }) => t.name).sort();
    expect(listed).toEqual([...VERB_NAMES].sort());
    const hidden = await mcpResult(app, token, 'tools/call', { name: 'list_pages', arguments: {} });
    expect(hidden.isError).toBe(true);
    expect(toolPayload(hidden).error).toBe('unknown_operation');
  });
});

describe('OAuth CORS gate runs before the SDK router', () => {
  const origin = 'https://browser-app.example';
  const preflight = (app: RunningApp, path: string) => fetch(`${app.base}${path}`, {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });

  test('default deny: preflights on /token, /register, /revoke and /mcp carry no Allow-Origin', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: undefined }, async () => {
      const app = await startApp({ enableDcr: true });
      for (const path of ['/token', '/register', '/revoke', '/mcp']) {
        const res = await preflight(app, path);
        expect(res.headers.get('access-control-allow-origin'), `${path} must not fall through to a permissive CORS`).toBeNull();
      }
    });
  });

  test('allowlisted origin: the preflight reflects it and an authenticated /mcp call carries it', async () => {
    await withEnv({ GBRAIN_HTTP_CORS_ORIGIN: origin }, async () => {
      const app = await startApp({ enableDcr: true });
      for (const path of ['/token', '/register', '/revoke', '/mcp']) {
        expect((await preflight(app, path)).headers.get('access-control-allow-origin')).toBe(origin);
      }
      const cookie = await ownerCookie(app);
      const { clientId, clientSecret } = await registerClient(app, cookie, { scopes: 'read', grantTypes: ['client_credentials'] });
      const token = await clientCredentialsToken(app, clientId, clientSecret!, 'read');
      const call = await mcpPost(app, token, 'tools/list', undefined, { Origin: origin });
      expect(call.status).toBe(200);
      expect(call.headers.get('access-control-allow-origin')).toBe(origin);
      await call.text();
      const denied = await mcpPost(app, token, 'tools/list', undefined, { Origin: 'https://other-app.example' });
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
      await denied.text();
    });
  });
});
