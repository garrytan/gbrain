/**
 * #7462: a sync rename moves the page row (same id) and records `old -> new` in slug_aliases with notes 'rename',
 * while the atoms extracted from the page keep `source_slug: old`: on a repo brain that value lives in the atom
 * files, which git keeps. Readers that matched `pages.slug = source_slug` then lost the origin: stale-atoms offered
 * to retire the atoms, the lineage plan narrowed them to private, an atom of a private origin became readable, and
 * the managed checkpoint (matched on the slug) put the page back in the extraction backlog. Readers now follow
 * rename aliases (and only those), and the atom rows stay as they were. These brains have no git binding, which is
 * the repo-less case; every reader is a database read, so a repo brain takes the same path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { staleAtomsRepair } from '../src/core/repair/stale-atoms.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';
import { listHeldManagedAtoms, MANAGED_ATOM_DISCOVERY_SQL } from '../src/core/persistence/atom-maintenance.ts';
import { privatePagesFilterFragment } from '../src/core/search/private-visibility.ts';
import { derivedVisibilityCheck } from '../src/commands/doctor/checks/derived-visibility.ts';
import { computeAtomProvenanceDriftCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

type Page = { id: number; slug: string; content_hash?: string | null };

for (const backend of testBackends()) {
  describe(`atom lineage across sync renames (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
        return;
      }
      const pglite = new PGLiteEngine();
      await pglite.connect({});
      await pglite.initSchema();
      engine = pglite;
      close = () => pglite.disconnect();
    }, 120_000);
    afterAll(async () => { await close(); });

    const seedSource = (sourceId: string) => engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const note = (sourceId: string, slug: string, body: string, visibility?: string) => engine.putPage(slug,
      { type: 'note', title: 'Note', compiled_truth: body, frontmatter: visibility ? { visibility } : {} }, { sourceId });
    const atomOf = (sourceId: string, slug: string, origin: string, originHash: string, managed = true) => engine.putPage(slug, {
      type: 'atom', title: slug, compiled_truth: `Extracted claim ${slug}.`,
      frontmatter: { source_slug: origin, source_hash: originHash.slice(0, 16), visibility: 'world', managed_extraction: managed },
    }, { sourceId });
    const recordExtraction = async (sourceId: string, label: string, page: Page, extra: Record<string, unknown> = {}) => {
      const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
      const key = { sourceId, incarnation: source!.incarnation, kind: 'page', locator: page.slug, pageId: page.id, contentHash: page.content_hash, ...extra };
      await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-atoms',$1,$2::text::jsonb)`, [label, JSON.stringify([key])]);
    };
    const move = (sourceId: string, from: string, to: string) => renamePageOntoSlug(engine, { sourceId, oldSlug: from, newSlug: to, to: `${to}.md` });
    const scope = (sourceId: string) => ({ brain_id: 'test', source_ids: [sourceId] });
    const staleListing = async (sourceId: string) => (await staleAtomsRepair.plan(engine, scope(sourceId), null)).listing ?? [];
    const staleClasses = async (sourceId: string) => (await staleListing(sourceId)).map(entry => [entry.item, entry.class]);
    const lineageTargets = async (sourceId: string) => (await visibilityRepair.plan(engine, scope(sourceId), null,
      { apply: false, driftClass: 'lineage' })).items.map(entry => entry.slug);
    const inBacklog = async (sourceId: string, page: Page) => (await engine.executeRaw<{ id: number }>(
      `SELECT p.id FROM pages p WHERE p.source_id=$1 AND p.id=$2 ${MANAGED_ATOM_DISCOVERY_SQL}`, [sourceId, page.id])).length > 0;
    const readableAtoms = async (sourceId: string) => (await engine.executeRaw<{ slug: string }>(
      `SELECT p.slug FROM pages p WHERE p.source_id=$1 AND p.type='atom' AND p.deleted_at IS NULL AND ${privatePagesFilterFragment('p')} ORDER BY p.slug`,
      [sourceId])).map(row => row.slug);
    const looserAtoms = async (sourceId: string) => ((await derivedVisibilityCheck(engine, sourceId)).details as { looser_atoms: number }).looser_atoms;
    const liveAtoms = async (sourceId: string) => (await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL ORDER BY slug`, [sourceId])).map(row => row.slug);
    const atomRow = async (sourceId: string, slug: string) => (await engine.executeRaw<{ frontmatter: unknown; compiled_truth: string }>(
      'SELECT frontmatter, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0];
    const applyStale = async (sourceId: string) => {
      const preview = await staleAtomsRepair.plan(engine, scope(sourceId), null);
      const approved = await staleAtomsRepair.plan(engine, scope(sourceId), null, { apply: true, expect: preview.preview_hash });
      const ctx = { engine, remote: false, config: {} } as unknown as OperationContext;
      const outcomes = [];
      for (const entry of approved.items) outcomes.push(await staleAtomsRepair.apply(ctx, entry));
      return outcomes;
    };

    test('two renames leave a world origin\'s atom untouched, readable and out of every repair', async () => {
      await seedSource('source-a');
      await seedSource('source-a2');
      const page = await note('source-a', 'notes/topic', 'Evidence body.', 'world');
      await atomOf('source-a', 'atoms/topic-claim', 'notes/topic', page.content_hash!);
      await atomOf('source-a2', 'atoms/topic-claim', 'notes/topic', page.content_hash!);
      await recordExtraction('source-a', 'topic-done', page);
      const stored = await atomRow('source-a', 'atoms/topic-claim');
      expect(await inBacklog('source-a', page)).toBe(false);

      for (const [from, to] of [['notes/topic', 'projects/topic'], ['projects/topic', 'archive/topic']] as const) {
        expect(await move('source-a', from, to)).toBe('renamed');
        expect((await engine.getPage(to, { sourceId: 'source-a' }))?.id).toBe(page.id);
        expect(await atomRow('source-a', 'atoms/topic-claim')).toEqual(stored);
        expect(await staleListing('source-a')).toEqual([]);
        expect(await lineageTargets('source-a')).toEqual([]);
        expect(await inBacklog('source-a', page)).toBe(false);
        expect(await readableAtoms('source-a')).toEqual(['atoms/topic-claim']);
        expect(await looserAtoms('source-a')).toBe(0);
      }
      expect(await staleClasses('source-a2')).toEqual([['source-a2:atoms/topic-claim', 'origin_gone']]);
    });

    test('a checkpoint never completes another page with the same content', async () => {
      await seedSource('source-f');
      const first = await note('source-f', 'notes/first', 'Shared body.');
      const second = await note('source-f', 'notes/second', 'Shared body.');
      expect(second.content_hash).toBe(first.content_hash);
      await recordExtraction('source-f', 'first-done', first);
      expect(await move('source-f', 'notes/first', 'archive/first')).toBe('renamed');
      expect(await inBacklog('source-f', first)).toBe(false);
      expect(await inBacklog('source-f', second)).toBe(true);
    });

    test('after an edit, the renamed page\'s replacement makes the old atom retirable; a delete makes it gone', async () => {
      await seedSource('source-g');
      const page = await note('source-g', 'notes/plan', 'First draft.', 'world');
      await atomOf('source-g', 'atoms/plan-claim', 'notes/plan', page.content_hash!);
      await recordExtraction('source-g', 'plan-v1', page);
      expect(await move('source-g', 'notes/plan', 'archive/plan')).toBe('renamed');
      const edited = await note('source-g', 'archive/plan', 'Second draft.', 'world');
      expect(edited.id).toBe(page.id);
      expect(await staleListing('source-g')).toEqual([]);

      await atomOf('source-g', 'atoms/plan-claim-v2', 'archive/plan', edited.content_hash!);
      await recordExtraction('source-g', 'plan-v2', edited);
      expect(await staleListing('source-g')).toEqual([{ item: 'source-g:atoms/plan-claim', class: 'origin_changed',
        detail: `source page notes/plan now at ${edited.content_hash!.slice(0, 16)}` }]);
      expect((await computeAtomProvenanceDriftCheck(engine)).details).toMatchObject({ source_changed: 1 });
      expect(await applyStale('source-g')).toEqual([{ applied: true, outcome: 'retired' }]);
      expect(await liveAtoms('source-g')).toEqual(['atoms/plan-claim-v2']);

      await engine.softDeletePage('archive/plan', { sourceId: 'source-g' });
      expect(await staleClasses('source-g')).toEqual([['source-g:atoms/plan-claim-v2', 'origin_gone']]);
      expect(await lineageTargets('source-g')).toEqual(['atoms/plan-claim-v2']);
    });

    test('an unmanaged replacement under the renamed slug is completion evidence', async () => {
      await seedSource('source-e');
      const page = await note('source-e', 'notes/topic', 'Original body.');
      await atomOf('source-e', 'atoms/claim', 'notes/topic', page.content_hash!, false);
      expect(await move('source-e', 'notes/topic', 'archive/topic')).toBe('renamed');
      const edited = await note('source-e', 'archive/topic', 'Revised body.');
      expect(await staleListing('source-e')).toEqual([]);
      await atomOf('source-e', 'atoms/claim-revised', 'archive/topic', edited.content_hash!, false);
      expect(await staleClasses('source-e')).toEqual([['source-e:atoms/claim', 'origin_changed']]);
      expect(await applyStale('source-e')).toEqual([{ applied: true, outcome: 'retired' }]);
      expect(await liveAtoms('source-e')).toEqual(['atoms/claim-revised']);
    });

    test('a private origin keeps its atom private after a rename', async () => {
      await seedSource('source-b');
      const page = await note('source-b', 'notes/secret', 'Private body.', 'private');
      await atomOf('source-b', 'atoms/secret-claim', 'notes/secret', page.content_hash!);
      expect(await readableAtoms('source-b')).toEqual([]);
      expect(await move('source-b', 'notes/secret', 'archive/secret')).toBe('renamed');
      expect(await readableAtoms('source-b')).toEqual([]);
      expect(await lineageTargets('source-b')).toEqual(['atoms/secret-claim']);
      expect(await staleListing('source-b')).toEqual([]);
      expect(await looserAtoms('source-b')).toBe(1);
    });

    test('an alias that is not a rename is not followed', async () => {
      await seedSource('source-c');
      const page = await note('source-c', 'notes/topic', 'Some body.', 'world');
      await engine.executeRaw(`INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug,notes) VALUES($1,'notes/slug-line','notes/topic','frontmatter_slug_line')`, ['source-c']);
      await atomOf('source-c', 'atoms/slug-line-claim', 'notes/slug-line', page.content_hash!);
      expect(await staleClasses('source-c')).toEqual([['source-c:atoms/slug-line-claim', 'origin_gone']]);
      expect(await lineageTargets('source-c')).toEqual(['atoms/slug-line-claim']);
    });

    test('a held extraction completed under the renamed slug is no longer listed as held', async () => {
      await seedSource('source-d');
      const page = await note('source-d', 'notes/held', 'Held body.');
      await recordExtraction('source-d', 'held-run', page, { failure: 'provider_error', held: true, requestId: 'request-held', attempts: 3 });
      expect((await listHeldManagedAtoms(engine, ['source-d'])).map(row => row.locator)).toEqual(['notes/held']);
      expect(await move('source-d', 'notes/held', 'archive/held')).toBe('renamed');
      expect(await inBacklog('source-d', page)).toBe(false);
      await recordExtraction('source-d', 'held-completed', { ...page, slug: 'archive/held' });
      expect(await listHeldManagedAtoms(engine, ['source-d'])).toEqual([]);
    });
  });
}
