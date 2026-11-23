/**
 * BrainEngine parity: the bare-name page lookup of a slot-history question (search/slot-history.ts entityKeys),
 * `listReadablePageSlugs` in src/core/engine-sql/facts-recall.ts. (The quote reads of search/transcript-quote.ts are
 * `listFactsFromQuotedPages` and `listOwnerTierFacts`, pinned by test/engine-parity/facts-trust.test.ts.)
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the member returns the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers it differently changes whether a slot-history question finds its entity's
 *    history; on the Rust engine this ran through `executeRaw`, which it refuses, so every history was lost.
 *  - Why existing coverage misses it: the statement ran through `executeRaw`, which the parity cases cannot call (D18),
 *    so no case compared it across engines.
 *  - Seam: none; every page and source is seeded through the typed members (`putPage`, `softDeletePage`) and
 *    `createSource`.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const page = (type: string, frontmatter: Record<string, unknown> = {}) => ({ type: type as never, title: type, compiled_truth: 'x', frontmatter });

describe('engine parity: slot-history page lookup', () => {
  parityTest('listReadablePageSlugs keeps the live pages the read scope admits in the asked source, at most the limit', {
    methods: ['listReadablePageSlugs', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/a', page('person'));
    await engine.putPage('people/b', page('person'));
    await engine.putPage('people/gone', page('person'));
    await engine.putPage('people/held', page('person', { quarantine: { reason: 'test' } }));
    await engine.putPage('people/c', page('person'), { sourceId: 'other' });
    await engine.softDeletePage('people/gone');
    const asked = ['people/gone', 'people/held', 'people/c', 'people/b', 'people/a'];
    const answers = {
      all: sorted(await engine.listReadablePageSlugs(SRC, asked, {}, 10)),
      capped: (await engine.listReadablePageSlugs(SRC, asked, {}, 1)).length,
      scopeSourcesIgnored: sorted(await engine.listReadablePageSlugs(SRC, asked, { sourceId: 'other', sourceIds: ['other'] }, 10)),
      otherSource: await engine.listReadablePageSlugs('other', asked, {}, 10),
      floor: await engine.listReadablePageSlugs(SRC, ['people/a'], { minTrust: 'operator_curated' }, 10),
      none: await engine.listReadablePageSlugs(SRC, [], {}, 2),
    };
    expect(answers).toEqual({
      all: ['people/a', 'people/b'],
      capped: 1,
      scopeSourcesIgnored: ['people/a', 'people/b'],
      otherSource: ['people/c'],
      floor: [],
      none: [],
    });
    return answers;
  });
});
