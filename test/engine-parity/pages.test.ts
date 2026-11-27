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
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../../src/commands/sync.ts';
import { syncIdentityDecisions } from '../../src/core/entities/identity-decisions.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseFindPattern, type FindPagesQuery } from '../../src/core/page-find.ts';
import { QUARANTINE_KEY } from '../../src/core/quarantine.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import type { Page, PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms, pick, sorted } from './harness.ts';
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

  parityTest('lockPageKeys refuses a missing source and a recreated one, and holds a key whose source matches',
    { methods: ['lockPageKeys', 'transaction', 'readSourceIncarnation'] }, async (engine) => {
      await seed(engine, [['people/alice-example', ALICE]]);
      const incarnation = (await engine.readSourceIncarnation('default'))!.incarnation;
      const attempt = async (keys: Array<{ sourceId: string; slug: string; incarnation?: string }>) => {
        try {
          await engine.transaction(async (tx) => { await tx.lockPageKeys(keys); });
          return 'ok';
        } catch (error) {
          const e = error as Error & { sourceId?: string };
          return { name: e.name, message: e.message, ...(e.sourceId !== undefined ? { sourceId: e.sourceId } : {}) };
        }
      };
      // One unhinted key, two unhinted keys, then hinted keys with the stale and the current incarnation.
      const missing = await attempt([{ sourceId: 'no-such-source', slug: 'people/alice-example' }]);
      const missingOfTwo = await attempt([{ sourceId: 'default', slug: 'people/alice-example' }, { sourceId: 'no-such-source', slug: 'notes/a' }]);
      const stale = '00000000-0000-4000-8000-000000000000';
      const recreated = await attempt([{ sourceId: 'default', slug: 'people/alice-example', incarnation: stale }]);
      const matching = await attempt([{ sourceId: 'default', slug: 'people/alice-example', incarnation }, { sourceId: 'default', slug: 'people/absent', incarnation }]);
      expect(missing).toEqual({ name: 'PageSourceMissingError', message: 'Page source does not exist: no-such-source', sourceId: 'no-such-source' });
      expect(missingOfTwo).toEqual(missing);
      expect(recreated).toMatchObject({ name: 'Error', message: 'Page source was recreated: default' });
      expect(matching).toBe('ok');
      return { missing, missingOfTwo, recreated, matching };
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

  // A remote caller's page reads (get_page, list_pages, resolve_slugs, delta) pass excludePrivate: a hidden page reads
  // as missing on every engine, and a scope that names a hidden page first falls through to the next source.
  async function seedPrivate(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'alt');
    const page = (slug: string, frontmatter: Record<string, unknown>, opts?: { sourceId?: string }) =>
      engine.putPage(slug, { type: 'person', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter }, opts);
    await page('people/alice-example', {});
    await page('people/alice-example', { visibility: 'private' }, { sourceId: 'alt' });
    await page('people/private-example', { visibility: 'private' });
    await page('people/readers-example', { readable_by: ['alice-example'] });
    await page('people/team-example', { readable_by: 'group:team-a' });
    await page('people/alias-example', { access: 'Restricted' });
    await page('people/pinned-example', { visibility: 'private', pinned_question: true });
    await page('people/deleted-example', {});
    await engine.softDeletePage('people/deleted-example');
  }
  const PRIVATE_SLUGS = ['people/alice-example', 'people/private-example', 'people/readers-example', 'people/team-example',
    'people/alias-example', 'people/pinned-example', 'people/deleted-example'];

  parityTest(
    'getPage and readPageSnapshot under excludePrivate read a hidden page as missing',
    { methods: ['getPage', 'readPageSnapshot', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await seedPrivate(engine, backend);
      const at = (page: Page | null | undefined) => (page ? `${page.source_id}:${page.slug}` : null);
      const read = async (opts: Parameters<BrainEngine['getPage']>[1]) => {
        const out: Record<string, { get: string | null; snapshot: string | null; tags: string[] | null }> = {};
        for (const slug of PRIVATE_SLUGS) {
          const snapshot = await engine.readPageSnapshot(slug, opts);
          out[slug] = { get: at(await engine.getPage(slug, opts)), snapshot: at(snapshot?.page), tags: snapshot?.tags ?? null };
        }
        return out;
      };
      const open = await read({ excludePrivate: false });
      const hidden = await read({ excludePrivate: true });
      const withDeleted = await read({ excludePrivate: true, includeDeleted: true });
      const altFirst = await read({ excludePrivate: true, sourceIds: ['alt', 'default'] });
      const altOnly = await read({ excludePrivate: true, sourceId: 'alt' });
      expect(open['people/private-example'].get).toBe('default:people/private-example');
      expect(hidden['people/alice-example'].get).toBe('default:people/alice-example');
      for (const slug of PRIVATE_SLUGS.slice(1)) expect(hidden[slug]).toEqual({ get: null, snapshot: null, tags: null });
      expect(withDeleted['people/deleted-example'].get).toBe('default:people/deleted-example');
      expect(altFirst['people/alice-example'].get).toBe('default:people/alice-example');
      expect(altOnly['people/alice-example'].get).toBeNull();
      return { open, hidden, withDeleted, altFirst, altOnly };
    },
  );

  parityTest(
    'listPages under excludePrivate drops hidden pages before the limit',
    { methods: ['listPages', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await seedPrivate(engine, backend);
      const list = async (filters: Parameters<BrainEngine['listPages']>[0]) =>
        (await engine.listPages({ sort: 'slug', ...filters })).map((p) => `${p.source_id}:${p.slug}`);
      const all = await list({});
      const kept = await list({ excludePrivate: true });
      const limited = await list({ excludePrivate: true, limit: 1 });
      const typed = await list({ excludePrivate: true, type: 'person', includeDeleted: true });
      const alt = await list({ excludePrivate: true, sourceId: 'alt' });
      expect(all.length).toBe(7);
      expect(kept).toEqual(['default:people/alice-example']);
      expect(limited).toEqual(kept);
      expect(typed).toEqual(['default:people/alice-example', 'default:people/deleted-example']);
      expect(alt).toEqual([]);
      return { all, kept, limited, typed, alt };
    },
  );

  parityTest(
    'resolveSlugs under excludePrivate answers a visible exact page in scope',
    { methods: ['resolveSlugs', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await seedPrivate(engine, backend);
      const exact = await engine.resolveSlugs('people/alice-example', { excludePrivate: true });
      const scoped = await engine.resolveSlugs('people/alice-example', { excludePrivate: true, sourceIds: ['alt', 'default'] });
      expect(exact).toEqual(['people/alice-example']);
      expect(scoped).toEqual(['people/alice-example']);
      return { exact, scoped };
    },
  );

  parityTest(
    'page reads under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['getPage', 'readPageSnapshot', 'listPages', 'resolveSlugs', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await seedPrivate(engine, backend);
      // Each caller resolves a slug it can read: a name with no visible exact page goes on to trigram matching.
      const read = (access: Parameters<typeof withCallerAccess>[0], resolve: string) => withCallerAccess(access, async () => {
        const got: Record<string, string | null> = {};
        for (const slug of PRIVATE_SLUGS) {
          const page = await engine.getPage(slug, { excludePrivate: true });
          const snapshot = await engine.readPageSnapshot(slug, { excludePrivate: true, sourceIds: ['alt', 'default'] });
          got[slug] = page ? `${page.source_id}:${page.slug}|${snapshot?.page.source_id ?? null}` : null;
        }
        const listed = (await engine.listPages({ sort: 'slug', excludePrivate: true })).map((p) => `${p.source_id}:${p.slug}`);
        const resolved = await engine.resolveSlugs(resolve, { excludePrivate: true });
        return { got, listed, resolved };
      });
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true }, 'people/readers-example');
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true }, 'people/private-example');
      const grantedAlt = await read({ identity: ['member:carol-example'], privateReadableSources: ['alt'], hidePrivate: true }, 'people/alice-example');
      expect(member.got['people/readers-example']).toBe('default:people/readers-example|default');
      expect(member.got['people/team-example']).toBe('default:people/team-example|default');
      expect(member.got['people/private-example']).toBeNull();
      expect(granted.got['people/private-example']).toBe('default:people/private-example|default');
      expect(granted.got['people/pinned-example']).toBeNull();
      expect(granted.got['people/team-example']).toBeNull();
      expect(grantedAlt.got['people/alice-example']).toBe('default:people/alice-example|alt');
      expect(member.resolved).toEqual(['people/readers-example']);
      expect(granted.resolved).toEqual(['people/private-example']);
      return { member, granted, grantedAlt };
    },
  );

  /**
   * Rename aliases (`updateSlug` records old -> new in the source's slug_aliases): `people/old-name` is an alias in
   * default and alt, `people/shadow` is an alias in default and a page in alt, `notes/x` is an alias in default and a
   * soft-deleted page there, `people/secret-old` names a private page, and `people/gone-old` names a page in an
   * archived source.
   */
  async function seedAliases(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'alt');
    await createSource(engine, backend, 'arch');
    const page = (slug: string, frontmatter: Record<string, unknown>, opts?: { sourceId?: string }) =>
      engine.putPage(slug, { type: 'person', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter }, opts);
    const renamed = async (from: string, to: string, frontmatter: Record<string, unknown> = {}, sourceId?: string) => {
      await page(from, frontmatter, sourceId ? { sourceId } : undefined);
      expect(await engine.updateSlug(from, to, sourceId ? { sourceId } : undefined)).toBe(1);
    };
    await renamed('people/old-name', 'people/new-name');
    await renamed('people/old-name', 'people/alt-name', {}, 'alt');
    await renamed('people/shadow', 'people/shadow-new');
    await page('people/shadow', {}, { sourceId: 'alt' });
    await renamed('notes/x', 'notes/x-new');
    await page('notes/x', {});
    await engine.softDeletePage('notes/x');
    await renamed('people/secret-old', 'people/secret-new', { visibility: 'private' });
    await renamed('people/gone-old', 'people/gone-new', {}, 'arch');
    await archiveSource(engine, backend, 'arch');
  }
  const ALIAS_SLUGS = ['people/old-name', 'people/new-name', 'people/shadow', 'notes/x', 'people/secret-old', 'people/gone-old'];

  /** Each alias slug read under `opts`: `source:slug` of the page read, `null`, or `error:PageSnapshotAmbiguousError`. */
  async function aliasReads(engine: BrainEngine, opts: Parameters<BrainEngine['readPageSnapshot']>[1]) {
    const out: Record<string, { snapshot: string | null; get: string | null }> = {};
    const at = (page: Page | null | undefined) => (page ? `${page.source_id}:${page.slug}` : null);
    const attempt = async (read: () => Promise<Page | null | undefined>) => {
      try {
        return at(await read());
      } catch (error) {
        // Only the ambiguity is an answer; any other error (a typed refusal on the Rust arm) propagates.
        if ((error as Error).name !== 'PageSnapshotAmbiguousError') throw error;
        return `error:${(error as Error).name}`;
      }
    };
    for (const slug of ALIAS_SLUGS) {
      out[slug] = {
        snapshot: await attempt(async () => (await engine.readPageSnapshot(slug, opts))?.page),
        get: await attempt(() => engine.getPage(slug, opts)),
      };
    }
    return out;
  }

  parityTest(
    'readPageSnapshot under resolveAlias follows a rename alias, an exact page outranks it, and a private target stays hidden',
    { methods: ['putPage', 'updateSlug', 'softDeletePage', 'readPageSnapshot', 'getPage'] },
    async (engine, backend) => {
      await seedAliases(engine, backend);
      const out = {
        plain: await aliasReads(engine, { resolveAlias: true }),
        altFirst: await aliasReads(engine, { resolveAlias: true, sourceIds: ['alt', 'default'] }),
        alt: await aliasReads(engine, { resolveAlias: true, sourceId: 'alt' }),
        deleted: await aliasReads(engine, { resolveAlias: true, includeDeleted: true }),
        hidden: await aliasReads(engine, { resolveAlias: true, excludePrivate: true }),
        noAlias: await aliasReads(engine, {}),
      };
      expect(out.plain['people/old-name']!.snapshot).toBe('default:people/new-name');
      expect(out.altFirst['people/old-name']!.snapshot).toBe('alt:people/alt-name');
      expect(out.plain['people/shadow']!.snapshot).toBe('alt:people/shadow');
      expect(out.plain['people/secret-old']!.snapshot).toBe('default:people/secret-new');
      expect(out.hidden['people/secret-old']!.snapshot).toBeNull();
      expect(out.noAlias['people/old-name']!.snapshot).toBeNull();
      return out;
    },
  );

  parityTest(
    "readPageSnapshot under fetch's options refuses an ambiguous alias, skips an archived source and keeps an exact identity",
    { methods: ['putPage', 'updateSlug', 'softDeletePage', 'readPageSnapshot', 'getPage'] },
    async (engine, backend) => {
      await seedAliases(engine, backend);
      const fetchOpts = { resolveAlias: true, requireLiveSource: true, preserveExactIdentity: true } as const;
      const out = {
        unambiguous: await aliasReads(engine, { resolveAlias: true, requireUnambiguous: true }),
        unambiguousAlt: await aliasReads(engine, { resolveAlias: true, requireUnambiguous: true, sourceId: 'alt' }),
        unambiguousExact: await aliasReads(engine, { requireUnambiguous: true }),
        live: await aliasReads(engine, { resolveAlias: true, requireLiveSource: true }),
        fetch: await aliasReads(engine, { ...fetchOpts, requireUnambiguous: true, excludePrivate: true }),
        fetchScoped: await aliasReads(engine, { ...fetchOpts, sourceId: 'default', excludePrivate: true }),
        archivedDeleted: await aliasReads(engine, { resolveAlias: true, includeDeleted: true, sourceId: 'arch' }),
      };
      expect(out.unambiguous['people/old-name']!.snapshot).toBe('error:PageSnapshotAmbiguousError');
      expect(out.unambiguousAlt['people/old-name']!.snapshot).toBe('alt:people/alt-name');
      expect(out.fetch['people/secret-old']!.snapshot).toBeNull();
      return out;
    },
  );

  parityTest(
    'listPages under listColumnsOnly returns the list columns with a blank body, and hides private pages under excludePrivate',
    { methods: ['listPages', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await seedPrivate(engine, backend);
      // The list projection: which fields a row carries, and the values that do not depend on the arm's clock or ids.
      const row = (page: Page) => ({
        fields: Object.keys(page).filter((key) => (page as unknown as Record<string, unknown>)[key] !== undefined).sort(),
        at: `${page.source_id}:${page.slug}`,
        ...pick(page, ['type', 'title', 'compiled_truth', 'timeline', 'frontmatter', 'effective_date', 'effective_date_source']),
        deleted: page.deleted_at != null,
      });
      const list = async (filters: Parameters<BrainEngine['listPages']>[0]) => (await engine.listPages(filters)).map(row);
      const out = {
        all: await list({ listColumnsOnly: true, sort: 'slug', includeDeleted: true }),
        hidden: await list({ listColumnsOnly: true, sort: 'slug', excludePrivate: true, limit: 3 }),
        typed: await list({ listColumnsOnly: true, type: 'person', sort: 'slug', sourceId: 'alt' }),
        // omitBodies (master #10302): the list columns with the frontmatter kept.
        bodiesOmitted: await list({ omitBodies: true, sort: 'slug', includeDeleted: true }),
      };
      expect(out.bodiesOmitted.every((page) => page.compiled_truth === '' && page.timeline === '')).toBe(true);
      expect(out.bodiesOmitted.some((page) => Object.keys(page.frontmatter as object).length > 0)).toBe(true);
      expect(out.all.every((page) => page.compiled_truth === '' && page.timeline === '')).toBe(true);
      expect(out.hidden.map((page) => page.at)).not.toContain('default:people/private-example');
      return out;
    },
  );

  parityTest(
    'findPages under untrusted hides private and quarantined pages, and applies a caller\'s private-readable grant',
    { methods: ['findPages', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await seedPrivate(engine, backend);
      await engine.putPage('people/quarantined-example', {
        type: 'person', title: 'people/quarantined-example', compiled_truth: 'quarantined body', timeline: '',
        frontmatter: { [QUARANTINE_KEY]: { reason: 'parity' } },
      });
      const find = async (untrusted?: FindPagesQuery['untrusted'], sourceIds?: string[]) => {
        const found = await engine.findPages({ pattern: parseFindPattern('people/*'), limit: 3, untrusted, excludeSlugPrefixes: [], ...(sourceIds ? { sourceIds } : {}) });
        return { total: found.total, rows: found.rows.map((r) => `${r.source_id}:${r.slug}:${r.type}:${r.title}`) };
      };
      const all = async (untrusted?: FindPagesQuery['untrusted']) => (await engine.findPages({
        pattern: parseFindPattern('people/*'), limit: 50, untrusted, excludeSlugPrefixes: [],
      })).rows.map((r) => `${r.source_id}:${r.slug}`);
      const out = {
        trusted: await all(),
        empty: await all({}),
        hidden: await all({ excludePrivate: true }),
        hiddenPage: await find({ excludePrivate: true }),
        hiddenAlt: await find({ excludePrivate: true }, ['alt']),
        granted: await withCallerAccess({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true },
          () => all({ excludePrivate: true })),
        member: await withCallerAccess({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true },
          () => all({ excludePrivate: true })),
      };
      expect(out.trusted).toContain('default:people/quarantined-example');
      expect(out.empty).not.toContain('default:people/quarantined-example');
      expect(out.hidden).not.toContain('default:people/private-example');
      expect(out.hidden).not.toContain('alt:people/alice-example');
      expect(out.granted).toContain('default:people/private-example');
      expect(out.member).toContain('default:people/readers-example');
      return out;
    },
  );

  parityTest(
    'page reads under excludePrivate for a remote caller on a brain with no access restrictions hide pages that name readers',
    { methods: ['getPage', 'readPageSnapshot', 'listPages', 'resolveSlugs', 'findPages', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await seedPrivate(engine, backend);
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess({ ...access, hidePrivate: true, restricted: false }, async () => {
        const got: Record<string, string | null> = {};
        for (const slug of PRIVATE_SLUGS) {
          const page = await engine.getPage(slug, { excludePrivate: true });
          const snapshot = await engine.readPageSnapshot(slug, { excludePrivate: true, sourceIds: ['alt', 'default'] });
          got[slug] = `${page ? `${page.source_id}:${page.slug}` : null}|${snapshot?.page.source_id ?? null}`;
        }
        const listed = (await engine.listPages({ sort: 'slug', excludePrivate: true, listColumnsOnly: true })).map((p) => `${p.source_id}:${p.slug}`);
        const resolved = await engine.resolveSlugs('people/alice-example', { excludePrivate: true });
        // resolve_slugs passes the caller's whole read policy; only the source scope and excludePrivate apply.
        const resolvedUnderPolicy = await engine.resolveSlugs('people/alice-example',
          { excludePrivate: true, requireSafeChunks: true, takesHoldersAllowList: ['world'], minTrust: 'operator_curated', suppressFlagged: true } as Parameters<BrainEngine['resolveSlugs']>[1]);
        expect(resolvedUnderPolicy).toEqual(resolved);
        const found = (await engine.findPages({ pattern: parseFindPattern('people/*'), limit: 50, excludeSlugPrefixes: [], untrusted: { excludePrivate: true } }))
          .rows.map((r) => `${r.source_id}:${r.slug}`);
        return { got, listed, resolved, found };
      });
      const anonymous = await read({ identity: [] });
      const member = await read({ identity: ['member:alice-example', 'group:team-a'] });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'] });
      for (const out of [anonymous, member, granted]) {
        expect(out.listed).not.toContain('default:people/readers-example');
        expect(out.found).not.toContain('default:people/team-example');
        expect(out.listed).not.toContain('default:people/pinned-example');
      }
      expect(anonymous.listed).not.toContain('default:people/private-example');
      expect(granted.listed).toContain('default:people/private-example');
      return { anonymous, member, granted };
    },
  );

  parityTest(
    "get_page's read path: the purge check answers for the page an alias, a hidden page or a reader-named page resolves to",
    { methods: ['putPage', 'updateSlug', 'softDeletePage', 'readPageSnapshot', 'pageAwaitsRederive'] },
    async (engine, backend) => {
      await seedAliases(engine, backend);
      await engine.putPage('people/readers-example',
        { type: 'person', title: 'readers', compiled_truth: 'readers body', timeline: '', frontmatter: { readable_by: ['alice-example'] } });
      const slugs = [...ALIAS_SLUGS, 'people/readers-example'];
      // The options get_page passes (src/core/ops/pages.ts), then the purge check pageTrustForRead makes.
      const read = (access: Parameters<typeof withCallerAccess>[0] | null) => {
        const run = async () => {
          const got: Record<string, { page: string | null; awaits: boolean | null }> = {};
          for (const slug of slugs) {
            const snapshot = await engine.readPageSnapshot(slug, { resolveAlias: true, excludePrivate: access !== null });
            const page = snapshot?.page ?? null;
            got[slug] = { page: page ? `${page.source_id}:${page.slug}` : null, awaits: page ? await engine.pageAwaitsRederive(Number(page.id)) : null };
          }
          return got;
        };
        return access === null ? run() : withCallerAccess({ ...access, hidePrivate: true }, run);
      };
      const out = {
        trusted: await read(null),
        open: await read({ identity: [], restricted: false }),
        member: await read({ identity: ['member:alice-example'] }),
        granted: await read({ identity: ['member:bob-example'], privateReadableSources: ['default'] }),
      };
      expect(out.trusted['people/old-name']).toEqual({ page: 'default:people/new-name', awaits: false });
      expect(out.trusted['people/secret-old']!.page).toBe('default:people/secret-new');
      expect(out.open['people/secret-old']).toEqual({ page: null, awaits: null });
      expect(out.open['people/readers-example']).toEqual({ page: null, awaits: null });
      expect(out.member['people/old-name']).toEqual({ page: 'default:people/new-name', awaits: false });
      return out;
    },
  );

  /** Pages for resolveSlugs' fuzzy half: near titles, a private and a reader-named look-alike, a deleted one, a tie. */
  async function seedFuzzy(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'alt');
    const page = (slug: string, title: string, frontmatter: Record<string, unknown> = {}, sourceId?: string) =>
      engine.putPage(slug, { type: 'person', title, compiled_truth: `${title} body`, timeline: '', frontmatter }, sourceId ? { sourceId } : undefined);
    await page('people/alice-example', 'Alice Example');
    await page('people/alicia-example', 'Alicia Example');
    await page('people/alina-other', 'Alina Other');
    await page('companies/acme-example', 'Acme Example');
    await page('people/secret-alice', 'Alice Example', { visibility: 'private' });
    await page('people/readers-alice', 'Alice Example', { readable_by: ['alice-example'] });
    await page('people/deleted-alice', 'Alice Example');
    await engine.softDeletePage('people/deleted-alice');
    // Written in reverse slug order, so a store that keeps insertion order is not sorted by accident.
    await page('people/twin-c', 'Twin Title');
    await page('people/twin-b', 'Twin Title');
    await page('people/twin-a', 'Twin Title', {}, 'alt');
  }
  const FUZZY_PARTIALS = ['people/alice-example', 'People/Alice-Example', 'people/ali', 'Alise Exampel', 'people/ali_e',
    'Twin Title', 'Alice Example', 'zzzz-nothing', ''];

  parityTest(
    "resolveSlugs' fuzzy half: exact first, slug ILIKE, a title typo, ties by slug, hidden pages stay hidden",
    { methods: ['putPage', 'softDeletePage', 'resolveSlugs'] },
    async (engine, backend) => {
      await seedFuzzy(engine, backend);
      const all = async (opts?: Parameters<BrainEngine['resolveSlugs']>[1]) => {
        const got: Record<string, string[]> = {};
        for (const partial of FUZZY_PARTIALS) got[partial] = await engine.resolveSlugs(partial, opts);
        return got;
      };
      const trusted = await all();
      const alt = await all({ sourceId: 'alt' });
      const both = await all({ sourceIds: ['alt', 'default'] });
      const open = await withCallerAccess({ identity: [], hidePrivate: true, restricted: false }, () => all({ excludePrivate: true }));
      const member = await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => all({ excludePrivate: true }));
      // Exact: a live page with the slug wins outright.
      expect(trusted['people/alice-example']).toEqual(['people/alice-example']);
      // Prefix: the slug contains the partial (ILIKE, so case and `_` follow Postgres).
      expect(trusted['people/ali']).toContain('people/alicia-example');
      expect(trusted['People/Alice-Example']).toContain('people/alice-example');
      expect(trusted['people/ali_e']).toContain('people/alice-example');
      // Typo: no slug contains it; the title trigrams carry it, best first.
      expect(trusted['Alise Exampel'][0]).toBe('people/alice-example');
      // Tie: equal similarity sorts by slug.
      expect(both['Twin Title']).toEqual(['people/twin-a', 'people/twin-b', 'people/twin-c']);
      expect(alt['Twin Title']).toEqual(['people/twin-a']);
      // Hidden: a private page and a reader-named page leave the open caller's list, never a deleted page.
      expect(trusted['Alice Example']).toContain('people/secret-alice');
      expect(open['Alice Example']).not.toContain('people/secret-alice');
      expect(open['Alice Example']).not.toContain('people/readers-alice');
      expect(Object.values(trusted).flat()).not.toContain('people/deleted-alice');
      expect(trusted['zzzz-nothing']).toEqual([]);
      return { trusted, alt, both, open, member };
    },
  );

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

  parityTest(
    'the sync hook links a pending member once its page exists and fills the fingerprints of a bare different decision',
    { methods: ['putPage', 'applyIdentityDecisions', 'listIdentityDecisions', 'listEntityKeyRows', 'listEntityIdentityRows'] },
    async (engine) => {
      // A LinkedIn profile is a strong key, so each page has a fingerprint (duplicates.ts pageFingerprint).
      const person = (title: string, handle: string): PageInput => ({ type: 'person', title, compiled_truth: `${title}.`, frontmatter: { linkedin: `linkedin.com/in/${handle}` } });
      await seed(engine, [['people/alice-example', person('Alice Example', 'alice-example')], ['people/bob-example', person('Bob Example', 'bob-example')]]);
      const ref = (slug: string) => ({ source_id: 'default', slug });
      const base = { decided_by: 'owner', decided_at: '2026-11-18T00:00:00Z', origin: 'database' as const, home_source_id: null, git_blob: null };
      await engine.applyIdentityDecisions({ upsert: [
        { ...base, decision_id: '0000000000000011', verdict: 'same', members: [ref('people/alice-example'), ref('people/carol-example')],
          group_id: 'dedupe/0000000000000011', entity_id: 'dedupe/0000000000000011', canonical: ref('people/alice-example') },
        { ...base, decision_id: '0000000000000012', verdict: 'different', members: [ref('people/alice-example'), ref('people/bob-example')],
          group_id: 'dedupe/0000000000000012', entity_id: null, canonical: null },
      ] });
      const before = (await engine.listIdentityDecisions()).pending.map(p => p.slug);
      await engine.putPage('people/carol-example', person('Carol Example', 'carol-example'));
      // A brain with no decision home: the hook applies the pending members and fills the bare decision's fingerprints.
      await syncIdentityDecisions(engine, 'default');
      const read = await engine.listIdentityDecisions();
      const members = (await engine.listEntityIdentityRows({ entityId: 'dedupe/0000000000000011' })).map(r => r.slug).sort();
      const result = { before, pending: read.pending.map(p => p.slug), members,
        evidence: read.decisions.find(d => d.decision_id === '0000000000000012')?.evidence?.length ?? 0 };
      expect(result).toEqual({ before: ['people/carol-example'], pending: [], members: ['people/alice-example', 'people/carol-example'], evidence: 2 });
      return result;
    },
  );

  // Generation differs by design: Postgres and PGLite return pages.generation, a counter that grows; the Rust store keeps
  // no counter and returns a token from the page's knowledge_revision (rust/docs/store/entity_identities.md), equal while
  // the page is unchanged and different after a change, but not increasing. Main compares generation for equality only
  // (company-auto-link.ts plan pins, duplicates.ts), so the cases below assert equality and change, never order or value.
  parityTest(
    'listEntityKeyRows narrows to members and to pages with a token value, and names each page\'s identity and generation',
    { methods: ['putPage', 'linkEntityIdentityRow', 'listEntityKeyRows'] },
    async (engine) => {
      const company = (title: string, frontmatter: Record<string, unknown>): PageInput => ({ type: 'company', title, compiled_truth: `${title}.`, timeline: '', frontmatter });
      await seed(engine, [
        ['companies/acme-example', company('Acme Example', { website: ' HTTPS://www.Acme-Example.com/about?x=1 ', linkedin: 'https://linkedin.com/company/acme-co/' })],
        ['companies/widget-co', company('Widget Co', { github: ['https://github.com/widget-login/repo', null], handle: '@widget', employees: 42 })],
        ['people/alice-example', { ...ALICE, frontmatter: { linkedin: 'linkedin.com/in/alice-example?trk=1' } }],
      ]);
      await engine.linkEntityIdentityRow({ entityId: 'group/acme', slug: 'companies/acme-example', sourceId: 'default', confidence: 1, establishedBy: 'manual', canonical: true });
      const all = { types: ['company', 'person'], keys: ['website'], limit: 10 };
      const slugs = async (extra: object) => (await engine.listEntityKeyRows({ ...all, ...extra })).map(r => r.slug);
      const tokens = (values: string[], fields: string[]) => slugs({ tokens: { values, fields } });
      const out = {
        members: await slugs({ members: [{ source_id: 'default', slug: 'companies/widget-co' }, { source_id: 'default', slug: 'companies/missing' }] }),
        noMembers: await slugs({ members: [] }),
        host: await tokens(['acme-example.com'], ['website']),
        company: await tokens(['acme-co'], ['linkedin']),
        profile: await tokens(['alice-example'], ['linkedin']),
        login: await tokens(['widget-login'], ['github']),
        handle: await tokens(['widget'], ['handle']),
        number: await tokens(['42'], ['employees']),
        wrongField: await tokens(['acme-example.com'], ['linkedin']),
        none: await tokens([], ['website']),
        identities: (await engine.listEntityKeyRows(all)).map(r => [r.slug, r.identity, r.keys]),
      };
      const before = (await engine.listEntityKeyRows(all)).map(r => [r.slug, r.page_id, r.generation, r.created_at] as const);
      await seed(engine, [['companies/widget-co', company('Widget Co', { github: 'https://github.com/widget-login', employees: 43 })]]);
      const after = (await engine.listEntityKeyRows(all)).map(r => [r.slug, r.page_id, r.generation, r.created_at] as const);
      const generation = before.map(([slug, id, gen, at], i) => [slug, after[i]![1] === id, after[i]![2] === gen, after[i]![3] === at, typeof gen === 'number']);
      expect(out.members).toEqual(['companies/widget-co']);
      expect(out.noMembers).toEqual([]);
      expect([out.host, out.company, out.profile, out.login, out.handle, out.number]).toEqual([
        ['companies/acme-example'], ['companies/acme-example'], ['people/alice-example'], ['companies/widget-co'], ['companies/widget-co'], ['companies/widget-co']]);
      expect([out.wrongField, out.none]).toEqual([[], []]);
      expect(generation).toEqual([
        ['companies/acme-example', true, true, true, true], ['companies/widget-co', true, false, true, true], ['people/alice-example', true, true, true, true]]);
      return { ...out, generation };
    },
  );
  parityTest(
    'applyIdentityDecisions keeps a decision\'s evidence and writes, skips and removes the company sweep\'s automatic groups',
    { methods: ['putPage', 'softDeletePage', 'listEntityKeyRows', 'applyIdentityDecisions', 'listIdentityDecisions'] },
    async (engine) => {
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
      await seed(engine, names.map(n => [`companies/${n}-example`, { ...ACME, title: `${n} Example` }] as [string, PageInput]));
      const read = async () => new Map((await engine.listEntityKeyRows({ types: ['company'], keys: [], limit: 50 })).map(r => [r.slug.slice(10, 11), r]));
      let rows = await read();
      const member = (n: string) => ({ source_id: 'default', page_id: rows.get(n)!.page_id, generation: rows.get(n)!.generation });
      const group = (entity_id: string, members: string[]) => ({ entity_id, canonical_page_id: rows.get(members[0]!)!.page_id, members: members.map(member) });
      const plan = [group('auto/ab', ['a', 'b']), group('auto/cd', ['c', 'd']), group('auto/ef', ['e', 'f']), group('auto/gh', ['g', 'h']), group('auto/ij', ['i', 'j'])];
      await seed(engine, [['companies/d-example', { ...ACME, title: 'd Example', compiled_truth: 'Changed after the sweep read it.' }]]);
      const first = await engine.applyIdentityDecisions({ auto: { link: plan, unlink: [] } });
      const again = await engine.applyIdentityDecisions({ auto: { link: [group('auto/ab', ['a', 'b'])], unlink: [] } });
      rows = await read();
      const linked = names.map(n => [n, rows.get(n)!.identity]);
      const ref = (n: string) => ({ source_id: 'default', slug: `companies/${n}-example` });
      const decision = (decision_id: string, verdict: 'same' | 'different', members: string[], evidence?: string[]) => ({
        decision_id, verdict, members: members.map(ref), group_id: null, entity_id: verdict === 'same' ? `dedupe/${decision_id}` : null,
        canonical: verdict === 'same' ? ref(members[0]!) : null, decided_by: 'owner', decided_at: '2026-11-18T00:00:00Z', origin: 'database' as const,
        home_source_id: null, git_blob: null, ...(evidence ? { evidence } : {}),
      });
      const decided = await engine.applyIdentityDecisions({ upsert: [
        decision('0000000000000001', 'different', ['a', 'b'], ['fp-a', 'fp-b']),
        decision('0000000000000002', 'same', ['i', 'k']),
        decision('0000000000000003', 'different', ['c', 'k'], []),
      ] });
      await engine.softDeletePage('companies/f-example');
      const swept = await engine.applyIdentityDecisions({ auto: { link: [], unlink: ['auto/gh'] } });
      rows = await read();
      const after = names.filter(n => rows.has(n)).map(n => [n, rows.get(n)!.identity]);
      const decisions = (await engine.listIdentityDecisions()).decisions.map(d => [d.decision_id, d.verdict, d.evidence]);
      expect(first.auto).toEqual({ linked: 4, unlinked: 0, skipped: 1 });
      expect(again.auto).toEqual({ linked: 0, unlinked: 0, skipped: 0 });
      expect(decided.auto).toBeUndefined();
      expect(swept.auto).toEqual({ linked: 0, unlinked: 2, skipped: 0 });
      expect(decisions).toEqual([['0000000000000001', 'different', ['fp-a', 'fp-b']], ['0000000000000002', 'same', null], ['0000000000000003', 'different', null]]);
      expect(after.filter(([, id]) => id !== null)).toEqual([
        ['i', { entity_id: 'dedupe/0000000000000002', established_by: 'dedupe:confirm' }], ['k', { entity_id: 'dedupe/0000000000000002', established_by: 'dedupe:confirm' }]]);
      return { first, again, linked, decided, swept, after, decisions };
    },
  );

  parityTest(
    'a sync of a changed company page runs the company sweep: it links the pair that shares an id, keeps it across a body edit and unlinks it when the ids part',
    { methods: ['putPage', 'listEntityKeyRows', 'listIdentityDecisions', 'applyIdentityDecisions'] },
    async (engine, backend) => {
      // A folder source without git: each performSync passes the slugs it changed to the company sweep
      // (syncIdentityDecisions -> autoLinkCompanies -> listEntityKeyRows + applyIdentityDecisions).
      const dir = mkdtempSync(join(tmpdir(), 'parity-company-sweep-'));
      try {
        mkdirSync(join(dir, 'notes'), { recursive: true });
        mkdirSync(join(dir, 'companies'), { recursive: true });
        writeFileSync(join(dir, 'notes', 'start.md'), '---\ntype: note\ntitle: Start\n---\nStart.\n');
        const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        git('init', '-q', '-b', 'main'); git('config', 'user.email', 'parity@example.com'); git('config', 'user.name', 'Parity');
        git('add', '-A'); git('commit', '-q', '-m', 'start');
        await createSource(engine, backend, 'company-sync', {}, dir);
        await engine.putPage('companies/acme-example', { ...ACME, frontmatter: { linkedin: 'https://www.linkedin.com/company/acme-example/', website: 'https://acme-example.com' } });
        const file = (ids: string, body: string) => writeFileSync(join(dir, 'companies', 'acme-example.md'), `---\ntype: company\ntitle: Acme Example\n${ids}---\n${body}\n`);
        const ACME_IDS = 'linkedin: https://www.linkedin.com/company/acme-example/\nwebsite: https://acme-example.com\n';
        const sync = async () => { git('add', '-A'); try { git('commit', '-q', '-m', 'edit'); } catch { /* nothing new */ }
          return performSync(engine, { sourceId: 'company-sync', repoPath: dir, noPull: true, noEmbed: true, concurrency: 1 }); };
        const groups = async () => (await engine.listEntityKeyRows({ types: ['company'], keys: [], limit: 10 }))
          .map(r => [r.source_id, r.slug, r.identity] as const);
        const steps: Array<{ status: string; groups: Awaited<ReturnType<typeof groups>> }> = [];
        const step = async () => { const r = await sync(); steps.push({ status: r.status, groups: await groups() }); };
        await step();
        file(ACME_IDS, 'Acme Example.');
        await step();
        file(ACME_IDS, 'Acme Example builds widgets.');
        await step();
        file('linkedin: https://www.linkedin.com/company/widget-co/\nwebsite: https://widget-co.example\n', 'Acme Example builds widgets.');
        await step();
        const linked = steps.map(s => s.groups.map(([, , id]) => id?.established_by ?? null));
        expect(linked).toEqual([[null], ['dedupe:auto', 'dedupe:auto'], ['dedupe:auto', 'dedupe:auto'], [null, null]]);
        expect(steps[1]!.groups[0]![2]!.entity_id).toBe(steps[2]!.groups[0]![2]!.entity_id);
        expect(steps[1]!.groups[0]![2]!.entity_id).toMatch(/^dedupe-auto\//);
        return steps;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  parityTest('bumpPageRetrievals stamps the most-linked page once per 5 minutes and staleBias then prefers a never-retrieved page',
    { methods: ['bumpPageRetrievals', 'listPrefixSampledPages'] }, async (engine) => {
      await seed(engine, [['wiki/vc/linked', NOTE], ['wiki/vc/quiet', NOTE], ['notes/a', NOTE]]);
      await engine.addLink('notes/a', 'wiki/vc/linked', '', 'mentions');
      const linked = Number((await engine.getPage('wiki/vc/linked'))!.id);
      const sample = async (staleBias: boolean) => {
        const [row] = await engine.listPrefixSampledPages({ prefixes: ['wiki/vc'], staleBias });
        return { slug: row!.slug, retrieved: row!.last_retrieved_at };
      };
      const before = await sample(false);
      expect(before).toEqual({ slug: 'wiki/vc/linked', retrieved: null });
      await engine.bumpPageRetrievals([linked, 987654]);
      const first = await sample(false);
      expect(first.retrieved).toBeInstanceOf(Date);
      await engine.bumpPageRetrievals([linked]);
      const again = await sample(false);
      const unmoved = again.retrieved!.getTime() === first.retrieved!.getTime();
      expect(unmoved).toBe(true);
      const biased = await sample(true);
      expect(biased).toEqual({ slug: 'wiki/vc/quiet', retrieved: null });
      return { before, stamped: first.slug, unmoved, biased };
    });

  parityTest('bumpPageRetrievals records a retrieval that the samplers read and staleBias ranks behind a never-retrieved page', { methods: ['bumpPageRetrievals', 'listPrefixSampledPages', 'listCorpusSample'] }, async (engine) => {
    await seed(engine, [['wiki/vc/a', NOTE], ['wiki/vc/b', NOTE]]);
    const a = Number((await engine.getPage('wiki/vc/a'))!.id);
    await engine.bumpPageRetrievals([]);
    await engine.bumpPageRetrievals([a, a, 987654]);
    const plain = await engine.listPrefixSampledPages({ prefixes: ['wiki/vc'] });
    const stale = await engine.listPrefixSampledPages({ prefixes: ['wiki/vc'], staleBias: true });
    const first = plain[0]?.last_retrieved_at;
    expect(first).toBeInstanceOf(Date);
    // A second bump inside the 5-minute window leaves the recorded time alone.
    await engine.bumpPageRetrievals([a]);
    const again = (await engine.listPrefixSampledPages({ prefixes: ['wiki/vc'] }))[0]?.last_retrieved_at;
    const sample = sorted((await engine.listCorpusSample({ n: 10, seed: 3 })).map((r) => `${r.slug}:${r.last_retrieved_at instanceof Date}`));
    const view = {
      plain: plain.map((r) => `${r.slug}:${r.last_retrieved_at instanceof Date}`),
      stale: stale.map((r) => `${r.slug}:${r.last_retrieved_at instanceof Date}`),
      throttled: again instanceof Date && again.getTime() === (first as Date).getTime(),
      sample,
    };
    expect(view).toEqual({
      plain: ['wiki/vc/a:true'], stale: ['wiki/vc/b:false'], throttled: true, sample: ['wiki/vc/a:true', 'wiki/vc/b:false'],
    });
    return view;
  });

  parityTest(
    'the sync hook links a pending member once its page exists and fills the fingerprints of a bare different decision',
    { methods: ['putPage', 'applyIdentityDecisions', 'listIdentityDecisions', 'listEntityKeyRows', 'listEntityIdentityRows'] },
    async (engine) => {
      // A LinkedIn profile is a strong key, so each page has a fingerprint (duplicates.ts pageFingerprint).
      const person = (title: string, handle: string): PageInput => ({ type: 'person', title, compiled_truth: `${title}.`, frontmatter: { linkedin: `linkedin.com/in/${handle}` } });
      await seed(engine, [['people/alice-example', person('Alice Example', 'alice-example')], ['people/bob-example', person('Bob Example', 'bob-example')]]);
      const ref = (slug: string) => ({ source_id: 'default', slug });
      const base = { decided_by: 'owner', decided_at: '2026-11-18T00:00:00Z', origin: 'database' as const, home_source_id: null, git_blob: null };
      await engine.applyIdentityDecisions({ upsert: [
        { ...base, decision_id: '0000000000000011', verdict: 'same', members: [ref('people/alice-example'), ref('people/carol-example')],
          group_id: 'dedupe/0000000000000011', entity_id: 'dedupe/0000000000000011', canonical: ref('people/alice-example') },
        { ...base, decision_id: '0000000000000012', verdict: 'different', members: [ref('people/alice-example'), ref('people/bob-example')],
          group_id: 'dedupe/0000000000000012', entity_id: null, canonical: null },
      ] });
      const before = (await engine.listIdentityDecisions()).pending.map(p => p.slug);
      await engine.putPage('people/carol-example', person('Carol Example', 'carol-example'));
      // A brain with no decision home: the hook applies the pending members and fills the bare decision's fingerprints.
      await syncIdentityDecisions(engine, 'default');
      const read = await engine.listIdentityDecisions();
      const members = (await engine.listEntityIdentityRows({ entityId: 'dedupe/0000000000000011' })).map(r => r.slug).sort();
      const result = { before, pending: read.pending.map(p => p.slug), members,
        evidence: read.decisions.find(d => d.decision_id === '0000000000000012')?.evidence?.length ?? 0 };
      expect(result).toEqual({ before: ['people/carol-example'], pending: [], members: ['people/alice-example', 'people/carol-example'], evidence: 2 });
      return result;
    },
  );
});
