/**
 * Tag lists, slug lists and relational paths built inside a query come out in byte order on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the lists a query aggregates or tie-breaks on text come out in byte order on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), as PGLite sorts: a page snapshot's
 *    tags (readPageSnapshot, readPageSnapshotsBatch), an export's tags (readExportPages), a guest source's merged
 *    writers (initGuestSource), the relational fanout's rows and the path it shows for a node (relationalFanout), and
 *    the page an unscoped removed path resolves to (resolveSlugsForRemovedPaths).
 *  - Regression: an en_US Postgres sorted these keys by its locale, which skips `-` and `/` (`ab, a/z, a-z` instead of
 *    `a-z, a/z, ab`), so snapshots, exports and their digests listed tags in another order, and fanout showed another
 *    path, than a PGLite brain did.
 *  - Why existing coverage misses it: the tests of these readers use keys that sort the same in every locale, and CI's
 *    Postgres runs in C.UTF-8. Every case here uses keys that differ by byte and by en_US; run it against an en_US
 *    Postgres to see it fail.
 *  - Seam: pages, tags and links are written through the engine; the removed-path case sets source_path with
 *    harness-only SQL. Snapshot and fanout are engine methods, so the Rust arm runs them; the other readers use raw
 *    SQL, so the Rust arm stops on its raw_sql refusal.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { readExportPages } from '../../src/core/export-snapshot.ts';
import { initGuestSource } from '../../src/core/guests/sources.ts';
import { resolveSlugsForRemovedPaths } from '../../src/core/sync-git.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_SLUGS, byteOrder, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, digits and `-` only): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const MIXED_SOURCES = ['ab', 'a0', 'a-z'];
const SLUG = 'notes/tagged';

async function tagged(engine: BrainEngine) {
  await engine.putPage(SLUG, { type: 'note', title: 'tagged', compiled_truth: 'tagged', timeline: '' });
  for (const tag of MIXED_SLUGS) await engine.addTag(SLUG, tag);
}

describe('aggregated lists come out by byte', () => {
  parityTest('readPageSnapshot lists tags by byte', { methods: ['putPage', 'addTag', 'readPageSnapshot'] }, async (engine) => {
    await tagged(engine);
    expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))?.tags).toEqual([...BYTE_SLUGS]);
  });

  parityTest('readPageSnapshotsBatch lists tags by byte', { methods: ['putPage', 'addTag', 'readPageSnapshotsBatch'] }, async (engine) => {
    await tagged(engine);
    const { snapshots } = await engine.readPageSnapshotsBatch([{ slug: SLUG, sourceId: 'default' }]);
    expect([...snapshots.values()][0]?.tags).toEqual([...BYTE_SLUGS]);
  });

  parityTest('readExportPages lists tags by byte', { methods: ['putPage', 'addTag', 'getPage'] }, async (engine) => {
    await tagged(engine);
    const page = await engine.getPage(SLUG, { sourceId: 'default' });
    const [snapshot] = await readExportPages(engine, [{ id: String(page!.id), source_id: 'default', slug: SLUG }], []);
    expect(snapshot!.tags).toEqual([...BYTE_SLUGS]);
  });

  parityTest('relationalFanout lists nodes and picks the path by byte', { methods: ['putPage', 'addLink', 'relationalFanout'] }, async (engine) => {
    for (const slug of ['seed', 'target', ...MIXED_SLUGS]) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '' });
    }
    for (const mid of MIXED_SLUGS) {
      await engine.addLink('seed', mid, '', 'related_to', 'manual');
      await engine.addLink(mid, 'target', '', 'related_to', 'manual');
    }
    const rows = await engine.relationalFanout(['seed'], { direction: 'out', depth: 2, sourceId: 'default' });
    expect(rows.filter(r => r.hop === 1).map(r => r.slug)).toEqual([...BYTE_SLUGS]);
    expect(rows.find(r => r.slug === 'target')?.path).toEqual(['seed', BYTE_SLUGS[0], 'target']);
  });

  parityTest('resolveSlugsForRemovedPaths picks the lowest source by byte', { methods: ['putPage', 'refreshPageOrigin', 'readFirstLiveSlugAtPath'] }, async (engine, backend) => {
    for (const id of MIXED_SOURCES) {
      await createSource(engine, backend, id);
      await engine.putPage(`s${id}`, { type: 'note', title: id, compiled_truth: id, timeline: '' }, { sourceId: id });
      await engine.refreshPageOrigin(`s${id}`, { sourceId: id, sourcePath: 'shared.md' });
    }
    const result = await resolveSlugsForRemovedPaths(engine, ['shared.md'], undefined);
    expect(result.slugs.get('shared.md')).toBe(`s${byteOrder(MIXED_SOURCES)[0]}`);
  });
});
