/** #9364: real /token disconnects must not consume a refresh before commit.
 * Both HTTP routes and real transactional storage; no process-wide mocks.
 * Existing rotation tests do not close a socket while storage is stalled.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express, { type Request, type Response } from 'express';
import { request, type Server } from 'node:http';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { mountOAuth } from '../src/commands/serve-http-oauth.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine, type SqlQuery } from '../src/core/sql-query.ts';
import { hashToken } from '../src/core/utils.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { authorizeAsOwner, TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from './helpers/oauth.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

for (const backend of testBackends()) describe(`[${backend}] OAuth refresh disconnect #9364`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'pglite') {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    } else {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine;
      closePostgres = pg.close;
    }
  }, 120_000);
  afterAll(async () => {
    await engine?.disconnect();
    await closePostgres?.();
  }, 60_000);

  for (const auth of ['none', 'client_secret_post', 'client_secret_basic'] as const) {
    for (const stage of ['before_transaction', 'after_inserts'] as const) {
      test(`${auth}: disconnect ${stage} rolls back, then the original token rotates once`, async () => {
        const entered = deferred(), release = deferred(), settled = deferred(), closed = deferred();
        let stalled = false;
        let gateUsed = false;
        let completed = false;
        const gate = async () => {
          if (!stalled || gateUsed) return;
          gateUsed = true;
          entered.resolve();
          await release.promise;
        };
        const provider = new GBrainOAuthProvider({
          sql: sqlQueryForEngine(engine),
          transaction: async fn => {
            const observed = stalled && !gateUsed;
            try {
              if (stage === 'before_transaction') await gate();
              return await engine.transaction(async tx => {
                const original = sqlQueryForEngine(tx);
                const sql: SqlQuery = async (strings, ...values) => {
                  const result = await original(strings, ...values);
                  if (stage === 'after_inserts' && strings.join('').includes('INSERT INTO oauth_tokens') && values[1] === 'refresh') await gate();
                  return result;
                };
                return fn(sql);
              });
            } finally {
              if (observed) settled.resolve();
            }
          },
        });
        const callback = 'http://127.0.0.1:8989/oauth/callback';
        const registration = await provider.registerClientManual('Synthetic disconnect fixture',
          ['authorization_code', 'refresh_token'], 'read', [callback], 'default', undefined, auth);
        const client = auth === 'none' ? (await provider.clientsStore.getClient(registration.clientId))!
          : await provider.verifyConfidentialClientSecret(registration.clientId, registration.clientSecret!);
        let redirect = '';
        await authorizeAsOwner(provider, client, { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: callback, scopes: ['read'] },
          { redirect: (url: string) => { redirect = url; } } as Response);
        const initial = await provider.exchangeAuthorizationCode(client, new URL(redirect).searchParams.get('code')!, TEST_PKCE_VERIFIER, callback);
        // A second valid pair lets an overlapping HTTP request prove cancellation does not escape its async context.
        await authorizeAsOwner(provider, client, { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: callback, scopes: ['read'] },
          { redirect: (url: string) => { redirect = url; } } as Response);
        const sibling = await provider.exchangeAuthorizationCode(client, new URL(redirect).searchParams.get('code')!, TEST_PKCE_VERIFIER, callback);
        const before = await engine.executeRaw('SELECT * FROM oauth_tokens WHERE client_id=$1 ORDER BY token_hash', [client.client_id]);
        const app = express();
        const requests: Array<{ req: Request; res: Response }> = [];
        app.use('/token', (req, res, next) => {
          requests.push({ req, res });
          res.once('close', () => { if (!res.writableFinished) closed.resolve(); });
          next();
        });
        mountOAuth(app, {
          bind: '127.0.0.1', enableDcr: false, oauthProvider: provider,
          ccRateLimiter: (_req, _res, next) => next(),
          issuerUrl: new URL('http://127.0.0.1:8989'),
          mcpResourceUrl: new URL('http://127.0.0.1:8989/mcp'),
          resourceMetadataUrl: 'http://127.0.0.1:8989/.well-known/oauth-protected-resource/mcp',
        } satisfies Partial<ServeHttpContext> as unknown as ServeHttpContext);
        let server: Server | undefined;
        try {
          server = app.listen(0, '127.0.0.1');
          await new Promise<void>(resolve => server!.once('listening', resolve));
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Expected local fixture port');
          const url = `http://127.0.0.1:${address.port}/token`;
          const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: initial.refresh_token! });
          const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
          if (auth === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${client.client_id}:${registration.clientSecret}`).toString('base64')}`;
          else {
            form.set('client_id', client.client_id);
            if (auth === 'client_secret_post') form.set('client_secret', registration.clientSecret!);
          }
          stalled = true;
          const first = request(url, { method: 'POST', headers });
          first.on('error', () => {}); // deliberately destroy this synthetic caller
          first.end(form.toString());
          await entered.promise;
          first.destroy();
          await closed.promise; // server has observed the disconnect, not just the client
          if (stage === 'before_transaction') {
            // No transaction is held yet: this healthy request must finish while the abandoned one remains stalled.
            const siblingForm = new URLSearchParams(form);
            siblingForm.set('refresh_token', sibling.refresh_token!);
            const healthy = await fetch(url, { method: 'POST', headers, body: siblingForm });
            expect(healthy.status).toBe(200);
            expect((await healthy.json() as { refresh_token: string }).refresh_token).not.toBe(sibling.refresh_token);
          }
          release.resolve();
          await settled.promise;
          stalled = false;
          const after = await engine.executeRaw('SELECT * FROM oauth_tokens WHERE client_id=$1 ORDER BY token_hash', [client.client_id]);
          if (stage === 'after_inserts') expect(after).toEqual(before); // no orphan replacement access/refresh tokens
          else expect(after).toHaveLength(before.length + 1); // only the healthy sibling rotated
          expect(after.some(row => row.token_hash === hashToken(initial.refresh_token!))).toBe(true);
          const retry = await fetch(url, { method: 'POST', headers, body: form });
          expect(retry.status).toBe(200);
          const tokens = await retry.json() as { access_token: string; refresh_token: string };
          expect(tokens.access_token).toBeTruthy();
          expect(tokens.refresh_token).not.toBe(initial.refresh_token);
          const replay = await fetch(url, { method: 'POST', headers, body: form });
          expect(replay.status).toBe(400);
          expect((await replay.json() as { error: string }).error).toBe('invalid_grant');
          for (const { req, res } of requests) {
            expect(req.listenerCount('aborted')).toBe(0);
            expect(res.listenerCount('close')).toBe(0);
          }
          completed = true;
        } finally {
          release.resolve();
          if (gateUsed) await settled.promise;
          server?.closeAllConnections();
          if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
        }
        expect(completed).toBe(true);
      }, 60_000);
    }
  }
});
