/**
 * BrainEngine parity: the page-shape reads of `gbrain schema detect` (src/core/schema-pack/detect.ts), in
 * src/core/engine-sql/schema-detect.ts: page totals of a source, the slug-prefix distribution with the page types under
 * each prefix, and the page-type distribution.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member below, and `runDetect` over them, returns the same observable result on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1). Counts sort largest first,
 *    a tie sorts in byte order, and the types under a prefix are in byte order.
 *  - Regression: `array_agg(DISTINCT type)` sorted the types under a prefix by the database's default collation, so
 *    Postgres in an en_US database listed type 'ab' before 'a-z' while PGLite (collation C) listed 'a-z' first; a count
 *    tie had no order at all. On the Rust engine the three statements ran through `executeRaw`, which it refuses, so
 *    `gbrain schema detect` stopped.
 *  - Why existing coverage misses it: test/schema-pack/suggest.test.ts runs on PGLite only, and the parity cases cannot
 *    call `executeRaw` (D18).
 *  - Seam: none; every page and source is seeded through `putPage`, `softDeletePage` and `createSource`.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runDetect } from '../../src/core/schema-pack/detect.ts';

const { parityTest } = parityArms(testBackends());

const page = (type: string) => ({ type: type as never, title: type || 'untyped', compiled_truth: 'x' });

/** Seeds `default` with prefix and type ties whose byte order differs from en_US order, plus a deleted page and another source. */
async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'other');
  const rows: Array<[string, string]> = [
    ['notes/a', 'ab'], ['notes/b', 'a-z'], ['notes/c', 'ab'], ['notes/d', ''],
    ['ab/a', 'x'], ['ab/b', 'x'], ['ab/c', 'x'],
    ['a-z/a', 'y'], ['a-z/b', 'y'], ['a-z/c', 'y'],
    ['small/a', 'x'], ['loose', 'a-z'], ['gone/a', 'ab'],
  ];
  for (const [slug, type] of rows) await engine.putPage(slug, page(type));
  await engine.putPage('notes/elsewhere', page('elsewhere'), { sourceId: 'other' });
  await engine.softDeletePage('gone/a');
}

describe('engine parity: schema detect page-shape reads', () => {
  parityTest('pageTypeTotals counts the live pages of the source and the empty type as untyped', {
    methods: ['pageTypeTotals', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const answers = { here: await engine.pageTypeTotals('default'), none: await engine.pageTypeTotals('no-such-source') };
    expect(answers).toEqual({ here: { total: 12, typed: 11, untyped: 1 }, none: { total: 0, typed: 0, untyped: 0 } });
    return answers;
  });

  parityTest('pagePrefixSamples sorts by count then prefix bytes, lists types in byte order, and applies minPages and limit', {
    methods: ['pagePrefixSamples', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const answers = {
      all: await engine.pagePrefixSamples('default', 1, 50),
      atLeastThree: await engine.pagePrefixSamples('default', 3, 2),
      none: await engine.pagePrefixSamples('no-such-source', 1, 50),
    };
    expect(answers).toEqual({
      all: [
        { prefix: 'notes/', cnt: 4, sample_types: ['a-z', 'ab'] },
        { prefix: 'a-z/', cnt: 3, sample_types: ['y'] },
        { prefix: 'ab/', cnt: 3, sample_types: ['x'] },
        { prefix: 'small/', cnt: 1, sample_types: ['x'] },
      ],
      atLeastThree: [
        { prefix: 'notes/', cnt: 4, sample_types: ['a-z', 'ab'] },
        { prefix: 'a-z/', cnt: 3, sample_types: ['y'] },
      ],
      none: [],
    });
    return answers;
  });

  parityTest('countPagesByTypeForSource skips the empty type, breaks a count tie in byte order and applies the limit', {
    methods: ['countPagesByTypeForSource', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const answers = { all: await engine.countPagesByTypeForSource('default', 100), two: await engine.countPagesByTypeForSource('default', 2) };
    expect(answers).toEqual({
      all: [{ type: 'x', cnt: 4 }, { type: 'y', cnt: 3 }, { type: 'a-z', cnt: 2 }, { type: 'ab', cnt: 2 }],
      two: [{ type: 'x', cnt: 4 }, { type: 'y', cnt: 3 }],
    });
    return answers;
  });

  parityTest('runDetect reports the same totals, prefixes and candidate types on every engine', {
    methods: ['pageTypeTotals', 'pagePrefixSamples', 'countPagesByTypeForSource', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const got = await runDetect(engine, { minPagesPerPrefix: 3 });
    const answers = {
      totals: [got.total_pages, got.typed_pages, got.untyped_pages],
      prefixes: got.prefixes,
      types: got.candidate.page_types.map(t => t.name),
    };
    expect(answers.totals).toEqual([12, 11, 1]);
    expect(answers.prefixes.map(p => [p.prefix, p.page_count, p.sample_types])).toEqual([
      ['notes/', 4, ['a-z', 'ab']], ['a-z/', 3, ['y']], ['ab/', 3, ['x']],
    ]);
    return answers;
  });
});
