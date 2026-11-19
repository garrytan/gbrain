/**
 * BrainEngine parity: the ranking-stage reads hybrid search runs after fusion
 * (engine-sql/search-reads.ts) and the onboarding counts
 * (engine-sql/health.ts countOnboardSignal).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read returns the same answer on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts): supersede probe and slugs, alias canonical
 *    refs, collapse facts, bare-slug suffix lookup, generated pages, live page
 *    ids, ranking links, SQL cosines and the six onboarding counts.
 *  - Regression: an engine whose supersede, alias, collapse, demotion or
 *    cosine read drifts gives a different hybridSearch ranking per backend;
 *    a drifted count gives a different onboarding nudge.
 *  - Why existing coverage misses it: the search tests run these reads on
 *    PGLite only, through hybridSearch, and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw). Page, chunk and link ids
 *    are serial and engine-dependent (PGLite also skips ids), so every case
 *    maps ids back to slugs before it returns. Seeded chunks go through
 *    sealChunks, so the text projection is sealed.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { basisEmbedding, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

async function put(engine: BrainEngine, slug: string, extra: Record<string, unknown> = {}, opts?: { sourceId?: string }) {
  const type = slug.startsWith('people/') ? 'person' : slug.startsWith('companies/') ? 'company' : 'note';
  return engine.putPage(slug, { type, title: slug, compiled_truth: `Page ${slug}.`, timeline: '', ...extra } as never, opts);
}

/** Page id → slug for the pages a case wrote (ids never leave the arm). */
function slugsOf(pages: Array<{ id: number; slug: string }>) {
  const byId = new Map(pages.map(p => [Number(p.id), p.slug]));
  return (ids: Iterable<number>) => sorted([...ids].map(id => byId.get(Number(id)) ?? `unknown:${id}`));
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

describe('engine parity: search reads', () => {
  parityTest(
    'hasSupersedeEdges and supersedingPageSlugs: same-source live superseder only, policy scoped',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'hasSupersedeEdges', 'supersedingPageSlugs'] },
    async (engine, backend) => {
      const before = await engine.hasSupersedeEdges();
      await createSource(engine, backend, 'other');
      const pages = [
        await put(engine, 'notes/canon'), await put(engine, 'notes/stale'),
        await put(engine, 'notes/gone-canon'), await put(engine, 'notes/orphaned'),
        await put(engine, 'notes/plain'),
      ];
      await put(engine, 'notes/canon', {}, { sourceId: 'other' });
      await engine.addLink('notes/canon', 'notes/stale', '', 'supersedes', 'manual');
      await engine.addLink('notes/gone-canon', 'notes/orphaned', '', 'supersedes', 'manual');
      await engine.addLink('notes/canon', 'notes/plain', '', 'mentions', 'manual');
      await engine.softDeletePage('notes/gone-canon');
      const name = slugsOf(pages);
      const ids = pages.map(p => p.id);
      const view = (m: Map<number, string>) => sorted([...m].map(([id, by]) => `${name([id])[0]}<${by}`));
      const after = await engine.hasSupersedeEdges();
      const open = view(await engine.supersedingPageSlugs(ids));
      const scoped = view(await engine.supersedingPageSlugs(ids, { sourceId: 'default' }));
      const elsewhere = view(await engine.supersedingPageSlugs(ids, { sourceId: 'other' }));
      const none = view(await engine.supersedingPageSlugs([]));
      expect(before).toBe(false);
      expect(after).toBe(true);
      expect(open).toEqual(['notes/stale<notes/canon']);
      expect(scoped).toEqual(open);
      expect(elsewhere).toEqual([]);
      return { before, after, open, scoped, elsewhere, none };
    },
  );

  parityTest(
    'aliasCanonicalRefs: the refs a rename made canonical, per source and policy',
    { methods: ['putPage', 'updateSlug', 'aliasCanonicalRefs'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await put(engine, 'concepts/before');
      await engine.updateSlug('concepts/before', 'concepts/after');
      await put(engine, 'concepts/unaliased');
      await put(engine, 'concepts/after', {}, { sourceId: 'other' });
      const refs = [
        { slug: 'concepts/after', source_id: 'default' }, { slug: 'concepts/unaliased', source_id: 'default' },
        { slug: 'concepts/after', source_id: 'other' }, { slug: 'concepts/before', source_id: 'default' },
      ];
      const key = (rows: Array<{ source_id: string; canonical_slug: string }>) => sorted(rows.map(r => `${r.source_id}::${r.canonical_slug}`));
      const open = key(await engine.aliasCanonicalRefs(refs));
      const scoped = key(await engine.aliasCanonicalRefs(refs, { sourceIds: ['default'] }));
      const elsewhere = key(await engine.aliasCanonicalRefs(refs, { sourceId: 'other' }));
      const empty = key(await engine.aliasCanonicalRefs([]));
      expect(open).toEqual(['default::concepts/after']);
      return { open, scoped, elsewhere, empty };
    },
  );

  parityTest(
    'pageCollapseFacts: redirect target, bounded body length, md5 of a substantial body and its lead',
    { methods: ['putPage', 'pageCollapseFacts'] },
    async (engine) => {
      const long = 'shared document body '.repeat(20).trim();
      const pages = [
        await put(engine, 'notes/redirect', { frontmatter: { redirect_to: ' notes/target ' } }),
        await put(engine, 'notes/merged', { frontmatter: { merged_into: 'notes/target' } }),
        await put(engine, 'notes/status-alias', { frontmatter: { status: 'Alias', superseded_by: 'notes/target' } }),
        await put(engine, 'notes/status-other', { frontmatter: { status: 'draft', superseded_by: 'notes/target' } }),
        await put(engine, 'notes/long-a', { compiled_truth: long }),
        await put(engine, 'notes/long-b', { compiled_truth: long }),
        await put(engine, 'notes/short', { compiled_truth: 'tiny' }),
      ];
      const name = slugsOf(pages);
      const bodyIds = pages.filter(p => p.slug !== 'notes/redirect').map(p => p.id);
      const rows = await engine.pageCollapseFacts(pages.map(p => p.id), bodyIds);
      const view = sorted(rows.map(r => ({
        slug: name([r.id])[0], target: r.target, body_chars: r.body_chars === null ? null : Number(r.body_chars),
        body: r.body, lead: r.lead,
      })), r => r.slug!);
      const a = view.find(r => r.slug === 'notes/long-a')!;
      expect(a.body).not.toBeNull();
      expect(a.body).toBe(view.find(r => r.slug === 'notes/long-b')!.body);
      expect(view.find(r => r.slug === 'notes/short')!.body).toBeNull();
      expect(view.find(r => r.slug === 'notes/redirect')).toMatchObject({ target: 'notes/target', lead: null });
      expect(view.find(r => r.slug === 'notes/status-other')!.target).toBeNull();
      return { view, missing: await engine.pageCollapseFacts([], []) };
    },
  );

  parityTest(
    'slugsEndingIn: live slugs equal to or ending in /word, LIKE-escaped, at most two',
    { methods: ['putPage', 'softDeletePage', 'slugsEndingIn'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      for (const slug of ['people/widget', 'companies/widget', 'notes/widget', 'widget', 'notes/a_b', 'notes/axb', 'notes/gone']) await put(engine, slug);
      await put(engine, 'notes/solo', {}, { sourceId: 'other' });
      await engine.softDeletePage('notes/gone');
      const many = (await engine.slugsEndingIn('default', 'widget')).length;
      const escaped = sorted(await engine.slugsEndingIn('default', 'a_b'));
      const deleted = await engine.slugsEndingIn('default', 'gone');
      const otherSource = await engine.slugsEndingIn('default', 'solo');
      const own = await engine.slugsEndingIn('other', 'solo');
      expect(many).toBe(2);
      expect(escaped).toEqual(['notes/a_b']);
      return { many, escaped, deleted, otherSource, own };
    },
  );

  parityTest(
    'generatedPagesIn, livePageIdsAt and pagesLinkingTo: the generated-page demotion reads',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'generatedPagesIn', 'livePageIdsAt', 'pagesLinkingTo'] },
    async (engine) => {
      const pages = [
        await put(engine, 'people/alice-example'),
        await put(engine, 'notes/dream', { frontmatter: { dream_generated: true }, compiled_truth: 'dream body' }),
        await put(engine, 'notes/receipt', { type: 'extract_receipt' }),
        await put(engine, 'notes/human'),
        await put(engine, 'notes/linker'),
        await put(engine, 'notes/gone'),
      ];
      await engine.addLink('notes/linker', 'people/alice-example', 'mentions alice', 'mentions', 'manual');
      await engine.addLink('notes/human', 'notes/linker', '', 'mentions', 'manual');
      await engine.softDeletePage('notes/gone');
      const name = slugsOf(pages);
      const id = (slug: string) => pages.find(p => p.slug === slug)!.id;
      const generated = sorted((await engine.generatedPagesIn(pages.map(p => p.id))).map(r => ({
        slug: name([r.id])[0], dream: (r.frontmatter as Record<string, unknown> | null)?.dream_generated ?? null, compiled_truth: r.compiled_truth,
      })), r => r.slug!);
      const live = name(await engine.livePageIdsAt([
        { slug: 'people/alice-example', source_id: 'default' }, { slug: 'notes/gone', source_id: 'default' },
        { slug: 'notes/missing', source_id: 'default' }, { slug: 'people/alice-example', source_id: 'other' },
      ]));
      const linking = name(await engine.pagesLinkingTo(pages.map(p => p.id), [id('people/alice-example')]));
      expect(generated.map(g => g.slug)).toEqual(['notes/dream', 'notes/receipt']);
      expect(live).toEqual(['people/alice-example']);
      expect(linking).toEqual(['notes/linker']);
      return { generated, live, linking };
    },
  );

  parityTest(
    'cosinesByChunkIds: text-space cosine per visible embedded chunk; unembedded and deleted chunks are absent',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'softDeletePage', 'cosinesByChunkIds'] },
    async (engine) => {
      const query = basisEmbedding(3);
      await seedPage(engine, { slug: 'notes/same', input: { type: 'note', title: 'same', compiled_truth: 'same axis', timeline: '' },
        chunks: [chunk(0, 'same axis', { embedding: basisEmbedding(3) }), chunk(1, 'no vector')] });
      await seedPage(engine, { slug: 'notes/orthogonal', input: { type: 'note', title: 'orth', compiled_truth: 'other axis', timeline: '' },
        chunks: [chunk(0, 'other axis', { embedding: basisEmbedding(9) })] });
      await seedPage(engine, { slug: 'notes/deleted', input: { type: 'note', title: 'deleted', compiled_truth: 'gone', timeline: '' },
        chunks: [chunk(0, 'gone', { embedding: basisEmbedding(3) })] });
      const chunkName = new Map<number, string>();
      for (const slug of ['notes/same', 'notes/orthogonal', 'notes/deleted']) {
        for (const c of await engine.getChunks(slug)) chunkName.set(Number(c.id), `${slug}#${c.chunk_index}`);
      }
      await engine.softDeletePage('notes/deleted');
      const cosines = await engine.cosinesByChunkIds([...chunkName.keys()], 'embedding', query);
      const view = sorted([...cosines].map(([id, cos]) => `${chunkName.get(id)}=${round(cos)}`));
      expect(view).toEqual(['notes/orthogonal#0=0', 'notes/same#0=1']);
      return { view, empty: [...await engine.cosinesByChunkIds([], 'embedding', query)] };
    },
  );

  parityTest(
    'countOnboardSignal: the six onboarding counts under a per-source entity-type filter',
    { methods: ['putPage', 'sealChunks', 'addLink', 'addTimelineEntry', 'addTakesBatch', 'softDeletePage', 'countOnboardSignal'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const alice = await put(engine, 'people/alice-example');
      await put(engine, 'people/bob-example');
      await put(engine, 'companies/acme-example');
      await put(engine, 'people/gone-example');
      await put(engine, 'notes/memo');
      await put(engine, 'notes/skip', { frontmatter: { embed_skip: true } });
      await put(engine, 'people/carol-example', {}, { sourceId: 'other' });
      await engine.sealChunks('notes/memo', [chunk(0, 'memo text'), chunk(1, 'memo more', { embedding: basisEmbedding(1) })]);
      await engine.sealChunks('notes/skip', [chunk(0, 'skipped text')]);
      await engine.addLink('notes/memo', 'people/alice-example', 'memo mentions alice', 'mentions', 'manual');
      await engine.addTimelineEntry('people/bob-example', { date: '2026-01-02', source: 'cal', summary: 'Met Bob' });
      await engine.addTakesBatch([{ page_id: alice.id, row_num: 1, claim: 'Alice ships', kind: 'take', holder: 'garry' }]);
      await engine.softDeletePage('people/gone-example');
      const filter = { types: ['person', 'company'], per_source: [{ source_id: 'other', types: ['company'] }] };
      const counts: Record<string, number> = {};
      for (const kind of ['stale_chunks', 'entities', 'linked_entities', 'timeline_entities', 'takes', 'pages'] as const) {
        counts[kind] = await engine.countOnboardSignal(kind, filter);
      }
      expect(counts).toEqual({ stale_chunks: 1, entities: 3, linked_entities: 1, timeline_entities: 1, takes: 1, pages: 6 });
      return counts;
    },
  );
});
