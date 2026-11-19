/**
 * BrainEngine parity: the link reads of engine-sql/link-reads.ts, which doctor,
 * orphans, graph-query, the entity card, automatic link preparation, the
 * entity anchor and fact relevance used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read returns the same answer on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts): coverage counts, junk hubs, entity
 *    counts, graph coverage, foreign edges, live page summaries, the entity
 *    card's backlink count, link endpoints, titled pages and word lexemes.
 *  - Regression: an engine whose read drifts gives a different doctor score,
 *    orphan ratio, graph-query note, backlink count, link target or search
 *    anchor per backend.
 *  - Why existing coverage misses it: the caller tests run these reads on
 *    PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw). Page ids are serial and
 *    engine-dependent, so every case maps ids back to slugs. Each fixture has
 *    no ties where the SQL leaves the row order to the plan; reads whose
 *    order the SQL does not fix are compared sorted.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput, PageType } from '../../src/core/types.ts';
import type { EntityTypeFilter } from '../../src/core/schema-pack/entity-types.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

async function put(engine: BrainEngine, slug: string, type: PageType, frontmatter: Record<string, unknown> = {}, sourceId?: string, title?: string) {
  return engine.putPage(slug, page(title ?? slug, { type, frontmatter }), sourceId ? { sourceId } : undefined);
}

const FILTER: EntityTypeFilter = { types: ['person', 'company'], per_source: [{ source_id: 'other', types: ['person'] }] };

describe('engine parity: link reads', () => {
  parityTest(
    'inboundLinkCoverage, countEntityPages and entityGraphCoverage count the same live, entity and linked pages',
    { methods: ['putPage', 'addLink', 'addTimelineEntry', 'softDeletePage', 'inboundLinkCoverage', 'countEntityPages', 'entityGraphCoverage'] },
    async (engine, backend) => {
      const empty = await engine.inboundLinkCoverage();
      const emptyGraph = await engine.entityGraphCoverage(FILTER);
      await createSource(engine, backend, 'other');
      await put(engine, 'people/alice-example', 'person');
      await put(engine, 'people/bob-example', 'person');
      await put(engine, 'people/quarantined', 'person', { quarantine: true });
      await put(engine, 'people/gone', 'person');
      await put(engine, 'companies/acme-example', 'company');
      await put(engine, 'tools/gbrain/test/fixture', 'person');
      await put(engine, 'templates/new-person', 'person');
      await put(engine, 'notes/plain', 'note');
      await put(engine, 'people/carol-example', 'person', {}, 'other');
      await put(engine, 'companies/widget-co', 'company', {}, 'other');
      await engine.addLink('notes/plain', 'people/alice-example', '', 'mentions', 'manual');
      await engine.addLink('companies/acme-example', 'notes/plain', '', 'cites', 'manual');
      await engine.addLink('people/gone', 'people/bob-example', '', 'cites', 'manual');
      await engine.addLink('tools/gbrain/test/fixture', 'people/quarantined', '', 'cites', 'manual');
      await engine.addLink('people/carol-example', 'companies/widget-co', '', 'cites', 'manual', undefined, undefined, { fromSourceId: 'other', toSourceId: 'other' });
      await engine.addTimelineEntry('people/bob-example', { date: '2026-01-02', summary: 'Met.' });
      await engine.addTimelineEntry('people/bob-example', { date: '2026-01-03', summary: 'Met again.' });
      await engine.addTimelineEntry('templates/new-person', { date: '2026-01-02', summary: 'Template.' });
      await engine.addTimelineEntry('people/carol-example', { date: '2026-01-04', summary: 'Called.' }, { sourceId: 'other' });
      await engine.softDeletePage('people/gone');
      const coverage = {
        all: await engine.inboundLinkCoverage(),
        other: await engine.inboundLinkCoverage({ sourceIds: ['other'] }),
        none: await engine.inboundLinkCoverage({ sourceIds: [] }),
      };
      const counts = {
        all: await engine.countEntityPages(FILTER),
        unquarantined: await engine.countEntityPages(FILTER, { excludeQuarantined: true }),
        unquarantinedIgnoresSource: await engine.countEntityPages(FILTER, { excludeQuarantined: true, sourceId: 'other' }),
        other: await engine.countEntityPages(FILTER, { sourceId: 'other' }),
        blankSource: await engine.countEntityPages(FILTER, { sourceId: '' }),
        noTypes: await engine.countEntityPages({ types: [], per_source: [] }),
      };
      const graph = await engine.entityGraphCoverage(FILTER);
      expect(empty).toEqual({ livePages: 0, linkedPages: 0 });
      expect(coverage.all).toEqual({ livePages: 9, linkedPages: 5 });
      expect(counts.other).toBe(1);
      expect(graph).toEqual({ entities: 4, connected: 4, withTimeline: 2 });
      return { empty, emptyGraph, coverage, counts, graph };
    },
  );

  parityTest(
    'listJunkEntityHubs: high-degree live pages with few chunks, their connector marks and canonical twin, most edges first',
    { methods: ['putPage', 'addLink', 'sealChunks', 'softDeletePage', 'listJunkEntityHubs'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'contacts', { kind: 'google' });
      await createSource(engine, backend, 'beta');
      await createSource(engine, backend, 'alpha', { kind: 'notes' });
      const hubs: Array<[string, number, Record<string, unknown>, string?]> = [
        ['people/hub-five', 5, {}],
        ['people/hub-four', 4, { google_contact_id: 'c-1' }, 'contacts'],
        ['people/hub-three', 3, { junk_hub_exempt: true }],
        ['people/hub-six-chunky', 6, {}],
        ['people/hub-seven-gone', 7, {}],
        ['people/hub-eight', 8, { junk_hub_exempt: 'no' }],
      ];
      const leaves = Array.from({ length: 8 }, (_, i) => `notes/leaf-${i}`);
      // Every leaf has more chunks than any limit below, so only the hubs qualify.
      for (const leaf of leaves) {
        await put(engine, leaf, 'note');
        await installChunks(engine, leaf, Array.from({ length: 6 }, (_, i) => chunk(i, `leaf ${i}`)));
      }
      for (const [slug, , frontmatter, sourceId] of hubs) await put(engine, slug, 'person', frontmatter, sourceId);
      // Twins: plain and kind-notes pages of the connector hub, a twin with its own contact id, a connector source's twin.
      await put(engine, 'people/hub-four', 'person', {}, 'beta');
      await put(engine, 'people/hub-four', 'person', {}, 'alpha');
      await put(engine, 'people/hub-five', 'person', { google_contact_id: 'c-2' }, 'beta');
      await put(engine, 'people/hub-eight', 'person', {}, 'contacts');
      for (const [slug, edges, , sourceId] of hubs) {
        for (let i = 0; i < edges; i++) {
          await engine.addLink(leaves[i]!, slug, '', 'cites', 'manual', undefined, undefined, sourceId ? { toSourceId: sourceId } : undefined);
        }
      }
      // A self-link counts twice.
      await engine.addLink('people/hub-five', 'people/hub-five', '', 'cites', 'manual');
      await installChunks(engine, 'people/hub-six-chunky', [chunk(0, 'one'), chunk(1, 'two'), chunk(2, 'three')]);
      await installChunks(engine, 'people/hub-eight', [chunk(0, 'one'), chunk(1, 'two')]);
      await engine.softDeletePage('people/hub-seven-gone');
      const all = await engine.listJunkEntityHubs({ edgeThreshold: 2, maxChunks: 2, limit: 10 });
      const top = await engine.listJunkEntityHubs({ edgeThreshold: 2, maxChunks: 2, limit: 2 });
      const high = await engine.listJunkEntityHubs({ edgeThreshold: 6, maxChunks: 5, limit: 10 });
      const none = await engine.listJunkEntityHubs({ edgeThreshold: 2, maxChunks: 2, limit: 0 });
      expect(all.map(r => r.slug)).toEqual(['people/hub-eight', 'people/hub-five', 'people/hub-four']);
      expect(all.find(r => r.slug === 'people/hub-four')?.canonical_twin_source).toBe('alpha');
      return { all, top, high, none };
    },
  );

  parityTest(
    'countForeignEdges: in, out and both count the links whose other end is in another source',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'countForeignEdges'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await put(engine, 'notes/root', 'note');
      await put(engine, 'notes/local', 'note');
      await put(engine, 'notes/far', 'note', {}, 'other');
      await put(engine, 'notes/root', 'note', {}, 'other');
      await put(engine, 'notes/gone', 'note');
      const x = (from: string, to: string, fromSourceId: string, toSourceId: string, type = 'cites') =>
        engine.addLink(from, to, '', type, 'manual', undefined, undefined, { fromSourceId, toSourceId });
      await x('notes/root', 'notes/far', 'default', 'other');
      await x('notes/root', 'notes/far', 'default', 'other', 'mentions');
      await x('notes/far', 'notes/root', 'other', 'default');
      await x('notes/root', 'notes/root', 'default', 'other');
      await x('notes/root', 'notes/local', 'default', 'default');
      await x('notes/root', 'notes/root', 'default', 'default');
      await x('notes/local', 'notes/root', 'default', 'default');
      await x('notes/gone', 'notes/far', 'default', 'other');
      await engine.softDeletePage('notes/gone');
      const dirs = ['in', 'out', 'both'] as const;
      const counts: Record<string, number> = {};
      for (const d of dirs) {
        counts[`root:${d}`] = await engine.countForeignEdges('notes/root', 'default', d);
        counts[`far:${d}`] = await engine.countForeignEdges('notes/far', 'other', d);
        counts[`gone:${d}`] = await engine.countForeignEdges('notes/gone', 'default', d);
        counts[`missing:${d}`] = await engine.countForeignEdges('notes/missing', 'default', d);
      }
      expect(counts['root:out']).toBe(3);
      expect(counts['root:in']).toBe(1);
      expect(counts['root:both']).toBe(4);
      expect(counts['far:in']).toBe(3);
      return counts;
    },
  );

  parityTest(
    'listLivePageSummaries: every page not soft-deleted that the scope reads, with its type and quarantine mark',
    { methods: ['putPage', 'softDeletePage', 'listLivePageSummaries'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'shelf');
      await put(engine, 'notes/open', 'note');
      await put(engine, 'people/alice-example', 'person');
      await put(engine, 'notes/quarantined', 'note', { quarantine: 'yes' });
      await put(engine, 'notes/private', 'note', { visibility: 'private' });
      await put(engine, 'notes/gone', 'note');
      await put(engine, 'notes/far', 'concept', {}, 'other');
      await put(engine, 'notes/shelved', 'note', {}, 'shelf');
      await engine.softDeletePage('notes/gone');
      await archiveSource(engine, backend, 'shelf');
      const view = async (scope?: Parameters<BrainEngine['listLivePageSummaries']>[0]) =>
        sorted((await engine.listLivePageSummaries(scope)).map(r => `${r.slug}:${r.type}:${r.quarantined}`));
      const all = await view();
      const scoped = await view({ sourceId: 'other' });
      const many = await view({ sourceIds: ['shelf', 'other'], sourceId: 'default' });
      const blank = await view({ sourceIds: [], sourceId: '' });
      const open = await view({ excludePrivate: true });
      expect(all).toContain('notes/quarantined:note:true');
      expect(all).toContain('notes/shelved:note:false');
      expect(all).not.toContain('notes/gone:note:false');
      expect(open).not.toContain('notes/private:note:false');
      return { all, scoped, many, blank, open };
    },
  );

  parityTest(
    'countInboundLinks: same-source live referrers, mentions left out, origins live and readable',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'softDeletePage', 'countInboundLinks'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      for (const slug of ['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e', 'notes/origin-gone', 'notes/origin-open']) await put(engine, slug, 'note');
      await put(engine, 'people/target', 'person');
      await put(engine, 'notes/private', 'note', { visibility: 'private' });
      await put(engine, 'notes/origin-private', 'note', { visibility: 'private' });
      await put(engine, 'notes/far', 'note', {}, 'other');
      await put(engine, 'notes/far-origin', 'note', {}, 'other');
      await engine.addLink('notes/a', 'people/target', '', 'cites', 'manual');
      await engine.addLink('notes/b', 'people/target', '', 'mentions', 'mentions');
      await engine.addLink('notes/private', 'people/target', '', 'cites', 'manual');
      await engine.addLink('notes/far', 'people/target', '', 'cites', 'manual', undefined, undefined, { fromSourceId: 'other', toSourceId: 'default' });
      await engine.addLink('notes/e', 'people/target', '', 'cites', 'manual');
      await engine.addLinksBatch([
        { from_slug: 'notes/c', to_slug: 'people/target', link_type: 'cites', link_source: 'frontmatter', origin_slug: 'notes/origin-gone', origin_field: 'refs' },
        { from_slug: 'notes/c', to_slug: 'people/target', link_type: 'cites', link_source: 'frontmatter', origin_slug: 'notes/origin-open', origin_field: 'refs' },
        { from_slug: 'notes/d', to_slug: 'people/target', link_type: 'cites', link_source: 'frontmatter', origin_slug: 'notes/origin-private', origin_field: 'refs' },
        { from_slug: 'notes/d', to_slug: 'people/target', link_type: 'cites', link_source: 'frontmatter', origin_slug: 'notes/far-origin', origin_source_id: 'other', origin_field: 'refs' },
      ]);
      await engine.softDeletePage('notes/origin-gone');
      await engine.softDeletePage('notes/e');
      const counts: Record<string, number> = {};
      for (const excludePrivate of [false, true]) {
        for (const originSameSource of [false, true]) {
          counts[`${excludePrivate}:${originSameSource}`] = await engine.countInboundLinks('people/target', 'default', { excludePrivate, originSameSource });
        }
      }
      counts.other = await engine.countInboundLinks('people/target', 'other', { excludePrivate: false, originSameSource: false });
      counts.missing = await engine.countInboundLinks('people/missing', 'default', { excludePrivate: false, originSameSource: false });
      expect(counts['false:false']).toBe(5);
      expect(counts['true:true']).toBe(2);
      return counts;
    },
  );

  parityTest(
    'listLinkEndpointPages: the origin source\'s live pages, then other sources\' pages for missing or cross-source slugs',
    { methods: ['putPage', 'softDeletePage', 'listLinkEndpointPages'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'shelf');
      await put(engine, 'people/alice-example', 'person');
      await put(engine, 'people/bob-example', 'person');
      await put(engine, 'companies/acme-example', 'company');
      await put(engine, 'people/alice-example', 'person', {}, 'other');
      await put(engine, 'people/bob-example', 'person', {}, 'other');
      await put(engine, 'people/carol-example', 'person', {}, 'other');
      await put(engine, 'people/carol-example', 'concept', {}, 'shelf');
      await put(engine, 'people/dave-example', 'person', {}, 'shelf');
      await put(engine, 'people/gone', 'person');
      await put(engine, 'people/gone', 'person', {}, 'other');
      await engine.softDeletePage('people/gone', { sourceId: 'other' });
      await archiveSource(engine, backend, 'shelf');
      const revisions = new Map<string, string>();
      const view = async (sourceId: string, slugs: string[], cross: string[]) => {
        const rows = await engine.listLinkEndpointPages(sourceId, slugs, cross);
        const own = rows.filter(r => r.source_id === sourceId).map(r => r.slug);
        const ownFirst = rows.slice(0, own.length).every(r => r.source_id === sourceId);
        for (const r of rows) expect(typeof r.knowledge_revision).toBe('string');
        for (const r of rows) revisions.set(`${r.source_id}:${r.slug}`, r.knowledge_revision);
        return { ownFirst, rows: sorted(rows.map(r => `${r.source_id}:${r.slug}:${r.type}`)) };
      };
      const slugs = ['people/alice-example', 'people/bob-example', 'people/carol-example', 'people/dave-example', 'people/gone', 'companies/acme-example', 'people/alice-example'];
      const plain = await view('default', slugs, []);
      const cross = await view('default', slugs, ['people/bob-example']);
      const fromOther = await view('other', slugs, []);
      const nothing = await view('default', [], ['people/bob-example']);
      expect(plain.ownFirst).toBe(true);
      expect(plain.rows).toContain('shelf:people/carol-example:concept');
      expect(plain.rows).not.toContain('other:people/bob-example:person');
      expect(cross.rows).toContain('other:people/bob-example:person');
      expect(revisions.size).toBeGreaterThan(0);
      return { plain, cross, fromOther, nothing };
    },
  );

  parityTest(
    'listPagesTitledIn: live readable pages whose title the query contains, by source and slug, at most 50',
    { methods: ['putPage', 'softDeletePage', 'listPagesTitledIn'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'shelf');
      const titled: Array<[string, string, Record<string, unknown>, string?]> = [
        ['people/alice-example', 'Alice Example', {}],
        ['people/Zed', 'Acme Example', {}],
        ['people/acme-lower', 'acme example', {}],
        ['companies/aerzte', 'ÄRZTE GROUP', {}],
        ['notes/ab', 'Ab', {}],
        ['notes/quarantined', 'Alice Example', { quarantine: true }],
        ['notes/private', 'Widget Co', { visibility: 'private' }],
        ['notes/gone', 'Alice Example', {}],
        ['notes/far', 'Alice Example', {}, 'other'],
        ['notes/shelved', 'Alice Example', {}, 'shelf'],
        ['notes/unmatched', 'Nobody Here', {}],
      ];
      for (const [slug, title, frontmatter, sourceId] of titled) await put(engine, slug, 'note', frontmatter, sourceId, title);
      for (let i = 0; i < 55; i++) await put(engine, `notes/bulk-${String(i).padStart(2, '0')}`, 'note', {}, 'other', `Bulk${i % 3}`);
      await engine.softDeletePage('notes/gone');
      await archiveSource(engine, backend, 'shelf');
      const view = async (query: string, scope: Parameters<BrainEngine['listPagesTitledIn']>[1]) =>
        (await engine.listPagesTitledIn(query.toLowerCase(), scope)).map(r => `${r.source_id}:${r.slug}:${r.title}:${r.type}`);
      const q = 'What did Alice Example tell Acme Example and the ärzte group about Widget Co? ab';
      const open = await view(q, {});
      const scoped = await view(q, { sourceId: 'default' });
      const many = await view(q, { sourceIds: ['other', 'shelf'] });
      const hidden = await view(q, { excludePrivate: true });
      const bulk = await view('bulk0 bulk1 bulk2', { sourceId: 'other' });
      expect(open).toContain('default:notes/private:Widget Co:note');
      expect(hidden).not.toContain('default:notes/private:Widget Co:note');
      expect(open.some(r => r.includes('notes/ab'))).toBe(false);
      expect(bulk.length).toBe(50);
      return { open, scoped, many, hidden, bulk };
    },
  );

  parityTest(
    'wordLexemes: each word maps to its English lexemes',
    { methods: ['wordLexemes'] },
    async (engine) => {
      const words = ['running', 'the', 'cats', 'Data-Driven', 'x', '', 'naïve', 'it\'s', '2026-01-02', 'running'];
      const m = await engine.wordLexemes(words);
      expect(m.get('running')).toEqual(['run']);
      expect(m.get('the')).toEqual([]);
      return sorted([...m].map(([w, lexemes]) => `${w}=>${lexemes.join('|')}`));
    },
  );

  parityTest(
    'listLivePageSummaries, listPagesTitledIn and countInboundLinks under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'listLivePageSummaries', 'listPagesTitledIn', 'countInboundLinks'] },
    async (engine) => {
      const pages: Array<[string, Record<string, unknown>]> = [
        ['notes/open', {}], ['notes/private', { visibility: 'private' }], ['notes/readers', { readable_by: ['alice-example'] }],
        ['notes/team', { readable_by: 'group:team-a' }], ['notes/bob-only', { readable_by: ['bob-example'] }],
        ['notes/pinned', { visibility: 'private', pinned_question: true }],
      ];
      await put(engine, 'people/target', 'person', {}, undefined, 'Target Example');
      for (const [slug, frontmatter] of pages) {
        await put(engine, slug, 'note', frontmatter, undefined, `Widget ${slug.slice(6)}`);
        await engine.addLink(slug, 'people/target', '', 'cites', 'manual');
      }
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () => ({
        live: sorted((await engine.listLivePageSummaries({ excludePrivate: true })).map((r) => r.slug)),
        titled: (await engine.listPagesTitledIn('widget open widget private widget readers widget team widget bob-only widget pinned',
          { excludePrivate: true })).map((r) => r.slug),
        inbound: await engine.countInboundLinks('people/target', 'default', { excludePrivate: true, originSameSource: false }),
      }));
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:carol-example'], hidePrivate: true });
      expect(stranger.live).toEqual(['notes/open', 'people/target']);
      expect(member.live).toEqual(['notes/open', 'notes/readers', 'notes/team', 'people/target']);
      expect(granted.live).toEqual(['notes/open', 'notes/private', 'notes/readers', 'people/target']);
      expect(sorted(member.titled)).toEqual(['notes/open', 'notes/readers', 'notes/team']);
      expect([stranger.inbound, member.inbound, granted.inbound]).toEqual([1, 3, 3]);
      return { member, granted, stranger };
    },
  );
});
