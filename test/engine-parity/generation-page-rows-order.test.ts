/**
 * BrainEngine parity — the page row read of the generation adapters lists rows by slug bytes and each row's tags by
 * tag bytes on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readGenerationPageRows (every `match`: slug, synthesis, atoms by source_slug and source_path, chronicle)
 *    returns its rows by slug and each row's `tags` in byte order on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), as PGLite and the Rust store sort.
 *  - Regression: an en_US Postgres sorted `ORDER BY p.slug` and `jsonb_agg(t.tag ORDER BY t.tag)` by its locale, which
 *    skips punctuation and folds case (`ab` before `a-z`, `a-z` before `B`), so the same brain read its derived page rows
 *    and their tag lists in another order than on PGLite and Rust brains.
 *  - Why existing coverage misses it: generation-output-parity.test.ts reads slugs and tags that sort the same in every
 *    locale, and CI's Postgres runs in C.UTF-8. These cases mix `a-z`, `a/z`, `ab`, `a.b`, `a_b` and `B`; run them
 *    against an en_US Postgres to see them fail without `COLLATE "C"`.
 *  - Seam: none. Pages and tags come from putPage and addTag; the read is the typed member.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_SLUGS, MIXED_IDS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GenerationPageRowsQuery } from '../../src/core/engine-sql/generation-page-rows.ts';

const { parityTest } = parityArms(testBackends());

/** Tags with punctuation and an upper-case letter, in an order that is neither byte nor en_US order. */
const MIXED_TAGS = [...MIXED_IDS];
const BYTE_TAGS = byteOrder(MIXED_IDS);

/** Puts one page per slug (a `dir/` prefix keeps the slugs valid), in MIXED order, each tagged in MIXED order. */
async function seed(engine: BrainEngine, dir: string, type: string, frontmatter: (slug: string) => Record<string, unknown>) {
  for (const slug of MIXED_SLUGS) {
    const full = `${dir}/${slug}`;
    await engine.putPage(full, { type: type as never, title: full, compiled_truth: `body of ${full}`, timeline: '', frontmatter: frontmatter(full) });
    for (const tag of MIXED_TAGS) await engine.addTag(full, tag);
  }
  return MIXED_SLUGS.map(slug => `${dir}/${slug}`);
}

const read = async (engine: BrainEngine, query: GenerationPageRowsQuery) =>
  (await engine.readGenerationPageRows(query)).map(row => ({ slug: row.slug, tags: row.tags }));

describe('readGenerationPageRows sorts slugs and tags by byte', () => {
  parityTest('every match lists rows by slug bytes and tags by tag bytes', {
    methods: ['putPage', 'addTag', 'readGenerationPageRows'],
  }, async (engine) => {
    const synth = await seed(engine, 'synth', 'note', () => ({ raw_source: 'loc.md', dream_generated: true }));
    const atoms = await seed(engine, 'atoms', 'atom', () => ({ source_slug: 'notes/a', source_path: 'notes/a.md' }));
    const events = await seed(engine, 'events', 'event', () => ({ event: { depth: 'year' }, captured_via: 'life-chronicle:test' }));
    const out = {
      slug: await read(engine, { sourceId: 'default', match: 'slug', slug: synth[0]! }),
      synthesisBySlug: await read(engine, { sourceId: 'default', match: 'synthesis', slugs: synth, locator: null }),
      synthesisByLocator: await read(engine, { sourceId: 'default', match: 'synthesis', slugs: [], locator: 'loc.md' }),
      atomsBySourceSlug: await read(engine, { sourceId: 'default', match: 'atoms', slugs: [], field: 'source_slug', value: 'notes/a' }),
      atomsBySourcePath: await read(engine, { sourceId: 'default', match: 'atoms', slugs: [atoms[1]!], field: 'source_path', value: 'notes/a.md' }),
      chronicle: await read(engine, { sourceId: 'default', match: 'chronicle', slugs: [], depth: 'year' }),
    };
    const rows = (dir: string) => BYTE_SLUGS.map(slug => ({ slug: `${dir}/${slug}`, tags: BYTE_TAGS }));
    expect(out).toEqual({
      slug: [{ slug: synth[0]!, tags: BYTE_TAGS }],
      synthesisBySlug: rows('synth'),
      synthesisByLocator: rows('synth'),
      atomsBySourceSlug: rows('atoms'),
      atomsBySourcePath: rows('atoms'),
      chronicle: rows('events'),
    });
    expect(events).toHaveLength(3);
    return out;
  });
});
