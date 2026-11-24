/**
 * BrainEngine parity — the row moves of the twin merge (`mergeTwinInto`, src/core/persistence/twin-merge.ts) over the
 * typed members of src/core/engine-sql/twin-merge-moves.ts (moveTwinRelationships, moveTwinPageChildren, moveTwinFacts)
 * and the rename alias the merge records (recordRenameAlias).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), merging a twin that
 *    holds links in every role, a manual relationship date, timeline rows (one repeating the survivor's), raw data (one
 *    source the survivor has too), a file, page aliases (one the survivor has too), tags (added, import-owned and one
 *    the survivor holds as import-owned) and a fact another page asserts about it leaves the same rows on both pages:
 *    the twin's evidence moves to the survivor, repeats stay on the twin (read after a restore), the twin is
 *    soft-deleted and its slug resolves to the survivor through slug_aliases.
 *  - Regression: these statements ran through `executeRaw` in twin-merge.ts and rename-alias.ts, so a Rust brain
 *    refused `gbrain repair legacy-twins`, `origin-twins` and `moved-pages` merges by name. The rename alias case also
 *    shows the slug rename the merge records (slug_aliases) reads the same on every arm.
 *  - Why existing coverage misses it: test/origin-twins*.test.ts and test/repair-legacy-twins-6885.test.ts run on
 *    PGLite only, and the legacy-twins parity case merges a pair that holds no relationship rows.
 *  - A move onto a page that does not exist is refused on every arm and leaves the twin's rows in place (the foreign
 *    keys refuse it on SQL; the store checks the survivor).
 *  - Seam: none. Typed members only; ids are compared as slugs or by row content.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { mergeTwinInto } from '../../src/core/persistence/twin-merge.ts';

const { parityTest } = parityArms(testBackends());

const S = 'default';
const page = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body.`, timeline: '' });

async function idOf(engine: BrainEngine, slug: string): Promise<number> {
  return Number((await engine.getPage(slug, { sourceId: S, includeDeleted: true }))!.id);
}

/** The rows of `slug` the merge moves, in a stable order. */
async function rowsOf(engine: BrainEngine, slug: string) {
  const id = await idOf(engine, slug);
  const links = (await engine.getLinks(slug, { sourceId: S })).map(l => `${l.from_slug}>${l.to_slug}:${l.link_type}:${l.context ?? ''}`).sort();
  const backlinks = (await engine.getBacklinks(slug, { sourceId: S })).map(l => `${l.from_slug}>${l.to_slug}:${l.link_type}`).sort();
  const timeline = (await engine.getTimeline(slug, { sourceId: S })).map(t => `${new Date(t.date).toISOString().slice(0, 10)}:${t.summary}:${t.detail ?? ''}`).sort();
  const raw = (await engine.getRawData(slug, undefined, { sourceId: S })).map(r => `${r.source}:${JSON.stringify(r.data)}`).sort();
  const files = (await engine.listFilesForPage(id)).map(f => `${f.filename}:${f.page_slug}`).sort();
  const tags = (await engine.getTags(slug, { sourceId: S })).sort();
  const dates = (await engine.listManualLinkTransitions(slug, S)).map(t => JSON.stringify(t)).sort();
  return { links, backlinks, timeline, raw, files, tags, dates };
}

describe('engine parity: the twin merge row moves', () => {
  parityTest('mergeTwinInto moves the twin\'s evidence to the survivor and keeps repeats on the twin', {
    methods: ['putPage', 'addLink', 'writeManualLinkTransitions', 'addTimelineEntry', 'putRawData', 'upsertFile', 'setPageAliases', 'addTag',
      'insertFacts', 'moveTwinRelationships', 'moveTwinPageChildren', 'moveTwinFacts', 'recordRenameAlias', 'listSlugAliases',
      'resolveAliases', 'listActiveFactsForEntity', 'restorePage'],
    timeout: 60_000,
  }, async (engine) => {
    for (const [slug, title] of [['people/ann', 'Ann'], ['people/ann-twin', 'Ann'], ['companies/acme', 'Acme'], ['people/bob', 'Bob']] as const) {
      await engine.putPage(slug, page(title), { sourceId: S });
    }
    // Links in every role: out, in, and one the survivor already has (the twin's copy says the same thing).
    await engine.addLink('people/ann-twin', 'companies/acme', 'works at', 'works_at', 'manual');
    await engine.addLink('people/bob', 'people/ann-twin', 'knows her', 'knows', 'manual');
    await engine.addLink('people/ann', 'people/bob', 'knows him', 'knows', 'manual');
    await engine.addLink('people/ann-twin', 'people/bob', 'knows him', 'knows', 'manual');
    await engine.writeManualLinkTransitions({ from: 'people/ann-twin', to: 'companies/acme', linkType: 'works_at', sourceId: S },
      [{ kind: 'start', occurred_on: '2024-01-02' }]);
    // Timeline: one row repeats the survivor's (same date, summary and source), one is the twin's own.
    await engine.addTimelineEntry('people/ann', { date: '2024-03-01', summary: 'Joined Acme', source: 'notes', detail: 'kept' }, { sourceId: S });
    await engine.addTimelineEntry('people/ann-twin', { date: '2024-03-01', summary: 'Joined Acme', source: 'notes', detail: 'kept' }, { sourceId: S });
    await engine.addTimelineEntry('people/ann-twin', { date: '2024-05-06', summary: 'Spoke at a meetup', source: 'notes' }, { sourceId: S });
    // Raw data: the survivor has the `crm` source already, so the twin's `crm` row stays; `web` moves.
    await engine.putRawData('people/ann', 'crm', { id: 1 }, { sourceId: S });
    await engine.putRawData('people/ann-twin', 'crm', { id: 1 }, { sourceId: S });
    await engine.putRawData('people/ann-twin', 'web', { url: 'https://example.com/ann' }, { sourceId: S });
    await engine.upsertFile({ source_id: S, page_slug: 'people/ann-twin', page_id: await idOf(engine, 'people/ann-twin'), filename: 'ann.png',
      storage_path: 'files/ann.png', mime_type: 'image/png', size_bytes: 3, content_hash: 'a'.repeat(64) });
    await engine.setPageAliases('people/ann', S, ['ann']);
    await engine.setPageAliases('people/ann-twin', S, ['ann', 'annie']);
    // Tags: `vip` added on the twin moves; `alum` added on the twin claims the survivor's import-owned `alum`; `draft` is import-owned and stays.
    await engine.addTag('people/ann-twin', 'vip', { sourceId: S });
    await engine.addTag('people/ann-twin', 'alum', { sourceId: S });
    await engine.addTag('people/ann-twin', 'draft', { sourceId: S, tagSource: 'frontmatter' });
    await engine.addTag('people/ann', 'alum', { sourceId: S, tagSource: 'frontmatter' });
    // A fact another page asserts about the twin moves; the twin's own fenced fact stays.
    await engine.insertFacts([{ fact: 'Ann leads sales', kind: 'fact', entity_slug: 'people/ann-twin', visibility: 'world', source: 'test', row_num: null,
      source_markdown_slug: 'companies/acme' }] as never, { source_id: S });

    const survivor = { page_id: await idOf(engine, 'people/ann'), slug: 'people/ann' };
    const twin = { page_id: await idOf(engine, 'people/ann-twin'), slug: 'people/ann-twin' };
    const result = await engine.transaction(tx => mergeTwinInto(tx, { sourceId: S, incarnation: '00000000-0000-0000-0000-000000000000', survivor, twin }));
    const facts = (await engine.listActiveFactsForEntity(S, 'people/ann', 10)).map(f => f.fact).sort();
    const aliases = await engine.resolveAliases(['ann', 'annie'], { sourceId: S });
    const slugAliases = (await engine.listSlugAliases(S)).map(a => `${a.alias_slug}>${a.canonical_slug}`).sort();
    const live = (await engine.getPage('people/ann-twin', { sourceId: S }))?.slug ?? null;
    expect([...result.tags_moved].sort()).toEqual(['vip']);
    expect(live).toBeNull();
    // The twin's kept rows are read through a restore: a soft-deleted page reads as having none.
    expect(await engine.restorePage('people/ann-twin', { sourceId: S })).toBe(true);
    return {
      result: { links_moved: result.links_moved.length, facts_moved: result.facts_moved.length, transitions_moved: result.transitions_moved,
        tags_moved: result.tags_moved.sort(), deduplicated: result.deduplicated },
      survivor: await rowsOf(engine, 'people/ann'),
      twin: await rowsOf(engine, 'people/ann-twin'),
      bob: await rowsOf(engine, 'people/bob'),
      facts,
      aliases: Object.fromEntries([...aliases].map(([k, v]) => [k, v.map(r => r.slug).sort()])),
      slugAliases,
      live,
    };
  });
  parityTest('each row-move member answers alike when called on its own', {
    methods: ['putPage', 'addLink', 'addTimelineEntry', 'insertFacts', 'moveTwinRelationships', 'moveTwinPageChildren',
      'moveTwinFacts', 'recordRenameAlias', 'listSlugAliases', 'getTimeline'],
    timeout: 60_000,
  }, async (engine) => {
    for (const slug of ['people/cy', 'people/cy-twin', 'companies/acme']) await engine.putPage(slug, page(slug), { sourceId: S });
    await engine.addLink('people/cy-twin', 'companies/acme', 'works at', 'works_at', 'manual');
    await engine.addTimelineEntry('people/cy-twin', { date: '2024-02-03', summary: 'Started', source: 'notes' }, { sourceId: S });
    await engine.insertFacts([{ fact: 'Cy builds tools', kind: 'fact', entity_slug: 'people/cy-twin', visibility: 'world', source: 'test', row_num: null,
      source_markdown_slug: 'companies/acme' }] as never, { source_id: S });
    const [survivorId, twinId, acmeId] = [await idOf(engine, 'people/cy'), await idOf(engine, 'people/cy-twin'), await idOf(engine, 'companies/acme')];
    const named = (keys: Array<{ from_page_id: number; to_page_id: number; link_type: string }>) => keys
      .map(k => `${k.from_page_id === survivorId ? 'survivor' : k.from_page_id === twinId ? 'twin' : k.from_page_id === acmeId ? 'acme' : '?'}>`
        + `${k.to_page_id === acmeId ? 'acme' : '?'}:${k.link_type}`).sort();
    return engine.transaction(async (tx) => {
      const relations = await tx.moveTwinRelationships({ twinId, survivorId });
      const before = named(relations.before);
      const tags = await tx.moveTwinPageChildren({ sourceId: S, twinId, survivorId, twinSlug: 'people/cy-twin', survivorSlug: 'people/cy' });
      const facts = (await tx.moveTwinFacts(S, 'people/cy-twin', 'people/cy')).length;
      await tx.recordRenameAlias(S, 'people/cy-twin', 'people/cy');
      const after = named(relations.after);
      const aliases = (await tx.listSlugAliases(S)).map(a => `${a.alias_slug}>${a.canonical_slug}`).sort();
      expect({ before, after, facts, aliases }).toEqual({ before: ['twin>acme:works_at'], after: ['survivor>acme:works_at'], facts: 1,
        aliases: ['people/cy-twin>people/cy'] });
      return { before, relations: { links_moved: relations.linksMoved.length, transitions_moved: relations.transitionsMoved, deduplicated: relations.deduplicated },
        tags, facts, after, aliases,
        timeline: (await tx.getTimeline('people/cy', { sourceId: S })).map(t => t.summary) };
    });
  });
  parityTest('a move onto a page that does not exist is refused and changes nothing', {
    methods: ['putPage', 'addLink', 'addTimelineEntry', 'moveTwinRelationships', 'moveTwinPageChildren', 'getLinks', 'getTimeline'],
    timeout: 60_000,
  }, async (engine) => {
    for (const slug of ['people/dee-twin', 'companies/acme']) await engine.putPage(slug, page(slug), { sourceId: S });
    await engine.addLink('people/dee-twin', 'companies/acme', 'works at', 'works_at', 'manual');
    await engine.addTimelineEntry('people/dee-twin', { date: '2024-04-05', summary: 'Joined', source: 'notes' }, { sourceId: S });
    const twinId = await idOf(engine, 'people/dee-twin');
    const missing = 999_999;
    const refused = async (run: () => Promise<unknown>) => run().then(() => false, () => true);
    const relations = await refused(() => engine.moveTwinRelationships({ twinId, survivorId: missing }));
    const rows = await refused(() => engine.moveTwinPageChildren({ sourceId: S, twinId, survivorId: missing, twinSlug: 'people/dee-twin', survivorSlug: 'people/nobody' }));
    const links = (await engine.getLinks('people/dee-twin', { sourceId: S })).map(l => `${l.from_slug}>${l.to_slug}`);
    const timeline = (await engine.getTimeline('people/dee-twin', { sourceId: S })).map(t => t.summary);
    expect({ relations, rows, links, timeline }).toEqual({ relations: true, rows: true, links: ['people/dee-twin>companies/acme'], timeline: ['Joined'] });
    return { relations, rows, links, timeline };
  });
});
