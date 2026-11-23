/**
 * The facts-home preview lists unfenced facts by byte order of their entity slug on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    scanFactsHome lists the unfenced facts of a source by byte order of entity slug, as PGLite sorts, so the
 *    facts-home preview (doctor strict-facts-outside-git, repair facts-home) reads the same on every brain.
 *  - Regression: an en_US Postgres sorted entity slugs by its locale, which skips `-` and `/` (`ab, a/z, a-z` instead
 *    of `a-z, a/z, ab`), so the preview listed the same facts in another order than a PGLite brain.
 *  - Why existing coverage misses it: the facts-home tests use entity slugs that sort the same in every locale, and
 *    CI's Postgres runs in C.UTF-8. This case uses slugs that differ by byte and by en_US; run it against an en_US
 *    Postgres to see it fail.
 *  - Seam: facts are written through engine.insertFact; scanFactsHome reads through the typed scanUnfencedFactRows,
 *    which the Rust arm serves.
 */
import { describe, expect } from 'bun:test';
import { scanFactsHome } from '../../src/core/facts/facts-home.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_SLUGS, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

describe('facts-home preview lists facts by byte', () => {
  parityTest('scanFactsHome lists unfenced facts by entity slug byte order', { methods: ['putPage', 'insertFact', 'listFactsHomeCandidates'] }, async (engine) => {
    for (const slug of MIXED_SLUGS) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
      await engine.insertFact({ fact: `${slug} has a legacy fact`, kind: 'fact', entity_slug: slug, visibility: 'world', source: 'legacy import' } as never,
        { source_id: 'default' });
    }
    const scan = await scanFactsHome(engine, 'default');
    expect(scan.rows.map(r => r.entity_slug).filter(slug => (MIXED_SLUGS as readonly (string | null)[]).includes(slug))).toEqual([...BYTE_SLUGS]);
  });
});
