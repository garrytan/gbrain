/**
 * Schema-pack previews list their sample slugs and orphans by byte order on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the schema-pack dry runs and reviews pick and list pages in byte order of slug (and of source id, then
 *    slug, for the orphan review) on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), as PGLite sorts: `schema retype`'s sample_slugs (runRetypeCore), `schema review-orphans`
 *    (findTypeOrphans), and the page-to-alias and page-to-link sample_slugs (runPageToAliasCore, runPageToLinkCore).
 *  - Regression: an en_US Postgres sorted slugs and source ids by its locale, which skips `-` and `/` (`ab, a/z, a-z`
 *    instead of `a-z, a/z, ab`), so these previews showed another sample, and another truncated set, than a PGLite brain.
 *  - Why existing coverage misses it: the schema-pack tests use slugs that sort the same in every locale, and CI's
 *    Postgres runs in C.UTF-8. Every case here uses keys that differ by byte and by en_US; run it against an en_US
 *    Postgres to see it fail.
 *  - Seam: pages are written with putPage; the orphan case blanks their type with harness-only SQL. No schema pack is
 *    active, so the cores take their pack-less path. Every core reads raw SQL, so the Rust arm stops on its raw_sql
 *    refusal.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { runRetypeCore } from '../../src/core/schema-pack/retype.ts';
import { findTypeOrphans } from '../../src/core/schema-pack/review.ts';
import { runPageToAliasCore } from '../../src/core/schema-pack/page-to-alias.ts';
import { runPageToLinkCore } from '../../src/core/schema-pack/page-to-link.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_SLUGS, byteOrder, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, digits and `-` only): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const MIXED_SOURCES = ['ab', 'a0', 'a-z'];
const TYPE = 'legacy-note';
const TARGET = 'notes/target';

function ctxFor(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

async function pages(engine: BrainEngine, sourceId = 'default') {
  await engine.putPage(TARGET, { type: 'note', title: 'target', compiled_truth: 'target', timeline: '' }, { sourceId });
  for (const slug of MIXED_SLUGS) {
    await engine.putPage(slug, { type: TYPE, title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter: { canonical: TARGET } }, { sourceId });
  }
}

describe('schema-pack previews list pages by byte', () => {
  parityTest('runRetypeCore samples slugs by byte', { methods: ['putPage', 'probeRetypeRows'] }, async (engine) => {
    await pages(engine);
    const result = await runRetypeCore(ctxFor(engine), { rules: [{ from_type: TYPE, to_type: 'note' }], sourceId: 'default' });
    expect(result.per_rule[0]!.sample_slugs).toEqual([...BYTE_SLUGS]);
  });

  parityTest('findTypeOrphans lists sources, then slugs, by byte', { methods: ['putPage', 'countLivePagesByType', 'listTypeOrphanRows'] }, async (engine, backend) => {
    for (const id of MIXED_SOURCES) {
      await createSource(engine, backend, id);
      await pages(engine, id);
      // The same pages written again with no type (an empty frontmatter type).
      for (const slug of MIXED_SLUGS) {
        await engine.putPage(slug, { type: '' as never, title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter: { canonical: TARGET } }, { sourceId: id });
      }
    }
    const result = await findTypeOrphans(engine, null, { sourceIds: MIXED_SOURCES }, 100);
    expect(result.orphans.map(o => [o.source_id, o.slug])).toEqual(byteOrder(MIXED_SOURCES).flatMap(id => BYTE_SLUGS.map(slug => [id, slug])));
  });

  parityTest('runPageToAliasCore samples slugs by byte', { methods: ['putPage', 'listAliasCandidatePages'] }, async (engine) => {
    await pages(engine);
    const result = await runPageToAliasCore(ctxFor(engine), {
      rules: [{ from_type: TYPE, canonical_from: { frontmatter_field: 'canonical' }, alias_slug_from: 'slug' }] });
    expect(result.per_rule[0]!.sample_slugs).toEqual([...BYTE_SLUGS]);
  });

  parityTest('runPageToLinkCore samples slugs by byte', { methods: ['putPage', 'listLinkCandidatePages'] }, async (engine) => {
    await pages(engine);
    const result = await runPageToLinkCore(ctxFor(engine), { rules: [{ from_type: TYPE, link_type: 'mentions',
      source_slug_from: 'slug', target_slug_from: { frontmatter_field: 'canonical' } }], sourceId: 'default' });
    expect(result.per_rule[0]!.sample_slugs).toEqual([...BYTE_SLUGS]);
  });
});
