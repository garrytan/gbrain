/**
 * BrainEngine parity — pages family (CRUD, soft delete, listing, slugs, tags).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every page read/write method returns the same observable
 *    result on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    a Rust arm later through test/engine-parity/harness.ts).
 *  - Regression: an engine that drifts on page round-trip, soft-delete
 *    visibility, slug resolution, listing order or tag sets — the read
 *    paths every brain query starts from.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and covers mostly search/graph; the
 *    per-engine unit tests never compare two engines on one scenario.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseFindPattern } from '../../src/core/page-find.ts';
import type { Page, PageInput } from '../../src/core/types.ts';
import { createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const PAGE_KEYS = ['slug', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter'] as const;

function view(page: Page | null) {
  return page ? pick(page, PAGE_KEYS) : null;
}

async function seed(engine: BrainEngine, pages: Array<[string, PageInput]>, opts?: { sourceId?: string }) {
  for (const [slug, input] of pages) await engine.putPage(slug, input, opts);
}

const ALICE: PageInput = {
  type: 'person',
  title: 'Alice Example',
  compiled_truth: 'Alice runs product at acme-example.',
  timeline: '- 2026-01-02: joined acme-example',
  frontmatter: { role: 'pm', tags: ['founder'] },
};
const ACME: PageInput = { type: 'company', title: 'Acme Example', compiled_truth: 'Acme builds widgets.', timeline: '' };
const NOTE: PageInput = { type: 'note', title: 'Weekly note', compiled_truth: 'Met alice-example about widgets.', timeline: '' };

describe('engine parity: pages', () => {
  parityTest('putPage then getPage round-trips the page', { methods: ['putPage', 'getPage'] }, async (engine) => {
    const written = await engine.putPage('people/alice-example', ALICE);
    expect(written.slug).toBe('people/alice-example');
    const read = await engine.getPage('people/alice-example');
    expect(read?.title).toBe('Alice Example');
    expect(read?.frontmatter.role).toBe('pm');
    const missing = await engine.getPage('people/nobody');
    expect(missing).toBeNull();
    return { written: view(written), read: view(read), missing };
  });

  parityTest('putPage on an existing slug updates in place', { methods: ['putPage', 'getPage', 'listPages'] }, async (engine) => {
    const first = await engine.putPage('companies/acme-example', ACME);
    const second = await engine.putPage('companies/acme-example', { ...ACME, compiled_truth: 'Acme builds better widgets.' });
    expect(second.id).toBe(first.id);
    const read = await engine.getPage('companies/acme-example');
    expect(read?.compiled_truth).toBe('Acme builds better widgets.');
    const all = await engine.listPages();
    expect(all.map((p) => p.slug)).toEqual(['companies/acme-example']);
    return { read: view(read), count: all.length };
  });

  parityTest(
    'softDeletePage hides a page; restorePage brings it back',
    { methods: ['softDeletePage', 'restorePage', 'getPage', 'listPages', 'getAllSlugs'] },
    async (engine) => {
      await seed(engine, [['people/alice-example', ALICE], ['companies/acme-example', ACME]]);
      const deleted = await engine.softDeletePage('people/alice-example');
      expect(deleted).toEqual({ slug: 'people/alice-example' });
      const again = await engine.softDeletePage('people/alice-example');
      const hidden = await engine.getPage('people/alice-example');
      expect(hidden).toBeNull();
      const visibleWithFlag = await engine.getPage('people/alice-example', { includeDeleted: true });
      expect(visibleWithFlag?.deleted_at).toBeInstanceOf(Date);
      const listed = (await engine.listPages()).map((p) => p.slug);
      const slugsWhileDeleted = sorted(await engine.getAllSlugs());
      const restored = await engine.restorePage('people/alice-example');
      expect(restored).toBe(true);
      const restoredAgain = await engine.restorePage('people/alice-example');
      expect(restoredAgain).toBe(false);
      const back = await engine.getPage('people/alice-example');
      expect(back?.deleted_at ?? null).toBeNull();
      return { again, listed, slugsWhileDeleted, back: view(back) };
    },
  );

  parityTest('deletePage removes the page for good', { methods: ['deletePage', 'getPage', 'getAllSlugs'] }, async (engine) => {
    await seed(engine, [['people/alice-example', ALICE], ['companies/acme-example', ACME]]);
    await engine.deletePage('people/alice-example');
    const gone = await engine.getPage('people/alice-example', { includeDeleted: true });
    expect(gone).toBeNull();
    const slugs = sorted(await engine.getAllSlugs());
    expect(slugs).toEqual(['companies/acme-example']);
    return { slugs };
  });

  parityTest('listPages filters by type, tag, prefix and limit', { methods: ['listPages', 'addTag'] }, async (engine) => {
    await seed(engine, [
      ['people/alice-example', ALICE],
      ['people/charlie-example', { ...ALICE, title: 'Charlie Example', frontmatter: {} }],
      ['companies/acme-example', ACME],
      ['notes/weekly', NOTE],
    ]);
    await engine.addTag('companies/acme-example', 'portfolio');
    const byType = sorted((await engine.listPages({ type: 'person' })).map((p) => p.slug));
    expect(byType).toEqual(['people/alice-example', 'people/charlie-example']);
    const byTag = (await engine.listPages({ tag: 'portfolio' })).map((p) => p.slug);
    expect(byTag).toEqual(['companies/acme-example']);
    const byPrefix = sorted((await engine.listPages({ slugPrefix: 'people/' })).map((p) => p.slug));
    expect(byPrefix).toEqual(byType);
    const limited = await engine.listPages({ limit: 2 });
    expect(limited.length).toBe(2);
    return { byType, byTag, byPrefix, limitedCount: limited.length };
  });

  parityTest('resolveSlugs matches exact and partial slugs', { methods: ['resolveSlugs'] }, async (engine) => {
    await seed(engine, [['people/alice-example', ALICE], ['companies/acme-example', ACME], ['notes/weekly', NOTE]]);
    const exact = await engine.resolveSlugs('people/alice-example');
    expect(exact).toEqual(['people/alice-example']);
    const partial = sorted(await engine.resolveSlugs('example'));
    const none = await engine.resolveSlugs('zzz-no-such-page');
    return { exact, partial, none };
  });

  parityTest('addTag, getTags and removeTag keep a set per page', { methods: ['addTag', 'getTags', 'removeTag'] }, async (engine) => {
    await seed(engine, [['companies/acme-example', ACME]]);
    await engine.addTag('companies/acme-example', 'portfolio');
    await engine.addTag('companies/acme-example', 'b2b');
    await engine.addTag('companies/acme-example', 'portfolio');
    const tags = sorted(await engine.getTags('companies/acme-example'));
    expect(tags).toEqual(['b2b', 'portfolio']);
    await engine.removeTag('companies/acme-example', 'b2b');
    const after = await engine.getTags('companies/acme-example');
    expect(after).toEqual(['portfolio']);
    return { tags, after };
  });

  parityTest('pages are scoped per source', { methods: ['putPage', 'getPage', 'getAllSlugs', 'listAllSources'] }, async (engine) => {
    const sources = (await engine.listAllSources()).map((s) => s.id);
    expect(sources).toContain('default');
    await seed(engine, [['people/alice-example', ALICE]]);
    const defaultSlugs = sorted(await engine.getAllSlugs({ sourceId: 'default' }));
    const otherSlugs = sorted(await engine.getAllSlugs({ sourceId: 'no-such-source' }));
    expect(otherSlugs).toEqual([]);
    const scopedMiss = await engine.getPage('people/alice-example', { sourceId: 'no-such-source' });
    expect(scopedMiss).toBeNull();
    return { sources: sorted(sources), defaultSlugs, otherSlugs };
  });
  parityTest(
    'readPageSnapshot and readPageSnapshotsBatch return page, tags and a revision',
    { methods: ['readPageSnapshot', 'readPageSnapshotsBatch'] },
    async (engine) => {
      await seed(engine, [['people/alice-example', ALICE], ['companies/acme-example', ACME]]);
      await engine.addTag('people/alice-example', 'founder');
      const snap = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' });
      expect(snap?.page.slug).toBe('people/alice-example');
      expect(typeof snap?.revision).toBe('string');
      const missing = await engine.readPageSnapshot('people/nobody', { sourceId: 'default' });
      expect(missing).toBeNull();
      const batch = await engine.readPageSnapshotsBatch([
        { slug: 'people/alice-example', sourceId: 'default' },
        { slug: 'people/nobody', sourceId: 'default' },
        { slug: 'companies/acme-example', sourceId: 'default' },
      ]);
      expect(batch.covered).toBe(3);
      const keys = sorted([...batch.snapshots.values()].map((v) => v.page.slug));
      expect(keys).toEqual(['companies/acme-example', 'people/alice-example']);
      const sameRevision = [...batch.snapshots.values()].find((v) => v.page.slug === 'people/alice-example')?.revision === snap?.revision;
      expect(sameRevision).toBe(true);
      await engine.putPage('people/alice-example', { ...ALICE, compiled_truth: 'Alice now runs design.' }, { expectedRevision: snap!.revision });
      const after = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' });
      expect(after?.revision).not.toBe(snap?.revision);
      return { page: view(snap!.page), tags: snap!.tags, withdrawals: snap!.withdrawals, keys, covered: batch.covered, sameRevision };
    },
  );

  parityTest('putPage refuses a stale expectedRevision', { methods: ['putPage', 'readPageSnapshot'] }, async (engine) => {
    await seed(engine, [['people/alice-example', ALICE]]);
    const snap = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' });
    await engine.putPage('people/alice-example', { ...ALICE, compiled_truth: 'first edit' }, { expectedRevision: snap!.revision });
    let code: string | null = null;
    try {
      await engine.putPage('people/alice-example', { ...ALICE, compiled_truth: 'second edit' }, { expectedRevision: snap!.revision });
    } catch (error) {
      code = (error as { code?: string }).code ?? 'threw';
    }
    expect(code).toBe('revision_conflict');
    const read = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' });
    expect(read?.page.compiled_truth).toBe('first edit');
    return { code, body: read?.page.compiled_truth };
  });

  parityTest('lockPageKeys holds keys inside a transaction', { methods: ['lockPageKeys', 'transaction'] }, async (engine) => {
    await seed(engine, [['people/alice-example', ALICE]]);
    const result = await engine.transaction(async (tx) => {
      await tx.lockPageKeys([{ sourceId: 'default', slug: 'people/alice-example' }, { sourceId: 'default', slug: 'people/absent' }]);
      return (await tx.getPage('people/alice-example'))?.title ?? null;
    });
    // The recorded call must be on the handle too: lock nothing outside a transaction is a refusal.
    let outside: string | null = null;
    try {
      await engine.lockPageKeys([{ sourceId: 'default', slug: 'people/alice-example' }]);
      outside = 'ok';
    } catch {
      outside = 'refused';
    }
    expect(result).toBe('Alice Example');
    return { result, outside };
  });

  parityTest(
    'findDuplicatePage(s) match by content hash or frontmatter id, never the page itself',
    { methods: ['findDuplicatePage', 'findDuplicatePages'] },
    async (engine) => {
      const a = await engine.putPage('notes/a', { ...NOTE, frontmatter: { id: 'ext-1' } });
      await engine.putPage('notes/b', { ...NOTE, title: 'Other', compiled_truth: 'different body' });
      const byHash = await engine.findDuplicatePage!('default', { hash: a.content_hash! });
      expect(byHash?.slug).toBe('notes/a');
      const self = await engine.findDuplicatePage!('default', { hash: a.content_hash!, excludeSlug: 'notes/a' });
      expect(self).toBeNull();
      const byId = await engine.findDuplicatePage!('default', { hash: 'no-such-hash', frontmatterId: 'ext-1' });
      expect(byId?.slug).toBe('notes/a');
      const many = await engine.findDuplicatePages!('default', [
        { hash: a.content_hash! },
        { hash: 'no-such-hash' },
        { hash: 'no-such-hash', frontmatterId: 'ext-1', excludeSlug: 'notes/a' },
      ]);
      expect(many.map((m) => m?.slug ?? null)).toEqual(['notes/a', null, null]);
      return { byHash: byHash?.slug, self, byId: byId?.slug, many: many.map((m) => m?.slug ?? null) };
    },
  );

  parityTest('deletePages and softDeletePages report only real transitions', { methods: ['deletePages', 'softDeletePages', 'getAllSlugs'] }, async (engine) => {
    await seed(engine, [['notes/a', NOTE], ['notes/b', NOTE], ['notes/c', NOTE], ['notes/d', NOTE]]);
    const soft = sorted(await engine.softDeletePages(['notes/a', 'notes/b', 'notes/missing'], { sourceId: 'default' }));
    expect(soft).toEqual(['notes/a', 'notes/b']);
    const softAgain = await engine.softDeletePages(['notes/a'], { sourceId: 'default' });
    expect(softAgain).toEqual([]);
    const softEmpty = await engine.softDeletePages([], { sourceId: 'default' });
    const hard = sorted(await engine.deletePages(['notes/a', 'notes/c', 'notes/missing'], { sourceId: 'default' }));
    expect(hard).toEqual(['notes/a', 'notes/c']);
    const remaining = sorted(await engine.getAllSlugs());
    return { soft, softAgain, softEmpty, hard, remaining };
  });

  parityTest('purgeDeletedPages only purges tombstones past the cutoff', { methods: ['purgeDeletedPages', 'softDeletePage'] }, async (engine) => {
    await seed(engine, [['notes/a', NOTE], ['notes/b', NOTE]]);
    await engine.softDeletePage('notes/a');
    const notYet = await engine.purgeDeletedPages(72);
    expect(notYet.count).toBe(0);
    const dry = await engine.purgeDeletedPages(0, { dryRun: true });
    expect(dry.slugs).toEqual(['notes/a']);
    const stillThere = (await engine.getPage('notes/a', { includeDeleted: true }))?.slug ?? null;
    const real = await engine.purgeDeletedPages(0);
    expect(real.slugs).toEqual(['notes/a']);
    const gone = await engine.getPage('notes/a', { includeDeleted: true });
    expect(gone).toBeNull();
    return {
      notYet: { slugs: notYet.slugs, count: notYet.count },
      dry: { slugs: dry.slugs, count: dry.count, pages: dry.pages?.map((p) => ({ slug: p.slug, source_id: p.source_id })) },
      stillThere,
      real: { slugs: real.slugs, count: real.count },
    };
  });

  parityTest('resolveSlugsByPaths maps stored source paths to slugs', { methods: ['resolveSlugsByPaths'] }, async (engine) => {
    await seed(engine, [['notes/a', { ...NOTE, source_path: 'Notes/A File.md' }], ['notes/b', NOTE]]);
    const empty = await engine.resolveSlugsByPaths([], { sourceId: 'default' });
    expect(empty.size).toBe(0);
    const found = await engine.resolveSlugsByPaths(['Notes/A File.md', 'notes/zzz.md'], { sourceId: 'default' });
    expect([...found]).toEqual([['Notes/A File.md', 'notes/a']]);
    const otherSource = await engine.resolveSlugsByPaths(['Notes/A File.md'], { sourceId: 'no-such-source' });
    expect(otherSource.size).toBe(0);
    return { empty: [...empty], found: [...found], otherSource: [...otherSource] };
  });

  parityTest('findPages matches name, prefix and glob patterns', { methods: ['findPages'] }, async (engine) => {
    await seed(engine, [['people/alice-example', ALICE], ['people/charlie-example', { ...ALICE, title: 'Charlie Example' }], ['companies/acme-example', ACME]]);
    const run = async (raw: string, types?: string[]) => {
      const found = await engine.findPages({ pattern: parseFindPattern(raw), limit: 10, types, excludeSlugPrefixes: [] });
      return { total: found.total, rows: sorted(found.rows.map((r) => `${r.source_id}:${r.slug}:${r.type}`)) };
    };
    const name = await run('alice');
    expect(name.rows).toEqual(['default:people/alice-example:person']);
    const prefix = await run('people/');
    expect(prefix.total).toBe(2);
    const glob = await run('*example', ['company']);
    expect(glob.rows).toEqual(['default:companies/acme-example:company']);
    return { name, prefix, glob };
  });

  parityTest('countPagesBy counts live pages per source and type', { methods: ['countPagesBy'] }, async (engine) => {
    await seed(engine, [['people/alice-example', ALICE], ['people/charlie-example', ALICE], ['companies/acme-example', ACME], ['notes/a', NOTE]]);
    await engine.softDeletePage('notes/a');
    const plain = await engine.countPagesBy({});
    const grouped = await engine.countPagesBy({}, (types) => types.map((t) => (t === 'person' ? 'people' : 'other')));
    expect(plain.total).toEqual({ pages: 3, distinct_slugs: 3 });
    return {
      bySourceType: sorted(plain.bySourceType, (r) => `${r.source_id}:${r.type}`),
      total: plain.total,
      byTypeGroup: sorted(grouped.byTypeGroup, (r) => r.group),
    };
  });

  parityTest('listAllPageRefs lists every (source, slug) pair in order', { methods: ['listAllPageRefs'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await seed(engine, [['notes/b', NOTE], ['notes/a', NOTE]]);
    await seed(engine, [['notes/a', NOTE]], { sourceId: 'work' });
    const refs = (await engine.listAllPageRefs()).map((r) => ({ source_id: r.source_id, slug: r.slug, dated: r.updated_at instanceof Date }));
    expect(refs.map((r) => `${r.source_id}:${r.slug}`)).toEqual(['default:notes/a', 'default:notes/b', 'work:notes/a']);
    return refs;
  });

  parityTest('listAllSources and updateSourceConfig merge config', { methods: ['listAllSources', 'updateSourceConfig'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { keep: 1 });
    const updated = await engine.updateSourceConfig('work', { last_full_cycle_at: '2026-11-01T00:00:00Z' });
    expect(updated).toBe(true);
    const unknown = await engine.updateSourceConfig('no-such-source', { a: 1 });
    expect(unknown).toBe(false);
    const work = (await engine.listAllSources()).find((s) => s.id === 'work');
    expect(work?.config).toMatchObject({ keep: 1, last_full_cycle_at: '2026-11-01T00:00:00Z' });
    const ids = sorted((await engine.listAllSources()).map((s) => s.id));
    const localOnly = (await engine.listAllSources({ localPathOnly: true })).map((s) => s.id);
    return { ids, config: work?.config, localOnly };
  });

  parityTest('same slug in two sources stays separate', { methods: ['putPage', 'getPage', 'deletePage', 'resolveSlugs'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await engine.putPage('notes/a', NOTE);
    await engine.putPage('notes/a', { ...NOTE, title: 'Work note' }, { sourceId: 'work' });
    const home = await engine.getPage('notes/a', { sourceId: 'default' });
    const work = await engine.getPage('notes/a', { sourceId: 'work' });
    expect(home?.title).toBe('Weekly note');
    expect(work?.title).toBe('Work note');
    const scoped = await engine.resolveSlugs('notes/a', { sourceId: 'work' });
    await engine.deletePage('notes/a', { sourceId: 'work' });
    const afterDelete = { home: (await engine.getPage('notes/a', { sourceId: 'default' }))?.title ?? null, work: await engine.getPage('notes/a', { sourceId: 'work' }) };
    expect(afterDelete).toEqual({ home: 'Weekly note', work: null });
    return { scoped, afterDelete };
  });

  parityTest('listPrefixSampledPages and listCorpusSample sample live pages', { methods: ['listPrefixSampledPages', 'listCorpusSample'] }, async (engine) => {
    await seed(engine, [
      ['wiki/vc/one', NOTE], ['wiki/vc/two', NOTE], ['wiki/bio/one', NOTE], ['notes/a', NOTE],
    ]);
    await engine.softDeletePage('wiki/vc/two');
    const prefixed = await engine.listPrefixSampledPages({ prefixes: ['wiki/vc', 'wiki/bio'] });
    const prefixedView = sorted(prefixed.map((r) => `${r.prefix}:${r.slug}:${r.connection_count}`));
    expect(prefixedView).toEqual(['wiki/bio:wiki/bio/one:0', 'wiki/vc:wiki/vc/one:0']);
    const sample = await engine.listCorpusSample({ n: 10, excludeSlugs: ['notes/a'], seed: 7 });
    const sampleSlugs = sorted(sample.map((r) => r.slug));
    expect(sampleSlugs).toEqual(['wiki/bio/one', 'wiki/vc/one']);
    return { prefixedView, sampleSlugs };
  });
});
