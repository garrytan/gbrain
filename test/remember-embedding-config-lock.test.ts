/**
 * A remember that carries a fact vector re-checks the embedding config under a share lock before it publishes.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the publication's re-check reads `embedding_dimensions` and `embedding_model` through the typed
 *    `getConfigValues(keys, { lock: 'share' })` member, never caller raw SQL, and on Postgres that read holds the
 *    config rows FOR SHARE until the publication commits, so an embedding switch cannot land between check and write.
 *  - Regression: a Rust brain refuses caller raw SQL, so a raw re-check stops every remember with a vector there; a
 *    typed read that drops the lock lets a concurrent config change slip past the re-check on Postgres.
 *  - Why existing coverage misses it: remember tests run without a fact vector, which skips the re-check, and the
 *    getConfigValues parity cases never ask for a lock.
 *  - Seam: an executeRaw hook on the engine (the transaction engine inherits it) and a second Postgres connection.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const DIMS = LEGACY_EMBEDDING_CONFIG.embedding_dimensions;
const KEYS = ['embedding_dimensions', 'embedding_model'] as const;

function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  return v;
}

afterEach(() => { __setEmbedTransportForTests(null); resetGateway(); });

for (const kind of testBackends()) {
  describe(`remember embedding config re-check (${kind})`, () => {
    let engine: BrainEngine;
    let pglite: PGLiteEngine | undefined;
    let url: string | null = null;
    let closePg: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (kind === 'postgres') {
        const opened = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engine = opened.engine;
        url = opened.databaseUrl;
        closePg = opened.close;
      } else {
        pglite = new PGLiteEngine();
        await pglite.connect({ engine: 'pglite' } as never);
        await pglite.initSchema();
        engine = pglite;
      }
    });
    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine);
      await closePg?.();
      await pglite?.disconnect();
    });

    test('a remember with a fact vector re-checks the embedding config through the typed member, not caller raw SQL', async () => {
      {
        await engine.setConfig('embedding_model', LEGACY_EMBEDDING_CONFIG.embedding_model);
        await engine.setConfig('embedding_dimensions', String(DIMS));
        configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'test' } });
        let embedded = 0;
        __setEmbedTransportForTests((async ({ values }: { values: string[] }) => { embedded += values.length; return { embeddings: values.map(vectorFor) }; }) as never);
        const own = engine as unknown as Record<string, unknown>;
        const raw = engine.executeRaw as (...a: unknown[]) => Promise<unknown>;
        const refused: string[] = [];
        // A function, so a transaction engine (Object.create of this one) runs the statement on its own connection.
        own.executeRaw = function (this: unknown, sql: string, params?: unknown[], opts?: unknown) {
          if (/FROM config WHERE key IN \('embedding_model','embedding_dimensions'\)/.test(sql)) {
            // A Rust brain refuses all caller raw SQL; this hook does the same for the re-check statement.
            refused.push(sql);
            return Promise.reject(new Error('caller raw SQL in the embedding config re-check'));
          }
          return raw.call(this, sql, params, opts);
        };
        try {
          const res = await dispatchToolCall(engine, 'remember', { fact: 'The canary ships on Fridays.', provenance: 'test', entity: 'people/alice-example' }, { remote: false });
          const body = JSON.parse(res.content[0]!.text!) as Record<string, unknown>;
          expect(refused).toEqual([]);
          expect(res.isError).not.toBe(true);
          expect(body.status).toBe('inserted');
        } finally { delete own.executeRaw; }
        expect(embedded).toBeGreaterThan(0);
        const [row] = await engine.executeRaw<{ vector: boolean }>("SELECT embedding IS NOT NULL AS vector FROM facts WHERE fact = 'The canary ships on Fridays.'");
        expect(row).toEqual({ vector: true });
      }
    }, 60_000);

    if (kind === 'postgres') {
      test('getConfigValues with lock share holds the config rows until the transaction ends', async () => {
        const other = postgres(url!, { max: 1, prepare: false });
        try {
          await engine.setConfig('embedding_model', LEGACY_EMBEDDING_CONFIG.embedding_model);
          await engine.setConfig('embedding_dimensions', String(DIMS));
          const outcome = await engine.transaction(async tx => {
            const rows = await tx.getConfigValues(KEYS, { lock: 'share' });
            const write = await other.begin(async s => {
              await s.unsafe("SET LOCAL lock_timeout = '300ms'");
              await s.unsafe("UPDATE config SET value = 'openai:other' WHERE key = 'embedding_model'");
            }).then(() => 'written', (e: { code?: string }) => e.code ?? 'error');
            return { rows, write };
          });
          expect(outcome).toEqual({
            rows: [{ key: 'embedding_dimensions', value: String(DIMS) }, { key: 'embedding_model', value: LEGACY_EMBEDDING_CONFIG.embedding_model }],
            write: '55P03',
          });
        } finally { await other.end(); }
      }, 60_000);
    }
  });
}
