/**
 * `gbrain auth rescope <name>` on a brain whose schema is older than v282 (no `access_tokens.member_id`).
 * 1. Protects: resolveRescopeTarget (src/core/grants/legacy-token.ts) names a token, a client and a name nobody has on
 *    a brain that has not run v282, as it did before v282 added the column. The name lookup reads only the token's id
 *    and name (the typed readAccessCredentials), never the member binding.
 * 2. Fails when: the lookup selects `member_id` (readLiveAccessToken does), so a client-only name fails 42703
 *    (undefined_column) on an older brain before it reaches the client branch.
 * 3. Real seam: PGLite and Postgres engines, the column dropped after the rows are written; no mock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveRescopeTarget } from '../src/core/grants/legacy-token.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

type Outcome = { value: unknown } | { code: unknown; reasons: unknown; message: string };
const outcome = (engine: BrainEngine, name: string): Promise<Outcome> =>
  resolveRescopeTarget(engine, name).then(value => ({ value }), (e: { code?: unknown; reasons?: unknown; message: string }) => ({ code: e.code, reasons: e.reasons, message: e.message }));

for (const kind of testBackends()) {
  describe(`resolveRescopeTarget on a brain older than v282 (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO access_tokens (name, token_hash) VALUES ('only-token', 'hash-only-token'), ('both-names', 'hash-both-names')`);
      await engine.executeRaw(
        `INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, grant_types, scope)
         VALUES ('client-one', 'Only Client', 'h1', '{}', '{client_credentials}', 'read'), ('both-names', 'Both Names', 'h2', '{}', '{client_credentials}', 'read')`);
      // The brain before v282: the member binding column is not there.
      await engine.executeRaw('ALTER TABLE access_tokens DROP COLUMN member_id');
    });
    afterAll(async () => { await close(); });

    test('a column the brain lacks is really gone', async () => {
      const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'access_tokens' AND column_name = 'member_id'`);
      expect(rows[0]!.n).toBe(0);
    });

    test('a token name resolves to a token', async () => {
      expect(await outcome(engine, 'only-token')).toEqual({ value: { kind: 'token' } });
    });

    test('a client id and a client name resolve to the client', async () => {
      expect(await outcome(engine, 'client-one')).toEqual({ value: { kind: 'client', clientId: 'client-one' } });
      expect(await outcome(engine, 'Only Client')).toEqual({ value: { kind: 'client', clientId: 'client-one' } });
    });

    test('a name that matches a token and a client is refused as ambiguous', async () => {
      const got = await outcome(engine, 'both-names');
      expect(got).toEqual({ code: 'invalid_grant', reasons: ['rescope_target_ambiguous'],
        message: '"both-names" names both a legacy token and an OAuth client; pass --token both-names or --client both-names' });
    });

    test('a name nobody has is refused as not found', async () => {
      expect(await outcome(engine, 'nobody')).toEqual({ code: 'invalid_grant', reasons: [],
        message: 'No active token or OAuth client named "nobody" (see gbrain auth list and gbrain auth clients)' });
    });
  });
}
