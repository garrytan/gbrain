/**
 * Search coverage counts at the 1000-page cap (engine-sql/retrieval-coverage.ts `countInScope`).
 *
 * The count of waiting pages that could affect a query used to read an unordered first 1000 pages, so its answer
 * moved with the order pages were written in; it is now min(every match in scope, cap). To stay cheap when a word
 * matches few of many waiting pages, the word test can read the v340 trigram index (idx_pages_projection_waiting_words)
 * instead of testing every waiting page, and the statement runs unprepared so Postgres plans it for its bound words
 * (a cached generic plan tested every page: about 18 ms against 3 ms at 10,000 waiting pages). A count past
 * COVERAGE_COUNT_TIMEOUT_MS is unknown (null), never zero.
 *
 * The cross-engine answers are pinned by test/engine-parity/retrieval-coverage.test.ts; this file pins the read's
 * options, the time limit's null and, on Postgres, that the word test reads the index.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { countPendingProjectionPages } from '../../src/core/engine-sql/retrieval-coverage.ts';
import { COVERAGE_COUNT_TIMEOUT_MS, coverageRelevance } from '../../src/core/search/retrieval-coverage.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const WORDS = coverageRelevance([{ type: 'company' }], 'widget', undefined, new Set());

describe('coverage count read options', () => {
  test('the count runs unprepared under the coverage time limit', async () => {
    const seen: unknown[] = [];
    const count = await countPendingProjectionPages(async (_sql, _params, opts) => {
      seen.push(opts);
      return [{ total: 3, could_affect: 1, could_affect_images: 0 }] as never;
    }, {}, WORDS);
    // The pending count is the classed one, so it also runs JIT off (sync 11).
    expect(seen).toEqual([{ timeoutMs: COVERAGE_COUNT_TIMEOUT_MS, prepare: false, jitOff: true }]);
    expect(count).toEqual({ total: 3, could_affect: 1, capped: false, could_affect_images: 0 });
  });

  test('a count the server ends at the time limit is unknown, never zero', async () => {
    const timedOut = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const count = await countPendingProjectionPages(async () => { throw timedOut; }, {}, WORDS);
    expect(count).toBeNull();
  });
});

for (const kind of testBackends()) {
  describe('capped coverage count (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      // 10,000 waiting notes (no text projection yet); the word "widget" is in three titles, two of them written last.
      await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline)
        SELECT 'default', 'notes/page-' || lpad(i::text, 5, '0'), 'note',
          CASE WHEN i IN (7, 9999, 10000) THEN 'Widget plan ' || i ELSE 'Meeting notes ' || i END, 'body ' || i, ''
        FROM generate_series(1, 10000) i`);
      await engine.executeRaw('ANALYZE pages');
    }, 120_000);

    afterAll(async () => {
      await close?.();
    });

    test('could_affect counts every match among 10,000 waiting pages, not the matches among the first 1000 read', async () => {
      expect(await engine.countPendingProjectionPages({}, WORDS)).toEqual({ total: 1000, could_affect: 3, capped: true, could_affect_images: 0 });
    });

    test('on Postgres the word test reads the waiting-pages trigram index', async () => {
      if (kind !== 'postgres') return;
      let statement: { sql: string; params: unknown[] } | null = null;
      await countPendingProjectionPages(async (sql, params) => {
        statement = { sql, params: params ?? [] };
        return [{ total: 0, could_affect: 0 }] as never;
      }, {}, WORDS);
      const plan = (await engine.executeRaw<Record<string, string>>('EXPLAIN ' + statement!.sql, statement!.params))
        .map(row => Object.values(row)[0]).join('\n');
      expect(plan).toContain('idx_pages_projection_waiting_words');
    });
  });
}
