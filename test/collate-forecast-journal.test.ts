/**
 * readForecastJournal lists predictions in byte order of (source id, slug, row number) on both SQL engines.
 *
 * 1. Contract: `readForecastJournal` returns its entries ordered by source id, then page slug, then row number, in byte
 *    (code point) order, the order PGLite (collation C) and the Rust engine give; `limit` keeps the first entries of that order.
 * 2. Regression: `readPredictions` sorting by the database's default collation. en_US ignores punctuation at the first level,
 *    so Postgres listed slug 'notes/ab' before 'notes/a-z' and source 'ab-example' before 'a-z-example'.
 * 3. Why existing coverage misses it: test/forecast-journal.test.ts reads entries by slug through `Object.fromEntries` or `.sort()`
 *    and uses one source with slugs that sort the same in every collation.
 * 4. Seams: none. Sources, pages and takes are inserted with `executeRaw`; no belief ledger coverage is needed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readForecastJournal } from '../src/core/forecast-journal.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const AS_OF = new Date('2026-10-16T00:00:00Z');

for (const kind of testBackends()) {
  describe(`forecast journal order (${kind})`, () => {
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
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const source of ['a-z-example', 'ab-example']) {
        await engine.executeRaw("INSERT INTO sources(id, name, config) VALUES ($1, $1, '{}')", [source]);
      }
      // Inserted in en_US order, so a byte-order result is not the insertion order.
      for (const [source, slug] of [['ab-example', 'notes/a-z'], ['a-z-example', 'notes/ab'], ['a-z-example', 'notes/a-z'], ['ab-example', 'notes/ab']] as const) {
        const [page] = await engine.executeRaw<{ id: number }>(
          "INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ($1, $2, 'note', 'Example', '') RETURNING id", [source, slug]);
        await engine.executeRaw(
          `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, source, active)
           VALUES ($1, 1, $2, 'bet', 'alice-example', 0.7, '2026-01', 'test', true)`, [page!.id, `Claim of ${source}:${slug}`]);
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    const keys = (entries: Array<{ source_id: string; page_slug: string }>) => entries.map(e => `${e.source_id}:${e.page_slug}`);

    test('lists entries by source id, then slug, in byte order', async () => {
      expect(keys((await readForecastJournal(engine, { asOf: AS_OF })).entries)).toEqual([
        'a-z-example:notes/a-z', 'a-z-example:notes/ab', 'ab-example:notes/a-z', 'ab-example:notes/ab',
      ]);
    });

    test('limit keeps the first entries in byte order', async () => {
      expect(keys((await readForecastJournal(engine, { asOf: AS_OF, limit: 2 })).entries)).toEqual(['a-z-example:notes/a-z', 'a-z-example:notes/ab']);
    });
  });
}
