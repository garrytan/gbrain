/**
 * BrainEngine parity — sync_aliases family (rename, slug/page aliases,
 * narrow page updates, fact migration).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: sync's rename path, the slug-alias and page-alias layers, the
 *    narrow body/CR-state refreshes and the phantom-fact migration return the
 *    same observable result on every engine arm (PGLite always; Postgres
 *    with DATABASE_URL; a Rust arm later through test/engine-parity/harness.ts).
 *  - Regression: an engine that renames the wrong source's row, loses chunks
 *    on rename, forgets the old-slug alias, mis-scopes alias resolution
 *    across sources, or moves expired facts — the paths `gbrain sync`,
 *    wikilink resolution, search alias hops and the phantom redirect rely on.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and has no sync/alias cases;
 *    test/phantom-redirect-engine-parity.test.ts seeds through executeRaw and
 *    compares against fixed expectations, not between engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *    rewriteLinks is deliberately not called here.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: sync + aliases', () => {
  parityTest(
    'updateSlug renames a page in place, keeps its chunks, and returns 0 when the old slug is absent',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'getPage', 'updateSlug'] },
    async (engine) => {
      await engine.putPage('notes/old-name', { type: 'note', title: 'Movable', compiled_truth: 'Content.', timeline: '' });
      await engine.upsertChunks('notes/old-name', [
        { chunk_index: 0, chunk_text: 'Content.', chunk_source: 'compiled_truth' },
        { chunk_index: 1, chunk_text: 'More.', chunk_source: 'timeline' },
      ]);
      const moved = await engine.updateSlug('notes/old-name', 'notes/new-name');
      const missing = await engine.updateSlug('notes/never-existed', 'notes/whatever');
      expect(moved).toBe(1);
      expect(missing).toBe(0);
      const oldPage = await engine.getPage('notes/old-name');
      const newPage = await engine.getPage('notes/new-name');
      const chunks = await engine.getChunks('notes/new-name', { includeUnsealed: true });
      expect(chunks).toHaveLength(2);
      expect(oldPage).toBeNull();
      expect(newPage?.title).toBe('Movable');
      return {
        moved, missing, oldPage,
        newPage: pick(newPage!, ['slug', 'type', 'title', 'compiled_truth'] as const),
        chunks: chunks.map((c) => `${c.chunk_index}:${c.chunk_text}`),
        oldChunks: await engine.getChunks('notes/old-name', { includeUnsealed: true }),
      };
    },
  );

  parityTest(
    'updateSlug is source-scoped and rejects a path-traversal new slug',
    { methods: ['putPage', 'getPage', 'updateSlug'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'rename-other');
      await engine.putPage('notes/twin', { type: 'note', title: 'D', compiled_truth: 'D.', timeline: '' });
      await engine.putPage('notes/twin', { type: 'note', title: 'O', compiled_truth: 'O.', timeline: '' }, { sourceId: 'rename-other' });
      const moved = await engine.updateSlug('notes/twin', 'notes/twin-renamed', { sourceId: 'rename-other' });
      const defaultStill = await engine.getPage('notes/twin', { sourceId: 'default' });
      const otherNew = await engine.getPage('notes/twin-renamed', { sourceId: 'rename-other' });
      const otherOld = await engine.getPage('notes/twin', { sourceId: 'rename-other' });
      const wrongSource = await engine.updateSlug('notes/twin-renamed', 'notes/x', { sourceId: 'default' });
      let invalid = false;
      try {
        await engine.updateSlug('notes/twin', 'notes/../escape');
      } catch {
        invalid = true;
      }
      expect(moved).toBe(1);
      expect(defaultStill?.title).toBe('D');
      expect(otherNew?.title).toBe('O');
      expect(otherOld).toBeNull();
      expect(wrongSource).toBe(0);
      expect(invalid).toBe(true);
      return { moved, wrongSource, invalid, defaultStill: defaultStill?.title, otherNew: otherNew?.title, otherOld };
    },
  );

  parityTest(
    'a rename records an alias: resolveSlugWithAlias maps the old slug to the new one, per source',
    { methods: ['putPage', 'updateSlug', 'resolveSlugWithAlias', 'resolveSlugWithAliasDetailed'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'alias-other');
      await engine.putPage('concepts/before', { type: 'concept', title: 'Idea', compiled_truth: 'Idea.', timeline: '' });
      await engine.updateSlug('concepts/before', 'concepts/after');
      const viaAlias = await engine.resolveSlugWithAlias('concepts/before', 'default');
      const detailed = await engine.resolveSlugWithAliasDetailed('concepts/before', 'default');
      const notAliased = await engine.resolveSlugWithAlias('concepts/after', 'default');
      const unknown = await engine.resolveSlugWithAlias('concepts/unknown', 'default');
      const otherSource = await engine.resolveSlugWithAlias('concepts/before', 'alias-other');
      const federated = await engine.resolveSlugWithAlias('concepts/before', ['alias-other', 'default']);
      const federatedDetailed = await engine.resolveSlugWithAliasDetailed('concepts/before', ['alias-other', 'default']);
      const noMatch = await engine.resolveSlugWithAliasDetailed('concepts/unknown', 'default');
      const emptySources = await engine.resolveSlugWithAliasDetailed('concepts/before', []);
      expect(viaAlias).toBe('concepts/after');
      expect(detailed).toEqual({ canonical_slug: 'concepts/after', source_id: 'default' });
      expect(otherSource).toBe('concepts/before');
      return { viaAlias, detailed, notAliased, unknown, otherSource, federated, federatedDetailed, noMatch, emptySources };
    },
  );

  parityTest(
    'setPageAliases replaces a page alias set; resolveAliases maps normalized aliases to slugs with source scope',
    { methods: ['putPage', 'setPageAliases', 'resolveAliases'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'palias-other');
      await engine.putPage('people/pa-alice', { type: 'person', title: 'Alice', compiled_truth: 'A.', timeline: '' });
      await engine.putPage('people/pa-alice-two', { type: 'person', title: 'Alice Two', compiled_truth: 'A2.', timeline: '' });
      await engine.putPage('people/pa-other', { type: 'person', title: 'Other', compiled_truth: 'O.', timeline: '' }, { sourceId: 'palias-other' });
      await engine.setPageAliases('people/pa-alice', 'default', ['ally', 'alice example', 'ally', '']);
      await engine.setPageAliases('people/pa-alice-two', 'default', ['ally']);
      await engine.setPageAliases('people/pa-other', 'palias-other', ['ally', 'only other']);
      const flat = (m: Map<string, Array<{ slug: string; source_id: string }>>) =>
        Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sorted(v.map((r) => `${r.source_id}:${r.slug}`))]));
      const query = ['ally', 'alice example', 'only other', 'nobody'];
      const inDefault = flat(await engine.resolveAliases(query, { sourceId: 'default' }));
      const inOther = flat(await engine.resolveAliases(query, { sourceId: 'palias-other' }));
      const inBoth = flat(await engine.resolveAliases(query, { sourceIds: ['default', 'palias-other'] }));
      const empty = await engine.resolveAliases([], { sourceId: 'default' });
      // Replacing the set drops aliases that are no longer declared.
      await engine.setPageAliases('people/pa-alice', 'default', ['alice example']);
      const afterReplace = flat(await engine.resolveAliases(query, { sourceId: 'default' }));
      await engine.setPageAliases('people/pa-alice', 'default', []);
      const afterClear = flat(await engine.resolveAliases(query, { sourceId: 'default' }));
      expect(inDefault.ally).toEqual(['default:people/pa-alice', 'default:people/pa-alice-two']);
      expect(inOther.ally).toEqual(['palias-other:people/pa-other']);
      expect(empty.size).toBe(0);
      expect(afterReplace['alice example']).toEqual(['default:people/pa-alice']);
      expect(afterClear['alice example']).toBeUndefined();
      return { inDefault, inOther, inBoth, emptySize: empty.size, afterReplace, afterClear };
    },
  );

  parityTest(
    'refreshPageBody rewrites body, timeline and content hash; skips soft-deleted pages and other sources',
    { methods: ['putPage', 'refreshPageBody', 'getPage', 'softDeletePage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'refresh-other');
      await engine.putPage('people/refresh-a', { type: 'person', title: 'A', compiled_truth: 'Original.', timeline: '' });
      await engine.putPage('people/refresh-a', { type: 'person', title: 'A', compiled_truth: 'Other original.', timeline: '' }, { sourceId: 'refresh-other' });
      await engine.putPage('people/refresh-gone', { type: 'person', title: 'Gone', compiled_truth: 'Gone body.', timeline: '' });
      await engine.refreshPageBody('people/refresh-a', 'default', 'New body.', '- 2026-02-02: updated', 'hash-new');
      await engine.softDeletePage('people/refresh-gone');
      await engine.refreshPageBody('people/refresh-gone', 'default', 'Should not land.', '', 'hash-gone');
      await engine.refreshPageBody('people/refresh-missing', 'default', 'Nothing here.', '', 'hash-none');
      const refreshed = await engine.getPage('people/refresh-a', { sourceId: 'default' });
      const other = await engine.getPage('people/refresh-a', { sourceId: 'refresh-other' });
      const gone = await engine.getPage('people/refresh-gone', { includeDeleted: true });
      expect(refreshed?.compiled_truth).toBe('New body.');
      expect(refreshed?.content_hash).toBe('hash-new');
      expect(other?.compiled_truth).toBe('Other original.');
      expect(gone?.compiled_truth).toBe('Gone body.');
      expect(gone?.content_hash).not.toBe('hash-gone');
      return {
        refreshed: pick(refreshed!, ['compiled_truth', 'timeline', 'content_hash', 'title'] as const),
        other: other?.compiled_truth,
        goneBody: gone?.compiled_truth,
        missing: await engine.getPage('people/refresh-missing'),
      };
    },
  );

  parityTest(
    'updatePageContextualRetrievalState stamps the CR mode without touching the body',
    { methods: ['putPage', 'updatePageContextualRetrievalState', 'getPage', 'softDeletePage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'cr-other');
      await engine.putPage('notes/cr-a', { type: 'note', title: 'CR', compiled_truth: 'CR body.', timeline: '' });
      await engine.putPage('notes/cr-a', { type: 'note', title: 'CR', compiled_truth: 'CR other.', timeline: '' }, { sourceId: 'cr-other' });
      await engine.putPage('notes/cr-gone', { type: 'note', title: 'Gone', compiled_truth: 'Gone.', timeline: '' });
      const before = await engine.getPage('notes/cr-a');
      await engine.updatePageContextualRetrievalState('notes/cr-a', 'default', 'title', 'gen-1');
      const titled = await engine.getPage('notes/cr-a');
      await engine.updatePageContextualRetrievalState('notes/cr-a', 'default', 'none', null);
      const none = await engine.getPage('notes/cr-a');
      const other = await engine.getPage('notes/cr-a', { sourceId: 'cr-other' });
      await engine.softDeletePage('notes/cr-gone');
      await engine.updatePageContextualRetrievalState('notes/cr-gone', 'default', 'title', 'gen-x');
      const gone = await engine.getPage('notes/cr-gone', { includeDeleted: true });
      // corpus_generation is written by this method but no typed read projects it (getPage omits the column;
      // only SQL readers see it), so only the mode and the untouched body are observable here.
      const keys = ['compiled_truth', 'contextual_retrieval_mode'] as const;
      expect(titled?.contextual_retrieval_mode).toBe('title');
      expect(titled?.compiled_truth).toBe('CR body.');
      expect(none?.contextual_retrieval_mode).toBe('none');
      return {
        before: pick(before!, keys),
        titled: pick(titled!, keys),
        none: pick(none!, keys),
        other: pick(other!, keys),
        gone: pick(gone!, keys),
      };
    },
  );

  parityTest(
    'migrateFactsToCanonical moves active phantom facts, leaves expired ones, and is idempotent',
    { methods: ['putPage', 'insertFacts', 'migrateFactsToCanonical', 'listFactsByEntity'] },
    async (engine) => {
      await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: '# alice', timeline: '' });
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example', timeline: '' });
      const base = { kind: 'fact' as const, visibility: 'private' as const, source: 'parity', notability: 'high' as const, confidence: 0.9 };
      await engine.insertFacts([
        { ...base, fact: 'Canonical fact', entity_slug: 'people/alice-example', row_num: 1, source_markdown_slug: 'people/alice-example' },
        { ...base, fact: 'Phantom one', entity_slug: 'alice', row_num: 1, source_markdown_slug: 'alice', context: 'ctx' },
        { ...base, fact: 'Phantom two', entity_slug: 'alice', row_num: 2, source_markdown_slug: 'alice' },
        { ...base, fact: 'Phantom expired', entity_slug: 'alice', row_num: 3, source_markdown_slug: 'alice', expired_at: new Date('2026-01-01T00:00:00Z') },
      ], { source_id: 'default' });
      const view = (rows: Awaited<ReturnType<typeof engine.listFactsByEntity>>) =>
        sorted(rows.map((r) => `${r.fact}|${r.entity_slug}|${r.visibility}|${r.notability}|${r.confidence}|${r.context ?? ''}`));
      const phantomBefore = view(await engine.listFactsByEntity('default', 'alice'));
      const first = await engine.migrateFactsToCanonical('alice', 'people/alice-example', 'default');
      const second = await engine.migrateFactsToCanonical('alice', 'people/alice-example', 'default');
      const unrelated = await engine.migrateFactsToCanonical('nobody', 'people/alice-example', 'default');
      const phantomAfter = view(await engine.listFactsByEntity('default', 'alice'));
      const phantomAll = view(await engine.listFactsByEntity('default', 'alice', { activeOnly: false }));
      const canonical = view(await engine.listFactsByEntity('default', 'people/alice-example'));
      expect(first).toEqual({ migrated: 2 });
      expect(second).toEqual({ migrated: 0 });
      expect(phantomAfter).toEqual([]);
      return { phantomBefore, first, second, unrelated, phantomAfter, phantomAll, canonical };
    },
  );
  parityTest(
    'rewriteLinks after updateSlug is a no-op: links follow the page id, not the slug',
    { methods: ['updateSlug', 'rewriteLinks', 'addLink', 'getLinks', 'getBacklinks'] },
    async (engine) => {
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Works at acme-example.' });
      await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'A company.' });
      await engine.addLink('people/alice-example', 'companies/acme-example', 'employee', 'works_at');
      await engine.updateSlug('companies/acme-example', 'companies/acme-renamed');
      const out = await engine.rewriteLinks('companies/acme-example', 'companies/acme-renamed');
      expect(out).toBeUndefined();
      const links = (await engine.getLinks('people/alice-example')).map((l) => `${l.to_slug}:${l.link_type}`);
      expect(links).toEqual(['companies/acme-renamed:works_at']);
      const backlinks = (await engine.getBacklinks('companies/acme-renamed')).map((l) => l.from_slug);
      const unknown = await engine.rewriteLinks('notes/never-existed', 'notes/whatever');
      return { out: out ?? null, links, backlinks, unknown: unknown ?? null };
    },
  );
});
