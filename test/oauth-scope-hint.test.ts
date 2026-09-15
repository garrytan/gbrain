import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express, { type RequestHandler } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { withBearerScopeHint } from '../src/commands/serve-http-oauth.ts';

let server: ReturnType<ReturnType<typeof express>['listen']>;
let base: string;
const resourceMetadataUrl = 'https://example.test/.well-known/oauth-protected-resource/mcp';

beforeAll(async () => {
  const app = express();
  const verifier = {
    async verifyAccessToken(token: string) {
      if (token === 'invalid') throw new InvalidTokenError('Invalid token');
      if (token === 'unavailable') throw new Error('Storage unavailable');
      return { token, clientId: 'scope-hint-test', scopes: token === 'empty' ? [] : [token],
        expiresAt: Math.floor(Date.now() / 1000) + (token === 'expired' ? -60 : 60) };
    },
  };
  app.post('/mcp', withBearerScopeHint(requireBearerAuth({ verifier, resourceMetadataUrl }), ['read']), (req, res) => {
    res.json({ scopes: req.auth!.scopes });
  });
  app.post('/write', withBearerScopeHint(requireBearerAuth({ verifier, resourceMetadataUrl, requiredScopes: ['write'] }), ['read']), (_req, res) => {
    res.json({ ok: true });
  });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('withBearerScopeHint with SDK HTTP middleware', () => {
  test.each([undefined, 'Basic invalid', 'Bearer invalid', 'Bearer expired'])('hints read without weakening bearer validation: %s', async authorization => {
    const response = await fetch(`${base}/mcp`, { method: 'POST',
      headers: authorization ? { Authorization: authorization } : {} });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate')!;
    expect(challenge).toContain('scope="read"');
    expect(challenge).toContain(`resource_metadata="${resourceMetadataUrl}"`);
    expect(await response.json()).toMatchObject({ error: 'invalid_token' });
  });

  test.each(['read', 'write', 'agent', 'admin', 'sources_admin', 'users_admin', 'empty'])('does not enforce or enlarge a valid %s grant', async token => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(await response.json()).toEqual({ scopes: token === 'empty' ? [] : [token] });
  });

  test('preserves a real insufficient-scope challenge and enforcement', async () => {
    const response = await fetch(`${base}/write`, { method: 'POST', headers: { Authorization: 'Bearer read' } });
    expect(response.status).toBe(403);
    const challenge = response.headers.get('www-authenticate')!;
    expect(challenge.match(/scope=/g)).toHaveLength(1);
    expect(challenge).toContain('scope="write"');
    expect(await response.json()).toMatchObject({ error: 'insufficient_scope' });
  });

  test('does not turn verifier failures into authorization challenges', async () => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer unavailable' } });
    expect(response.status).toBe(500);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(await response.json()).toMatchObject({ error: 'server_error' });
  });
});

describe('withBearerScopeHint response adapter', () => {
  test('preserves object-form headers and restores the setter after success', async () => {
    const calls: unknown[][] = [];
    const response = { set(...args: unknown[]) { calls.push(args); return response; } };
    const originalSet = response.set;
    const middleware: RequestHandler = (_req, res) => { res.set({ 'Cache-Control': 'no-store' }); };
    await withBearerScopeHint(middleware, ['read'])({} as any, response as any, () => {});
    expect(calls).toEqual([[{ 'Cache-Control': 'no-store' }]]);
    expect(response.set).toBe(originalSet);
  });

  test('preserves other authentication schemes and restores the setter after failure', async () => {
    const calls: unknown[][] = [];
    const response = { set(...args: unknown[]) { calls.push(args); return response; } };
    const originalSet = response.set;
    const middleware: RequestHandler = (_req, res) => {
      res.set('WWW-Authenticate', 'Basic realm="gbrain"');
      throw new Error('synthetic failure');
    };
    await expect(withBearerScopeHint(middleware, ['read'])({} as any, response as any, () => {})).rejects.toThrow('synthetic failure');
    expect(calls).toEqual([['WWW-Authenticate', 'Basic realm="gbrain"']]);
    expect(response.set).toBe(originalSet);
  });
});
