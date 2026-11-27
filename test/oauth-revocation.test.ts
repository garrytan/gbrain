/**
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `revokeClient` on a provider whose transaction hands out the engine handle (as `serve --http` builds it)
 *    soft-deletes the client and deletes its authorization codes and tokens; a code of another client stays. The same
 *    revoke on a bare `SqlQuery` transaction (the CLI, mcp-provision) leaves the same tables.
 *  - Regression: an engine route that forgets the codes table, so a revoked client's pending code still exchanges for
 *    tokens. The parity file (test/engine-parity/oauth-revocation.test.ts) cannot see this: the Rust store keeps no
 *    codes yet and no typed insert of one exists to make a code on every arm.
 *  - Why existing coverage misses it: test/oauth.test.ts revokes through the bare `SqlQuery` route only.
 *  - Seam: none. A real PGLite engine; the code rows are written and read with `executeRaw`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const engineProvider = () => new GBrainOAuthProvider({
  sql: sqlQueryForEngine(engine), engine, tokenTtl: 60, refreshTtl: 300,
  transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx), tx)),
});
const bareProvider = () => new GBrainOAuthProvider({
  sql: sqlQueryForEngine(engine), tokenTtl: 60, refreshTtl: 300,
  transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
});

async function seed(id: string): Promise<void> {
  await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read' });
  await engine.executeRaw(
    `INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge, code_challenge_method, redirect_uri, expires_at)
     VALUES ($1, $2, ARRAY['read'], 'challenge', 'S256', 'https://client.example/cb', 4000000000)`, [`code-${id}`, id]);
  await engine.insertOauthToken({ token_hash: `tok-${id}`, token_type: 'access', client_id: id, scopes: ['read'], expires_at: 4_000_000_000, resource: null, created_at: 1_800_000_000 });
}
const counts = async (id: string) => ({
  codes: (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM oauth_codes WHERE client_id = $1', [id]))[0].n,
  tokens: (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM oauth_tokens WHERE client_id = $1', [id]))[0].n,
  live: await engine.oauthClientLive(id),
});

describe('revokeClient', () => {
  for (const [name, make] of [['through the engine handle', engineProvider], ['through a bare SqlQuery', bareProvider]] as const) {
    test(`soft-deletes the client and deletes its codes and tokens, ${name}`, async () => {
      const id = name.includes('engine') ? 'rev-engine' : 'rev-bare';
      await seed(id);
      await seed(`${id}-other`);
      await make().revokeClient(id);
      expect(await counts(id)).toEqual({ codes: 0, tokens: 0, live: false });
      expect(await counts(`${id}-other`)).toEqual({ codes: 1, tokens: 1, live: true });
    });
  }
});
