/**
 * BrainEngine parity: reads a fail-soft caller used to run as raw SQL on the search, put and entity paths. On a Rust
 * brain each was refused, the caller's catch took its fallback, and the answer still looked whole: a put kept no
 * ignored-label notice, a typed search found nothing, an entity question lost its saved facts or anchored pages, a long
 * page came back at snippet size, and an entity miss lost its text mentions.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    each caller below gives the answer PGLite gives, through a typed engine member.
 *  - Regression: a caller that reads through executeRaw inside a catch drops its notice, filter fallback, facts, anchor,
 *    long-page plan or mentions on Rust while every arm still answers.
 *  - Why existing coverage misses it: the census compares outputs only for the fixture's default config, and the member
 *    parity files test members, not these callers.
 *  - Seam: none. Pages are written with `putPage`; the callers run as production code.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import { withIgnoredPrivacyLabelNotice } from '../../src/core/search/ignored-privacy-labels.ts';
import { reconcileTypeFilter } from '../../src/core/ops/search-type-filter.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { entitySavedFacts } from '../../src/core/search/entity-facts.ts';
import { CALLER_ENTITIES, callerFactRows, putCallerPages, readAsCallers } from './fact-callers.ts';
import { applyEntityAnchoring } from '../../src/core/search/entity-anchor.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const note = (title: string, frontmatter: Record<string, unknown> = {}, body = `${title}.`) => ({
  type: 'note' as const, title, compiled_truth: body, timeline: '', frontmatter,
});

/** An entity page, pages that name it or link to it, and pages the anchor must skip; each page has one chunk. */
async function putAnchorPages(engine: BrainEngine): Promise<void> {
  const put = async (slug: string, type: string, body: string, day: number, frontmatter: Record<string, unknown> = {}) => {
    await engine.putPage(slug, { type: type as 'note', title: slug === 'people/nova-example' ? 'Nova Example' : slug, compiled_truth: body,
      timeline: '', frontmatter, effective_date: new Date(Date.UTC(2026, 2, day)), effective_date_source: 'date' });
    await installChunks(engine, slug, [chunk(0, body)]);
  };
  await put('people/nova-example', 'person', 'Nova Example builds widgets.', 1);
  await put('notes/title', 'note', 'Met NOVA EXAMPLE in Lisbon.', 2);
  await put('notes/tail', 'note', 'The nova-example repo moved.', 3);
  await put('notes/linked', 'note', 'A quiet note.', 4);
  await put('notes/amends', 'note', 'An amending note.', 5);
  await put('notes/longer', 'note', 'Nova Examples are many.', 6);
  await put('notes/question', 'question', 'Where is Nova Example now?', 7);
  await put('notes/pinned', 'note', 'Nova Example pinned.', 8, { pinned_question: 'where' });
  await put('notes/gone', 'note', 'Nova Example left.', 9);
  await engine.softDeletePage('notes/gone');
  await engine.addLink('notes/linked', 'people/nova-example', '', 'works_with', 'manual');
  await engine.addLink('notes/amends', 'people/nova-example', '', 'amends', 'manual');
}

describe('engine parity: fail-soft reads on the search, put and entity paths', () => {
  parityTest('readLivePageFrontmatter answers the live page type and frontmatter, and null for a gone or missing page', {
    methods: ['putPage', 'softDeletePage', 'readLivePageFrontmatter'],
  }, async (engine) => {
    await engine.putPage('notes/labelled', note('Labelled', { access: 'maybe', tags: ['x'] }));
    await engine.putPage('notes/gone', note('Gone', { access: 'maybe' }));
    await engine.softDeletePage('notes/gone');
    const live = await engine.readLivePageFrontmatter(SRC, 'notes/labelled');
    const answer = {
      live: live && { type: live.type, access: live.frontmatter?.access },
      gone: await engine.readLivePageFrontmatter(SRC, 'notes/gone'),
      missing: await engine.readLivePageFrontmatter(SRC, 'notes/never-written'),
      otherSource: await engine.readLivePageFrontmatter('elsewhere', 'notes/labelled'),
    };
    expect(answer).toEqual({ live: { type: 'note', access: 'maybe' }, gone: null, missing: null, otherSource: null });
    return answer;
  });

  parityTest('a put that stores an access label gbrain does not recognize gets the ignored-label notice', {
    methods: ['putPage', 'readLivePageFrontmatter', 'getSource', 'getConfig'],
  }, async (engine) => {
    const content = '---\ntype: note\ntitle: Census label\naccess: maybe\n---\nCensus body.\n';
    await engine.putPage('notes/census-label', note('Census label', { access: 'maybe' }, 'Census body.'));
    const notices: Notice[] = [];
    const ctx = { engine, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as Parameters<typeof withIgnoredPrivacyLabelNotice>[0];
    const result = await withIgnoredPrivacyLabelNotice(ctx, SRC, { slug: 'notes/census-label', content },
      { status: 'created_or_updated', slug: 'notes/census-label' });
    const answer = { result, codes: notices.map(n => n.code), namesValue: notices.some(n => JSON.stringify(n).includes('maybe')) };
    expect(answer).toEqual({ result: { status: 'created_or_updated', slug: 'notes/census-label' }, codes: ['privacy_label_ignored'], namesValue: true });
    return answer;
  });

  parityTest('probePageTypes reports each type set among live pages, and lists the types only when a set has none', {
    methods: ['putPage', 'softDeletePage', 'probePageTypes'],
  }, async (engine) => {
    await engine.putPage('people/probe-a', { ...note('Probe person'), type: 'person' });
    await engine.putPage('notes/probe-a', note('Probe note'));
    await engine.putPage('memos/probe-gone', { ...note('Probe memo'), type: 'memo' as 'note' });
    await engine.softDeletePage('memos/probe-gone');
    const sorted = (p: { present: boolean[]; available: string[] | null }) => ({ ...p, available: p.available && [...p.available].sort() });
    const answer = {
      hit: sorted(await engine.probePageTypes([['person'], []], { sourceId: SRC })),
      miss: sorted(await engine.probePageTypes([['person'], ['memo', 'deal']], { sourceId: SRC })),
      otherSource: sorted(await engine.probePageTypes([['person']], { sourceId: 'elsewhere' })),
    };
    expect(answer).toEqual({
      hit: { present: [true, false], available: null },
      miss: { present: [true, false], available: ['note', 'person'] },
      otherSource: { present: [false], available: [] },
    });
    return answer;
  });

  parityTest('a typed search on a type no page has drops the filter, searches every type and names the types there are', {
    methods: ['putPage', 'probePageTypes'],
  }, async (engine) => {
    await engine.putPage('people/typed-a', { ...note('Typed person'), type: 'person' });
    await engine.putPage('notes/typed-a', note('Typed note'));
    const ctx = { engine, remote: false } as unknown as OperationContext;
    const answer = {
      dropped: await reconcileTypeFilter(ctx, { sourceId: SRC }, false, ['nosuchtype']),
      narrowed: await reconcileTypeFilter(ctx, { sourceId: SRC }, false, ['person', 'nosuchtype']),
      kept: await reconcileTypeFilter(ctx, { sourceId: SRC }, false, ['note']),
    };
    expect(answer).toEqual({
      dropped: { types: undefined, notice: 'No pages have type nosuchtype, so the type filter was dropped and every page type was searched. Page types in this brain: note, person.' },
      narrowed: { types: ['person'], notice: 'No pages have type nosuchtype; filtered to person. Page types in this brain: note, person.' },
      kept: { types: ['note'] },
    });
    return answer;
  });

  parityTest('readEntityNewestFacts reads the named slugs newest first under the caller read policy', {
    methods: ['putPage', 'insertFact', 'insertFacts', 'readEntityNewestFacts'],
  }, async (engine) => {
    await putCallerPages(engine);
    await engine.insertFacts(callerFactRows().map((r, i) => ({
      ...r, kind: 'fact' as const, visibility: 'world' as const, source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1 + i)),
    })) as never, { source_id: SRC });
    for (const [i, fact] of ['Ada leads the lab', 'Ada moved to Lisbon', 'Ada joined the board'].entries()) {
      await engine.insertFact({ fact, kind: 'fact', source: 'mcp:remember', entity_slug: i === 1 ? 'ada' : 'people/ada-example',
        visibility: i === 2 ? 'private' : 'world', valid_from: new Date(Date.UTC(2026, 0, 1 + i)) }, { source_id: SRC });
    }
    const read = async (q: { slugs: string[]; remote: boolean; worldOnly: boolean }) =>
      (await engine.readEntityNewestFacts({ sourceId: SRC, ...q })).map(r => `${r.fact}@${r.entity_slug}`);
    const answer = {
      local: await read({ slugs: ['people/ada-example', 'ada'], remote: false, worldOnly: false }),
      worldOnly: await read({ slugs: ['people/ada-example', 'ada'], remote: true, worldOnly: true }),
      otherSource: (await engine.readEntityNewestFacts({ sourceId: 'elsewhere', slugs: ['people/ada-example'], remote: false, worldOnly: false })).length,
      callers: await readAsCallers(async () => (await read({ slugs: CALLER_ENTITIES.map(([slug]) => slug), remote: true, worldOnly: false })).sort()),
    };
    expect(answer.local).toEqual(['Ada joined the board@people/ada-example', 'Ada moved to Lisbon@ada', 'Ada leads the lab@people/ada-example']);
    expect(answer.worldOnly).toEqual(['Ada moved to Lisbon@ada', 'Ada leads the lab@people/ada-example']);
    expect(answer.otherSource).toBe(0);
    expect(answer.callers.member.length).toBeGreaterThan(answer.callers.stranger.length);
    return answer;
  });

  parityTest('a search that names an entity returns its newest saved facts, capped, newest first', {
    methods: ['putPage', 'insertFact', 'readEntityNewestFacts'],
  }, async (engine) => {
    await engine.putPage('people/nova-example', { ...note('Nova Example'), type: 'person' });
    for (let i = 0; i < 7; i++) {
      await engine.insertFact({ fact: `Nova fact number ${i}`, kind: 'fact', source: 'mcp:remember', entity_slug: 'people/nova-example',
        visibility: 'world', valid_from: new Date(Date.UTC(2026, 1, 1 + i)) }, { source_id: SRC });
    }
    const entity = { pages: [{ slug: 'people/nova-example', source_id: SRC }], tokens: [0, 2] as [number, number] };
    const facts = await entitySavedFacts(engine, entity, { remote: false, excludePrivate: false });
    const answer = facts.map(f => ({ fact: f.fact, entity: f.entity_slug, linked: f.linked_from ?? null }));
    expect(answer.map(a => a.fact)).toEqual(['Nova fact number 6', 'Nova fact number 5', 'Nova fact number 4', 'Nova fact number 3', 'Nova fact number 2']);
    return answer;
  });

  parityTest('readEntityAnchoredPages reads the live entity page and the pages that name it as a word or link to it, newest first', {
    methods: ['putPage', 'sealChunks', 'softDeletePage', 'addLink', 'readEntityAnchoredPages', 'readPageTitlesById'],
  }, async (engine) => {
    await putAnchorPages(engine);
    const read = await engine.readEntityAnchoredPages(SRC, 'people/nova-example');
    const missing = await engine.readEntityAnchoredPages(SRC, 'people/never-written');
    const titles = await engine.readPageTitlesById([...read.pages.map(p => p.id), read.entity!.id, read.pages[0]!.id]);
    const answer = {
      entity: read.entity?.title ?? null,
      pages: read.pages.map(p => p.slug),
      missing: { entity: missing.entity, pages: missing.pages.length },
      titles: titles.map(t => t.title).sort(),
      idsMatch: read.pages.every(p => titles.some(t => t.id === p.id)),
    };
    expect(answer).toEqual({
      entity: 'Nova Example', pages: ['notes/linked', 'notes/tail', 'notes/title'], missing: { entity: null, pages: 0 },
      titles: ['Nova Example', 'notes/linked', 'notes/tail', 'notes/title'], idsMatch: true,
    });
    return answer;
  });

  parityTest('a current-state question about an entity puts the entity page and the pages anchored to it first', {
    methods: ['putPage', 'sealChunks', 'addLink', 'listPagesTitledIn', 'readEntityAnchoredPages', 'getChunkWindows', 'readPageTitlesById'],
  }, async (engine) => {
    await putAnchorPages(engine);
    const out = await applyEntityAnchoring(engine, 'Where does Nova Example work now?', [], { sourceId: SRC });
    const answer = { entity: out.entity, anchored: out.anchored, rows: out.results.map(r => [r.slug, r.title, r.entity_anchored]) };
    expect(answer).toEqual({
      entity: 'default:people/nova-example', anchored: 4,
      rows: [['people/nova-example', 'Nova Example', 'entity'], ['notes/linked', 'notes/linked', 'linked'],
        ['notes/tail', 'notes/tail', 'linked'], ['notes/title', 'notes/title', 'linked']],
    });
    return answer;
  });
});
