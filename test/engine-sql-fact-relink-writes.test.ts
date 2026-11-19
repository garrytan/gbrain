/**
 * Relink write SQL that the engine parity tests cannot see, on both SQL engines.
 *
 * 1. Contract: `placeRelinkedFact` link sets `entity_slug` and `source_markdown_slug` to the page and `row_num` to the
 *    position; retire sets only `entity_slug` (the row stays off the fence: no page coordinate, no row number) and stamps
 *    `expired_at` with the statement's clock. Neither touches `valid_until` or the claim.
 * 2. Regressions: retire also writing the page coordinate (the page projection would then match the expired duplicate as a
 *    fence row), link leaving `source_markdown_slug` unset, or retire stamping a time other than now.
 * 3. Existing coverage: no typed reader returns `source_markdown_slug` of an expired row or an `expired_at` the parity harness
 *    can compare (each arm stamps its own clock), so test/engine-parity/fact-relink-writes.test.ts passes with any of these.
 * 4. Seams: none. The test reads rows with `executeRaw`, which both SQL engines already expose.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SLUG = 'people/alice-example';

for (const kind of testBackends()) {
  describe(`fact relink writes SQL (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const stored = async (id: number) =>
      (await engine.executeRaw<{ entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null; fact: string;
        valid_until: unknown; expired_ms: number | null; now_ms: number }>(
        `SELECT entity_slug, source_markdown_slug, row_num, fact, valid_until,
                (extract(epoch FROM expired_at) * 1000)::float8 AS expired_ms, (extract(epoch FROM now()) * 1000)::float8 AS now_ms
           FROM facts WHERE source_id = 'default' AND id = $1`, [id]))[0]!;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => { await engine.executeRaw('DELETE FROM facts'); });

    test('link writes the page coordinate and row number; retire writes only the entity and an expiry of now', async () => {
      const linked = (await engine.insertFact({ fact: 'likes tea', source: 'chat' }, { source_id: 'default' })).id;
      const retired = (await engine.insertFact({ fact: 'likes coffee', source: 'chat' }, { source_id: 'default' })).id;
      expect(await engine.placeRelinkedFact('default', { factId: linked, action: 'link', slug: SLUG, rowNum: 3, context: 'n' })).toBe(true);
      expect(await engine.placeRelinkedFact('default', { factId: retired, action: 'retire', slug: SLUG, context: 'n' })).toBe(true);
      const l = await stored(linked);
      const r = await stored(retired);
      expect({ ...l, now_ms: 0 }).toEqual({ entity_slug: SLUG, source_markdown_slug: SLUG, row_num: 3, fact: 'likes tea', valid_until: null, expired_ms: null, now_ms: 0 });
      expect({ entity_slug: r.entity_slug, source_markdown_slug: r.source_markdown_slug, row_num: r.row_num, fact: r.fact, valid_until: r.valid_until })
        .toEqual({ entity_slug: SLUG, source_markdown_slug: null, row_num: null, fact: 'likes coffee', valid_until: null });
      expect(r.expired_ms).not.toBeNull();
      expect(Math.abs(r.now_ms - r.expired_ms!)).toBeLessThan(60_000);
    });
  });
}
