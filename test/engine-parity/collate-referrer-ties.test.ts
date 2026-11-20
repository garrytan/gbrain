/**
 * Referrer pages, groups and record candidates break a date tie by byte order of source, then slug, on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    referrers that share a date come out by byte order of `(source_id, slug)`, as PGLite sorts: the referrer page
 *    (readReferrerPage) and the next page after its cursor, the members of a referenced_by group (readReferrerGroups),
 *    and the record rows kept per target (readTargetReferences).
 *  - Regression: an en_US Postgres sorted and compared source ids and slugs by its locale, which skips `-` and `/`
 *    (`ab, a/z, a-z` instead of `a-z, a/z, ab`), so a date tie listed referrers in another order than a PGLite brain,
 *    and a cursor compared in en_US after an ORDER BY in bytes would skip or repeat a referrer.
 *  - Why existing coverage misses it: test/engine-parity/referrer-reads.test.ts breaks its date tie on slugs that sort
 *    the same in every locale, and CI's Postgres runs in C.UTF-8. Every case here uses keys that differ by byte and by
 *    en_US; run it against an en_US Postgres to see it fail.
 *  - Seam: none. Real engines and the production functions only. Every referrer has the same effective date.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { decodeCursor, readReferrerGroups, readReferrerPage, readTargetReferences, type ReferrerScope } from '../../src/core/mentions/referrers.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_SLUGS, byteOrder, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, digits and `-` only): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const MIXED_SOURCES = ['ab', 'a0', 'a-z'];
const ACME = 'companies/acme-example';
const SOURCES = ['default', ...MIXED_SOURCES];

function page(title: string, type = 'note'): PageInput {
  return { type: type as PageInput['type'], title, compiled_truth: `${title} body`, timeline: '',
    effective_date: new Date('2026-04-01T00:00:00Z'), effective_date_source: 'date' };
}

function scope(): ReferrerScope {
  return { slug: ACME, sourceId: 'default', referrerSources: SOURCES, excludePrivate: false, pack: null, keepVisibility: ['private', 'world'] };
}

/** Acme, with MIXED_SLUGS as `default` referrers and `shared` as a referrer in each MIXED_SOURCES source, all dated the same. */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await engine.putPage(ACME, page('Acme Example', 'company'));
  for (const slug of MIXED_SLUGS) await engine.putPage(slug, page(slug));
  await engine.addLinksBatch(MIXED_SLUGS.map(slug => ({ from_slug: slug, to_slug: ACME, link_type: 'mentions', context: '',
    link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })));
  for (const id of MIXED_SOURCES) {
    await createSource(engine, backend, id);
    await engine.putPage('shared', page(`shared ${id}`), { sourceId: id });
    await engine.addLinksBatch([{ from_slug: 'shared', to_slug: ACME, link_type: 'mentions', context: '', link_source: 'manual',
      from_source_id: id, to_source_id: 'default' }]);
  }
}

/** Every referrer in byte order of (source_id, slug). */
const BYTE_REFS = [...BYTE_SLUGS.map(slug => ['default', slug]), ...byteOrder(MIXED_SOURCES).map(id => [id, 'shared'])]
  .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0));

describe('referrer date ties break by byte', () => {
  parityTest('readReferrerPage lists a date tie by byte and pages through it without a skip',
    { methods: ['putPage', 'addLinksBatch', 'countReferrerRows', 'readReferrerRows'] }, async (engine, backend) => {
      await seed(engine, backend);
      const all = await readReferrerPage(engine, scope(), { limit: 50 });
      expect(all.rows.map(r => [r.source_id, r.slug])).toEqual(BYTE_REFS);
      const paged: string[][] = [];
      let cursor: [string | null, string, string] | null = null;
      for (let i = 0; i < BYTE_REFS.length + 1; i++) {
        const next = await readReferrerPage(engine, scope(), { limit: 2, cursor });
        paged.push(...next.rows.map(r => [r.source_id, r.slug]));
        if (!next.cursor) break;
        cursor = decodeCursor(next.cursor);
      }
      expect(paged).toEqual(BYTE_REFS);
    });

  parityTest('readReferrerGroups lists a group\'s date tie by byte', { methods: ['putPage', 'addLinksBatch', 'readReferrerGroupRows'] }, async (engine, backend) => {
    await seed(engine, backend);
    const { groups } = await readReferrerGroups(engine, scope());
    expect(groups.map(g => [g.canonical_type, g.rows.map(r => [r.source_id, r.slug])])).toEqual([['note', BYTE_REFS]]);
  });

  parityTest('readTargetReferences keeps a date tie\'s record rows by byte',
    { methods: ['putPage', 'addLinksBatch', 'readReferrerTargetCounts', 'readReferrerRecordCandidates', 'readReferrerRecordPages'] }, async (engine, backend) => {
      await seed(engine, backend);
      const base = { referrerSources: SOURCES, excludePrivate: false, pack: null, keepVisibility: ['private', 'world'] as ('private' | 'world')[] };
      const [refs] = await readTargetReferences(engine, base, [{ slug: ACME, sourceId: 'default' }], { recordTypes: ['note'], perTarget: 3 });
      // Each source's `shared` page is titled `shared <source>`, so the titles show which sources the tie kept.
      expect(refs!.records!.map(g => g.rows.map(r => r.title))).toEqual([BYTE_REFS.slice(0, 3).map(([src, slug]) => (src === 'default' ? slug! : `shared ${src}`))]);
    });
});
