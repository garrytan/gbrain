/** Real Postgres row-lock order and rollback; synthetic clients only. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { sqlQueryForEngine, type SqlQuery } from '../../src/core/sql-query.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { hashToken } from '../../src/core/utils.ts';
import { TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from '../helpers/oauth.ts';

const suite = hasDatabase() ? describe : describe.skip;
suite('OAuth grant transactions on Postgres', () => {
  let engine: BrainEngine;
  let sql: SqlQuery;
  let provider: GBrainOAuthProvider;
  const clients: string[] = [];
  beforeAll(async () => {
    engine = await setupDB();
    sql = sqlQueryForEngine(engine);
    provider = makeProvider();
  }, 60_000);
  afterAll(async () => {
    if (sql) for (const id of clients) await sql`DELETE FROM oauth_clients WHERE client_id = ${id}`;
    await teardownDB();
  });
  function makeProvider(intercept?: (query: string, run: () => Promise<Record<string, unknown>[]>) => Promise<Record<string, unknown>[]>): GBrainOAuthProvider {
    return new GBrainOAuthProvider({ sql, transaction: fn => engine.transaction(tx => {
      const txSql = sqlQueryForEngine(tx);
      return fn(intercept ? (strings, ...values) => intercept(strings.join('?'), () => txSql(strings, ...values)) : txSql);
    }) });
  }
  async function register() {
    const result = await provider.registerClientManual('synthetic transaction client', ['client_credentials', 'authorization_code', 'refresh_token'], 'read', ['https://client.example/callback']);
    clients.push(result.clientId);
    return result;
  }
  function latch() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }
  for (const first of ['issuance', 'revocation'] as const) {
    test(`${first} obtains the client row first; revocation leaves no usable token`, async () => {
      const client = await register();
      const locked = latch();
      const release = latch();
      const attempted = latch();
      const firstProvider = makeProvider(async (query, run) => {
        const result = await run();
        if (query.includes('SELECT * FROM oauth_clients') && query.includes('FOR UPDATE')) {
          locked.release();
          await release.promise;
        }
        return result;
      });
      const secondProvider = makeProvider(async (query, run) => {
        if (query.includes('SELECT * FROM oauth_clients') && query.includes('FOR UPDATE')) attempted.release();
        return run();
      });
      const issue = (p: GBrainOAuthProvider) => p.exchangeClientCredentials(client.clientId, client.clientSecret!, 'read');
      const firstResult = first === 'issuance' ? issue(firstProvider) : firstProvider.revokeClient(client.clientId);
      await locked.promise;
      const secondResult = first === 'issuance' ? secondProvider.revokeClient(client.clientId) : issue(secondProvider);
      // Attach rejection handling before releasing the first transaction.
      const outcomes = Promise.allSettled([firstResult, secondResult]);
      await attempted.promise;
      release.release();
      const results = await outcomes;
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe(first === 'issuance' ? 'fulfilled' : 'rejected');
      expect(await sql`SELECT * FROM oauth_tokens WHERE client_id = ${client.clientId}`).toHaveLength(0);
      expect(await provider.clientsStore.getClient(client.clientId)).toBeUndefined();
    }, 15_000);
  }

  test('code and refresh consumption roll back when the second token insert fails', async () => {
    const registered = await register();
    const client = (await provider.clientsStore.getClient(registered.clientId))!;
    const request = await provider.grants.begin(client.client_id, { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: client.redirect_uris![0], resource: new URL('https://brain.example/mcp') });
    const redirect = await provider.grants.decide(request, true);
    const code = new URL(redirect).searchParams.get('code')!;
    let inserts = 0;
    const failing = makeProvider(async (query, run) => {
      const rows = await run();
      if (query.includes('INSERT INTO oauth_tokens') && ++inserts % 2 === 0) {
        throw new Error('synthetic failure after both token inserts');
      }
      return rows;
    });
    await expect(failing.exchangeAuthorizationCode(client, code, TEST_PKCE_VERIFIER, client.redirect_uris![0])).rejects.toThrow('synthetic failure');
    expect(await sql`SELECT * FROM oauth_codes WHERE code_hash = ${hashToken(code)}`).toHaveLength(1);
    expect(await sql`SELECT * FROM oauth_tokens WHERE client_id = ${client.client_id}`).toHaveLength(0);
    const tokens = await provider.exchangeAuthorizationCode(client, code, TEST_PKCE_VERIFIER, client.redirect_uris![0]);
    await expect(failing.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow('synthetic failure');
    expect(await sql`SELECT * FROM oauth_tokens WHERE token_hash = ${hashToken(tokens.refresh_token!)}`).toHaveLength(1);
    const outcomes = await Promise.allSettled([provider.exchangeRefreshToken(client, tokens.refresh_token!), provider.exchangeRefreshToken(client, tokens.refresh_token!)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const succeeded = outcomes.find(result => result.status === 'fulfilled');
    if (succeeded?.status !== 'fulfilled') throw new Error('Expected successful rotation');
    expect((await provider.verifyAccessToken(succeeded.value.access_token)).resource?.toString()).toBe('https://brain.example/mcp');
  });
});
