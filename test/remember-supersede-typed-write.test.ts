/**
 * A remember with `replaces` ends the old fact through the typed `expireSupersededFact` member.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the publication's supersede write (expire the old fact, end it at the replacement's start, link it to
 *    the new fact) runs through `expireSupersededFact`, never caller raw SQL, and leaves the old fact expired, ended and
 *    pointing at the new one, on PGLite and Postgres.
 *  - Regression: memory-prepare.ts sent this write as a raw UPDATE, which a Rust brain refuses (raw_sql), so every
 *    remember with `replaces` stopped there on Rust.
 *  - Why existing coverage misses it: test/remember-replaces.test.ts checks the rows, not the path the write takes,
 *    and the Rust case in test/engine-parity/remember-supersede.test.ts counted the stop as an engine refusal.
 *  - Seam: an executeRaw hook on the engine, which the transaction engine inherits (Object.create), that refuses a
 *    supersede UPDATE sent from outside engine-sql, as a Rust brain refuses all caller raw SQL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

afterEach(() => resetGateway());

for (const kind of testBackends()) {
  describe(`remember replaces, typed supersede write (${kind})`, () => {
    let engine: BrainEngine;
    let pglite: PGLiteEngine | undefined;
    let closePg: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (kind === 'postgres') {
        const opened = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engine = opened.engine;
        closePg = opened.close;
      } else {
        pglite = new PGLiteEngine();
        await pglite.connect({ engine: 'pglite' } as never);
        await pglite.initSchema();
        engine = pglite;
      }
    });
    afterAll(async () => {
      resetGateway();
      await disposePersistenceConsumer(engine);
      await closePg?.();
      await pglite?.disconnect();
    });

    test('the publication ends the replaced fact through expireSupersededFact, not caller raw SQL', async () => {
      {
        configureGateway({ embedding_identity_unverified: true, env: { ...process.env } });
        const call = async (params: Record<string, unknown>) => {
          const res = await dispatchToolCall(engine, 'remember', { provenance: 'test', entity: 'people/alice-example', ...params }, { remote: false });
          return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, unknown> };
        };
        const old = await call({ fact: 'Alice Example drinks tea.' });
        expect(old.isError).toBe(false);
        const own = engine as unknown as Record<string, unknown>;
        const raw = engine.executeRaw as (...a: unknown[]) => Promise<unknown>;
        const refused: string[] = [];
        // A function, so a transaction engine (Object.create of this one) runs the statement on its own connection.
        own.executeRaw = function (this: unknown, sql: string, params?: unknown[], opts?: unknown) {
          // The typed member's own statement reaches executeRaw from an engine-sql module; only a caller's is refused.
          const viaMember = /[\\/]engine-sql[\\/]/.test(new Error().stack ?? '');
          if (!viaMember && /^\s*UPDATE facts\b/.test(sql) && /superseded_by\s*=/.test(sql)) {
            refused.push(sql.split('\n')[0]!);
            return Promise.reject(new Error('caller raw SQL in the supersede write'));
          }
          return raw.call(this, sql, params, opts);
        };
        let res;
        try { res = await call({ fact: 'Alice Example drinks coffee.', replaces: old.body.id }); } finally { delete own.executeRaw; }
        expect(refused).toEqual([]);
        expect(res.body).toMatchObject({ status: 'superseded', superseded_fact_id: old.body.id, replaced_by_caller: true });
        const rows = await engine.executeRaw<{ fact: string; expired: boolean; ends: boolean; superseded_by: string | null }>(
          'SELECT fact, expired_at IS NOT NULL AS expired, valid_until IS NOT NULL AS ends, superseded_by::text FROM facts ORDER BY id');
        expect(rows).toEqual([
          { fact: 'Alice Example drinks tea.', expired: true, ends: true, superseded_by: String(res.body.id) },
          { fact: 'Alice Example drinks coffee.', expired: false, ends: false, superseded_by: null },
        ]);
      }
    }, 60_000);
  });
}
