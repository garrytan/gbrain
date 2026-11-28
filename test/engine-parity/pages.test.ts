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
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import { normalizeLoweredClaim } from '../../src/core/facts/withdrawal-schema.ts';
import { pageSnapshotKey } from '../../src/core/page-snapshot-batch.ts';
import type { PageSnapshot } from '../../src/core/page-state/types.ts';
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

  parityTest('putPage records source_path and refuses a second live page of the same file',
    { methods: ['putPage', 'getPage', 'softDeletePage', 'restorePage', 'deletePage'] }, async (engine, backend) => {
      const attempt = async (run: () => Promise<unknown>) => {
        try {
          await run();
          return 'ok';
        } catch (error) {
          const e = error as { code?: string; detail?: string; message?: string };
          return { code: e.code ?? 'threw', detail: e.detail ?? null, message: e.message ?? null };
        }
      };
      await engine.putPage('notes/a', { ...NOTE, source_path: 'notes/a.md' });
      const recorded = (await engine.getPage('notes/a'))?.source_path ?? null;
      const second = await attempt(() => engine.putPage('notes/b', { ...NOTE, source_path: 'notes/a.md' }));
      const secondStored = await engine.getPage('notes/b');
      // Writing the page again without a path keeps its path.
      await engine.putPage('notes/a', { ...NOTE, compiled_truth: 'Edited.' });
      const kept = (await engine.getPage('notes/a'))?.source_path ?? null;
      // Another source may record the same path.
      await createSource(engine, backend, 'work');
      const otherSource = await attempt(() => engine.putPage('notes/b', { ...NOTE, source_path: 'notes/a.md' }, { sourceId: 'work' }));
      // A soft-deleted page frees the path; reviving it while another page holds the path is refused.
      await engine.softDeletePage('notes/a');
      const afterDelete = await attempt(() => engine.putPage('notes/b', { ...NOTE, source_path: 'notes/a.md' }));
      const restore = await attempt(() => engine.restorePage('notes/a'));
      const revive = await attempt(() => engine.putPage('notes/a', NOTE));
      const tombstone = (await engine.getPage('notes/a', { includeDeleted: true }))?.deleted_at != null;
      await engine.deletePage('notes/b');
      const restoredOnceFree = await attempt(() => engine.restorePage('notes/a'));
      const final = (await engine.getPage('notes/a'))?.source_path ?? null;
      expect(recorded).toBe('notes/a.md');
      expect(second).toMatchObject({ code: 'page_identity_changed', detail: 'origin_already_claimed' });
      expect(secondStored).toBeNull();
      expect(restore).toMatchObject({ code: 'page_identity_changed' });
      expect(final).toBe('notes/a.md');
      return { recorded, second, secondStored, kept, otherSource, afterDelete, restore, revive, tombstone, restoredOnceFree, final };
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

  // #9823 post-land finding 1: on the Rust engine an age of NaN read as 0 hours and hard-deleted every tombstone, and the
  // SQL engines clamped a negative age to 0 the same way. Every engine now refuses an age that is NaN, negative or not
  // finite with the same typed error (PurgeAgeError, code invalid_argument), before it previews or deletes anything.
  parityTest('purgeDeletedPages refuses an age that is NaN, negative or not finite, and deletes nothing', { methods: ['purgeDeletedPages', 'softDeletePage'] }, async (engine) => {
    await seed(engine, [['notes/a', NOTE], ['notes/b', NOTE]]);
    await engine.softDeletePage('notes/a');
    await engine.softDeletePage('notes/b');
    const refusals: Array<{ hours: string; dryRun: boolean; name: string; code: unknown }> = [];
    for (const hours of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -72, -0.5]) {
      for (const dryRun of [false, true]) {
        const error = await engine.purgeDeletedPages(hours, { dryRun }).then(() => null, (e: unknown) => e as Error & { code?: unknown });
        expect(error).not.toBeNull();
        refusals.push({ hours: String(hours), dryRun, name: error!.name, code: error!.code });
      }
    }
    expect(refusals.every((r) => r.name === 'PurgeAgeError' && r.code === 'invalid_argument')).toBe(true);
    const tombstones = await Promise.all(['notes/a', 'notes/b'].map(async (slug) => (await engine.getPage(slug, { includeDeleted: true }))?.slug ?? null));
    expect(tombstones).toEqual(['notes/a', 'notes/b']);
    return { refusals, tombstones };
  });

  // `purgeDeletedPages(0)` takes tombstones strictly older than the statement clock, and PGLite's clock can stamp the
  // last soft delete with the same instant as the next statement. Waiting a few milliseconds moves the clock past it.
  const tombstonesSettle = () => new Promise((resolve) => setTimeout(resolve, 5));

  // The retirement holds (src/core/persistence/{atom,derived}-retirement-hold.ts). Neither arm can stand a tombstone days
  // in the past here, so every stamped page is inside its window; the store unit tests in
  // rust/crates/gbrain-store/src/page_ops.rs cover the windows closing and the atom "still restorable" rules.
  parityTest(
    'purgeDeletedPages keeps retired pages inside their hold windows',
    { methods: ['purgeDeletedPages', 'softDeletePage', 'setConfig'] },
    async (engine) => {
      const atom: PageInput = {
        type: 'atom' as PageInput['type'], title: 'An atom', compiled_truth: 'A claim.', timeline: '',
        frontmatter: { retired_by: 'managed-reextract', source_slug: 'notes/origin', source_hash: 'pending:h1', retired_at: '2026-01-01' },
      };
      await seed(engine, [
        ['notes/origin', NOTE],
        ['atoms/held', atom],
        ['notes/derived', { ...NOTE, frontmatter: { retired_by: 'extract-atoms' } }],
        ['notes/chronicle', { ...NOTE, frontmatter: { retired_by: 'life-chronicle' } }],
        ['notes/plain', NOTE],
        ['notes/other', { ...NOTE, frontmatter: { retired_by: 'someone-else' } }],
      ]);
      for (const slug of ['atoms/held', 'notes/derived', 'notes/chronicle', 'notes/plain', 'notes/other']) await engine.softDeletePage(slug);
      await tombstonesSettle();
      const dryRuns: Record<string, string[]> = {};
      for (const restoreDays of ['unset', '3', '365', 'abc', '2']) {
        if (restoreDays !== 'unset') await engine.setConfig('generations.restore_days', restoreDays);
        const dry = await engine.purgeDeletedPages(0, { dryRun: true });
        expect(dry.count).toBe(dry.slugs.length);
        dryRuns[restoreDays] = dry.slugs;
      }
      for (const slugs of Object.values(dryRuns)) expect(sorted(slugs)).toEqual(['notes/other', 'notes/plain']);
      const real = await engine.purgeDeletedPages(0);
      const purged = sorted(real.slugs);
      expect(purged).toEqual(['notes/other', 'notes/plain']);
      const kept: string[] = [];
      for (const slug of ['atoms/held', 'notes/derived', 'notes/chronicle', 'notes/origin']) {
        if (await engine.getPage(slug, { includeDeleted: true })) kept.push(slug);
      }
      expect(kept).toEqual(['atoms/held', 'notes/derived', 'notes/chronicle', 'notes/origin']);
      const again = await engine.purgeDeletedPages(0, { dryRun: true });
      return { dryRuns: Object.fromEntries(Object.entries(dryRuns).map(([k, v]) => [k, sorted(v)])), purged, count: real.count, kept, again: again.slugs };
    },
  );

  parityTest('purgeDeletedPages skips excludeIds and treats an empty list as no filter', { methods: ['purgeDeletedPages', 'softDeletePage'] }, async (engine) => {
    await seed(engine, [['notes/a', NOTE], ['notes/b', NOTE], ['notes/c', NOTE]]);
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) await engine.softDeletePage(slug);
    await tombstonesSettle();
    const idOf = async (slug: string) => (await engine.getPage(slug, { includeDeleted: true }))!.id;
    const excludeIds = [await idOf('notes/b'), 987654321];
    const dry = await engine.purgeDeletedPages(0, { dryRun: true, excludeIds });
    const dryEmpty = await engine.purgeDeletedPages(0, { dryRun: true, excludeIds: [] });
    const real = await engine.purgeDeletedPages(0, { excludeIds });
    expect(sorted(real.slugs)).toEqual(['notes/a', 'notes/c']);
    const rest = await engine.purgeDeletedPages(0, { excludeIds: [] });
    expect(rest.slugs).toEqual(['notes/b']);
    return {
      dry: sorted(dry.slugs),
      dryPages: sorted((dry.pages ?? []).map((p) => `${p.source_id}:${p.slug}:${p.deleted_at instanceof Date}`)),
      dryEmpty: sorted(dryEmpty.slugs),
      real: sorted(real.slugs),
      realHasPages: 'pages' in real && real.pages !== undefined,
      rest: rest.slugs,
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
  parityTest(
    'listEntityKeyRows: live, unretired pages of the types, only the named keys, keyset-paged',
    { methods: ['putPage', 'softDeletePage', 'listEntityKeyRows'] },
    async (engine) => {
      await seed(engine, [
        ['people/alice-example', { ...ALICE, frontmatter: { email: 'alice@example.com', role: 'pm', emails: ['a@example.com'] } }],
        ['people/bob-example', { type: 'person', title: 'Bob Example', compiled_truth: 'Bob.', frontmatter: { merged_into: 'people/alice-example', email: 'b@example.com' } }],
        ['people/carol-example', { type: 'person', title: 'Carol Example', compiled_truth: 'Carol.', frontmatter: {} }],
        ['companies/acme-example', ACME],
        ['notes/acme-example', { type: 'note', title: 'Acme note', compiled_truth: 'Note.', frontmatter: { email: 'n@example.com' } }],
      ]);
      await engine.softDeletePage('people/carol-example');
      const args = { types: ['company', 'person'], keys: ['email', 'emails'] };
      const first = await engine.listEntityKeyRows({ ...args, limit: 1 });
      const rest = await engine.listEntityKeyRows({ ...args, after: { source_id: first[0]!.source_id, slug: first[0]!.slug }, limit: 10 });
      expect([...first, ...rest].map((r) => r.slug)).toEqual(['companies/acme-example', 'people/alice-example']);
      expect(rest[0]!.keys).toEqual({ email: 'alice@example.com', emails: ['a@example.com'] });
      expect([...first, ...rest].every(r => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(r.created_at))).toBe(true);
      const untimed = (rows: typeof first) => rows.map(({ created_at: _at, page_id: _id, generation: _gen, ...r }) => r);
      return { first: untimed(first), rest: untimed(rest) };
    },
  );
  parityTest(
    'listIdentityDecisions / applyIdentityDecisions: decisions by (source, slug), confirmed members linked, missing pages pending',
    { methods: ['putPage', 'applyIdentityDecisions', 'listIdentityDecisions', 'listRestrictedIdentityMembers'] },
    async (engine) => {
      await seed(engine, [['people/alice-example', ALICE], ['people/bob-example', { type: 'person', title: 'Bob Example', compiled_truth: 'Bob.', frontmatter: {} }]]);
      const ref = (slug: string) => ({ source_id: 'default', slug });
      const decision = (decision_id: string, verdict: 'same' | 'different', slugs: string[]) => ({
        decision_id, verdict, members: slugs.map(ref), group_id: `dedupe/${decision_id}`, entity_id: verdict === 'same' ? `dedupe/${decision_id}` : null,
        canonical: verdict === 'same' ? ref(slugs[0]!) : null, decided_by: 'owner', decided_at: '2026-11-18T00:00:00Z', origin: 'database' as const,
        home_source_id: null, git_blob: null,
      });
      const applied = await engine.applyIdentityDecisions({ upsert: [
        decision('0000000000000001', 'same', ['people/alice-example', 'people/bob-example']),
        decision('0000000000000002', 'same', ['people/carol-example', 'people/dan-example']),
        decision('0000000000000003', 'different', ['people/alice-example', 'people/erin-example']),
      ] });
      expect(applied).toEqual({ upserted: 3, removed: 0, linked: 2, unlinked: 0 });
      const read = await engine.listIdentityDecisions();
      expect(read.decisions.map(d => [d.decision_id, d.verdict, d.members.length, d.canonical?.slug ?? null]))
        .toEqual([['0000000000000001', 'same', 2, 'people/alice-example'], ['0000000000000002', 'same', 2, 'people/carol-example'], ['0000000000000003', 'different', 2, null]]);
      expect(read.pending.map(p => [p.decision_id, p.slug, p.reason])).toEqual([['0000000000000002', 'people/carol-example', 'page_missing'], ['0000000000000002', 'people/dan-example', 'page_missing']]);
      expect(await engine.listRestrictedIdentityMembers([])).toEqual([]);
      expect(await engine.listRestrictedIdentityMembers([ref('people/alice-example'), ref('people/carol-example')])).toEqual([]);
      const removed = await engine.applyIdentityDecisions({ remove: ['0000000000000001'] });
      expect(removed).toEqual({ upserted: 0, removed: 1, linked: 0, unlinked: 2 });
      return { applied, decisions: read.decisions.map(d => ({ ...d, decided_at: d.decided_at.slice(0, 10) })), pending: read.pending, removed };
    },
  );

  // A stored withdrawal or purge tombstone is applied to the facts fence of every page read, so a forgotten claim reads
  // struck through ("forgotten: ...") and a purged one is gone. The Rust store keeps the ledger rows; the members apply
  // them (a seeded store, or one whose body mirror failed, holds the raw fence beside its withdrawal).
  parityTest(
    'page reads overlay stored withdrawals and purge tombstones on the facts fence',
    { methods: ['putPage', 'getPage', 'readPageSnapshot', 'readPageSnapshotsBatch'] },
    async (engine, backend) => {
      const fact = (rowNum: number, claim: string, visibility: 'world' | 'private' = 'world'): ParsedFact =>
        ({ rowNum, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true, context: 'met at the offsite' } as ParsedFact);
      const forgotten = 'Alice prefers async standups', everywhere = 'Alice owns the roadmap', purged = 'Alice holds a side project';
      const kept = 'Alice ships on fridays', secret = 'Alice is interviewing elsewhere';
      await engine.putPage('people/alice-example', {
        ...ALICE,
        compiled_truth: `Alice runs product.\n${renderFactsTable([fact(1, forgotten), fact(2, kept), fact(3, purged), fact(4, secret, 'private')])}`,
        timeline: `- 2026-01-02: joined\n${renderFactsTable([fact(1, everywhere)])}`,
      });
      // The Rust engine does not serve these ledger writers, so its arm seeds them in the store, as a seeded brain holds them.
      type Ledger = {
        insertFactWithdrawal(sourceId: string, visibility: string, claim: string, subject: string, at: string | null): Promise<boolean>;
        insertFactPurge(row: { sourceId: string; visibility: string; subject: string; factHash: string; requestId: null; actor: null; reason: null }): Promise<boolean>;
      };
      const ledger: Ledger = backend === 'rust'
        ? (await (engine as unknown as { storeFor(m: string): Promise<{ brain: Ledger }> }).storeFor('getPage')).brain
        : engine as unknown as Ledger;
      const at = '2026-01-15T00:00:00.000Z';
      await ledger.insertFactWithdrawal('default', 'world', forgotten, 'people/alice-example', at);
      await ledger.insertFactWithdrawal('default', 'world', everywhere, '*', at);
      await ledger.insertFactWithdrawal('default', 'private', secret, 'people/alice-example', at);
      const factHash = createHash('sha256').update(normalizeLoweredClaim(purged.toLowerCase())).digest('hex');
      await ledger.insertFactPurge({ sourceId: 'default', visibility: 'world', subject: '*', factHash, requestId: null, actor: null, reason: null });
      const shape = (snapshot: PageSnapshot | null | undefined) => snapshot && {
        page: view(snapshot.page),
        withdrawals: snapshot.withdrawals.map(w => ({ visibility: w.visibility, fact_hash: w.fact_hash, purged: w.purged === true })),
        globalPurges: snapshot.globalPurges ? { count: snapshot.globalPurges.count, world_only: snapshot.globalPurges.world_only } : null,
      };
      const page = await engine.getPage('people/alice-example');
      expect(page?.compiled_truth).toContain('forgotten:');
      expect(page?.compiled_truth).not.toContain(purged);
      const exact = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' });
      const alias = await engine.readPageSnapshot('people/alice-example', { sourceId: 'default', resolveAlias: true });
      const batch = await engine.readPageSnapshotsBatch([{ slug: 'people/alice-example', sourceId: 'default' }]);
      return { page: view(page), exact: shape(exact), alias: shape(alias), batch: shape(batch.snapshots.get(pageSnapshotKey('default', 'people/alice-example'))) };
    },
  );
});
