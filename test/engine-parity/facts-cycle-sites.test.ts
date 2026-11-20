/**
 * BrainEngine parity: the facts cycle, fence, phantom-redirect and file-guard statements that ran through `executeRaw`
 * in the extract_facts cycle, the phantom redirect (plain and managed), the unfenced-facts adopter, the facts home scan,
 * the fence writer and the file-body guard (src/core/engine-sql/facts-cycle.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member below returns the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) and, for a write, leaves the same rows behind.
 *  - Regression: an engine that answers one of these differently changes which fence rows a phantom redirect moves, how
 *    a fence reconcile expires, detaches and updates rows, which pages the unfenced-facts adopter numbers its rows
 *    after, what the facts home scan reports, and which file the body guard treats as replaceable; the Rust engine has
 *    no SQL, so each statement has to exist as a typed method it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none; every fact, page, link, timeline entry, version, tag and proposal is seeded through the typed members
 *    (`insertFacts`, `insertFact`, `putPage`, `addLink`, `addTimelineEntry`, `createVersion`, `addTag`,
 *    `insertTrustProposal`), except the source row with a checkout path, which `createSource` writes with harness SQL.
 *    Generated values (fact ids, page ids, timestamps) are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: title, frontmatter });
const LONG_AGO = new Date('2020-01-01T00:00:00Z');
const SRC = 'default';

/** Fixture: fenced rows (a row number on a page) through the typed `insertFacts`; returns the ids in row order. */
async function fenced(engine: BrainEngine, rows: Array<Record<string, unknown>>, sourceId = SRC): Promise<number[]> {
  const out = await engine.insertFacts(rows.map((r) => ({ kind: 'fact', visibility: 'world', source: 'fence', embedding: null, entity_slug: null, ...r })) as never, { source_id: sourceId });
  return out.ids.map(Number);
}

async function pageId(engine: BrainEngine, slug: string): Promise<number> {
  const page = await engine.getPage(slug);
  expect(page).not.toBeNull();
  return Number(page!.id);
}

describe('engine parity: facts cycle, phantom redirect and fence-guard statements', () => {
  parityTest('the phantom fact move reads the phantom rows and the canonical row numbers, then moves, detaches and re-reads them', {
    methods: ['listPhantomFactRows', 'listCanonicalFenceRowNums', 'moveFactToPage', 'listActiveFactIdsOfPage', 'listFactIdsStillOnPage'],
  }, async (engine) => {
    const [one, two, three] = await fenced(engine, [
      { fact: 'p1', row_num: 1, source_markdown_slug: 'phantom' },
      { fact: 'p2', row_num: 2, source_markdown_slug: 'phantom' },
      { fact: 'p3', row_num: 3, source_markdown_slug: 'phantom', expired_at: LONG_AGO },
    ]);
    await fenced(engine, [{ fact: 'c5', row_num: 5, source_markdown_slug: 'canon' }]);
    const phantom = await engine.listPhantomFactRows(SRC, 'phantom');
    expect(sorted(phantom.map((r) => `${r.row_num === null ? 'none' : Number(r.row_num)}`))).toEqual(['1', '2', '3']);
    expect((await engine.listCanonicalFenceRowNums(SRC, 'canon')).map((r) => Number(r.row_num))).toEqual([5]);
    const active = (await engine.listActiveFactIdsOfPage(SRC, 'phantom')).map((r) => Number(r.id));
    expect(sorted(active, String)).toEqual(sorted([one!, two!], String));
    await engine.moveFactToPage(SRC, one!, 'canon', 6);
    await engine.moveFactToPage(SRC, two!, 'canon', null);
    await engine.moveFactToPage(SRC, three!, 'canon', null);
    const onCanon = await engine.listFactIdsStillOnPage(active, 'canon');
    expect(onCanon.map((r) => Number(r.id))).toEqual([one!]);
    const after = {
      canonRows: (await engine.listCanonicalFenceRowNums(SRC, 'canon')).map((r) => Number(r.row_num)).sort((a, b) => a - b),
      phantomLeft: await engine.listPhantomFactRows(SRC, 'phantom'),
      moved: (await engine.listFactsForPage(SRC, 'canon')).map((r) => `${r.row_num === null ? 'none' : Number(r.row_num)}:${r.fact}`),
    };
    expect(after).toEqual({ canonRows: [5, 6], phantomLeft: [], moved: ['5:c5', '6:p1'] });
    return after;
  });

  parityTest('the phantom link merge repoints inbound and outbound links and re-reads the links that moved', {
    methods: ['listOwnLinkIds', 'repointInboundLinks', 'repointOutboundLinks', 'listLinkIdsOnPage', 'addLink'],
  }, async (engine) => {
    for (const slug of ['phantom', 'canon', 'other']) await engine.putPage(slug, note(slug));
    await engine.addLink('other', 'phantom', 'cites', 'mentions');
    await engine.addLink('phantom', 'other', 'cites', 'mentions');
    const [phantom, canon] = [await pageId(engine, 'phantom'), await pageId(engine, 'canon')];
    const own = (await engine.listOwnLinkIds(phantom)).map((r) => Number(r.id));
    expect(own.length).toBe(1);
    await engine.repointInboundLinks(phantom, canon);
    await engine.repointOutboundLinks(phantom, canon);
    const moved = await engine.listLinkIdsOnPage(own, canon);
    expect(moved.map((r) => Number(r.id))).toEqual(own);
    const links = {
      inbound: (await engine.getBacklinks('canon')).map((l) => `${l.from_slug}->${l.to_slug}`),
      outbound: (await engine.getLinks('canon')).map((l) => `${l.from_slug}->${l.to_slug}`),
      phantomLinks: (await engine.getLinks('phantom')).length,
      none: await engine.listLinkIdsOnPage([], canon),
    };
    expect(links).toEqual({ inbound: ['other->canon'], outbound: ['canon->other'], phantomLinks: 0, none: [] });
    return links;
  });

  parityTest('pageHasTimelineEntries says whether a page holds a timeline row', { methods: ['pageHasTimelineEntries', 'addTimelineEntry'] }, async (engine) => {
    await engine.putPage('with-timeline', note('A'));
    await engine.putPage('without', note('B'));
    await engine.addTimelineEntry('with-timeline', { date: '2026-01-01', summary: 'happened' });
    const answers = {
      withRow: await engine.pageHasTimelineEntries(await pageId(engine, 'with-timeline')),
      without: await engine.pageHasTimelineEntries(await pageId(engine, 'without')),
    };
    expect(answers).toEqual({ withRow: true, without: false });
    return answers;
  });

  parityTest('maxFenceRowNumOfPage and readFenceRowNumHint give the largest row number of a page, 0 for none', {
    methods: ['maxFenceRowNumOfPage', 'readFenceRowNumHint'],
  }, async (engine) => {
    await fenced(engine, [
      { fact: 'a1', row_num: 1, source_markdown_slug: 'n/a' },
      { fact: 'a4', row_num: 4, source_markdown_slug: 'n/a', expired_at: LONG_AGO },
      { fact: 'b2', row_num: 2, source_markdown_slug: 'n/b' },
    ]);
    const answers = {
      max: await engine.maxFenceRowNumOfPage(SRC, 'n/a'),
      hint: await engine.readFenceRowNumHint(SRC, 'n/a'),
      maxNone: await engine.maxFenceRowNumOfPage(SRC, 'n/none'),
      hintNone: await engine.readFenceRowNumHint(SRC, 'n/none'),
    };
    expect(answers).toEqual({ max: 4, hint: 4, maxNone: 0, hintNone: 0 });
    return answers;
  });

  parityTest('listRootPageSlugsAfter lists live root pages after the cursor, in slug order, skipping held slugs and capped at the take', {
    methods: ['listRootPageSlugsAfter', 'softDeletePage'],
  }, async (engine) => {
    for (const slug of ['a', 'b', 'c', 'd', 'x/y']) await engine.putPage(slug, note(slug));
    await engine.softDeletePage('d');
    const answers = {
      all: (await engine.listRootPageSlugsAfter(SRC, 10, [], '')).map((r) => r.slug),
      held: (await engine.listRootPageSlugsAfter(SRC, 10, ['b'], '')).map((r) => r.slug),
      capped: (await engine.listRootPageSlugsAfter(SRC, 2, [], '')).map((r) => r.slug),
      afterA: (await engine.listRootPageSlugsAfter(SRC, 10, [], 'a')).map((r) => r.slug),
    };
    expect(answers).toEqual({ all: ['a', 'b', 'c'], held: ['a', 'c'], capped: ['a', 'b'], afterA: ['b', 'c'] });
    return answers;
  });

  parityTest('readPageFileOrigin reads the recorded origin of a live page, of a deleted page only with includeDeleted, null for a missing page', {
    methods: ['readPageFileOrigin', 'refreshPageOrigin', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('has-origin', note('A'));
    await engine.putPage('no-origin', note('B'));
    await engine.putPage('gone', note('C'));
    await engine.refreshPageOrigin('has-origin', { sourceId: SRC, sourcePath: 'notes/has-origin.md', sourceUri: 'file:///notes/has-origin.md' });
    await engine.refreshPageOrigin('gone', { sourceId: SRC, sourcePath: 'notes/gone.md', sourceUri: 'file:///notes/gone.md' });
    await engine.softDeletePage('gone');
    const answers = {
      has: await engine.readPageFileOrigin(SRC, 'has-origin'),
      hasWithDeleted: await engine.readPageFileOrigin(SRC, 'has-origin', { includeDeleted: true }),
      none: await engine.readPageFileOrigin(SRC, 'no-origin'),
      deleted: await engine.readPageFileOrigin(SRC, 'gone'),
      deletedWithDeleted: await engine.readPageFileOrigin(SRC, 'gone', { includeDeleted: true }),
      missing: await engine.readPageFileOrigin(SRC, 'never', { includeDeleted: true }),
      otherSource: await engine.readPageFileOrigin('other-src', 'has-origin'),
    };
    expect(answers).toEqual({
      has: { source_path: 'notes/has-origin.md', source_uri: 'file:///notes/has-origin.md' },
      hasWithDeleted: { source_path: 'notes/has-origin.md', source_uri: 'file:///notes/has-origin.md' },
      none: { source_path: null, source_uri: null },
      deleted: null,
      deletedWithDeleted: { source_path: 'notes/gone.md', source_uri: 'file:///notes/gone.md' },
      missing: null,
      otherSource: null,
    });
    return answers;
  });

  parityTest('adoptFactIntoFence gives an unfenced row its fence row number and claim, and listFenceRowClaims reads the page rows', {
    methods: ['listFenceRowClaims', 'adoptFactIntoFence', 'insertFact'],
  }, async (engine) => {
    await fenced(engine, [{ fact: 'held', row_num: 1, source_markdown_slug: 'people/a-example' }]);
    const out = await engine.insertFact({ fact: 'adopt me', entity_slug: 'people/a-example', visibility: 'world', source: 't', embedding: null } as never, { source_id: SRC });
    const before = (await engine.listFenceRowClaims(SRC, 'people/a-example')).map((r) => `${Number(r.row_num)}:${r.fact}:${r.source}`);
    await engine.adoptFactIntoFence(SRC, String(out.id), 2, 'people/a-example', 'adopt me, as the fence reads it');
    // A row that already holds a number is not adopted twice.
    await engine.adoptFactIntoFence(SRC, String(out.id), 9, 'people/a-example', 'second');
    const after = (await engine.listFenceRowClaims(SRC, 'people/a-example')).map((r) => `${Number(r.row_num)}:${r.fact}:${r.source}`);
    expect({ before, after }).toEqual({
      before: ['1:held:fence'],
      after: ['1:held:fence', '2:adopt me, as the fence reads it:t'],
    });
    return { before, after };
  });

  parityTest('the fence reconcile writes: superseded_by, expire in place, detach, cell updates and the id-list expiry', {
    methods: ['listFenceRowSupersession', 'setFactSupersededBy', 'expireFactInPlace', 'expireAndDetachFact', 'updateFenceFactCells', 'expireFactsByIds'],
  }, async (engine) => {
    const [r1, r2, r3, r4, r5] = await fenced(engine, [
      { fact: 'one', row_num: 1, source_markdown_slug: 'n/page' },
      { fact: 'two', row_num: 2, source_markdown_slug: 'n/page' },
      { fact: 'three', row_num: 3, source_markdown_slug: 'n/page' },
      { fact: 'four', row_num: 4, source_markdown_slug: 'n/page' },
      { fact: 'five', row_num: 5, source_markdown_slug: 'n/page' },
    ]);
    const states = async () => (await engine.listFenceRowSupersession(SRC, 'n/page'))
      .map((r) => `${Number(r.row_num)}:${r.expired_at ? 'expired' : 'active'}:${r.superseded_by === null ? '-' : Number(r.superseded_by) === r2 ? 'two' : 'other'}`)
      .sort();
    expect(await states()).toEqual(['1:active:-', '2:active:-', '3:active:-', '4:active:-', '5:active:-']);
    await engine.setFactSupersededBy(SRC, r1!, r2!);
    await engine.expireFactInPlace(SRC, r2!);
    await engine.expireAndDetachFact(SRC, r3!);
    await engine.updateFenceFactCells(SRC, r4!, {
      kind: 'preference', visibility: 'private', notability: 'high', context: 'new context', validFrom: '2026-02-01T00:00:00.000Z',
      setValidUntil: true, validUntil: '2031-01-01T00:00:00.000Z', expiredAt: null, source: 'fence:edit', confidence: 0.4,
      claimMetric: 'arr', claimValue: 2.5, claimUnit: 'usd', claimPeriod: 'q2',
    });
    const expired = (await engine.expireFactsByIds(SRC, [r5!, r5! + 1000])).map((r) => Number(r.id));
    expect(expired).toEqual([r5]);
    expect(await engine.expireFactsByIds(SRC, [r5!])).toEqual([]);
    const after = await states();
    expect(after).toEqual(['1:active:two', '2:expired:-', '4:active:-', '5:expired:-']);
    const cells = (await engine.listFactsForPage(SRC, 'n/page')).find((r) => Number(r.row_num) === 4)!;
    const cellView = {
      kind: cells.kind, visibility: cells.visibility, notability: cells.notability, context: cells.context, source: cells.source,
      confidence: Number(cells.confidence), metric: cells.claim_metric, value: Number(cells.claim_value), unit: cells.claim_unit, period: cells.claim_period,
      from: new Date(cells.valid_from as never).toISOString(), until: new Date(cells.valid_until as never).toISOString(),
    };
    expect(cellView).toEqual({
      kind: 'preference', visibility: 'private', notability: 'high', context: 'new context', source: 'fence:edit', confidence: 0.4,
      metric: 'arr', value: 2.5, unit: 'usd', period: 'q2', from: '2026-02-01T00:00:00.000Z', until: '2031-01-01T00:00:00.000Z',
    });
    return { after, cellView };
  });

  parityTest('listHeldWideningFactIds names the facts a pending, rejected or undone visibility proposal still holds', {
    methods: ['listHeldWideningFactIds', 'insertTrustProposal'],
  }, async (engine) => {
    const [held, other, plain] = await fenced(engine, [
      { fact: 'held', row_num: 1, source_markdown_slug: 'n/page', visibility: 'private' },
      { fact: 'other action', row_num: 2, source_markdown_slug: 'n/page', visibility: 'private' },
      { fact: 'no proposal', row_num: 3, source_markdown_slug: 'n/page', visibility: 'private' },
    ]);
    await engine.insertTrustProposal({ action: 'supersede_fact', sourceId: SRC, target: { table: 'facts', id: held! + 5000 }, related: { table: 'facts', id: held! },
      before: { visibility: 'private' }, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'confirm', sourceId: SRC, target: { table: 'facts', id: other! + 5000 }, related: { table: 'facts', id: other! },
      before: { notability: 'low' }, proposer: 'parity' });
    const answers = {
      held: (await engine.listHeldWideningFactIds(SRC, [held!, other!, plain!])).map((r) => Number(r.id)),
      none: await engine.listHeldWideningFactIds(SRC, [plain!]),
    };
    expect(answers).toEqual({ held: [held], none: [] });
    return { held: answers.held.length, none: answers.none };
  });

  parityTest('the deleted-page expiry reads the page, the rows to expire and the page body; listDeletedPageSlugsWithActiveFacts names the pages', {
    methods: ['listDeletedPageSlugsWithActiveFacts', 'listExpirableFactIdsOfDeletedPage', 'readDeletedPageBody', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('chat/gone', { type: 'note', title: 'Gone', compiled_truth: 'gone body', timeline: 'gone timeline' });
    await engine.putPage('chat/live', note('Live'));
    const [goneRow, , expiredRow] = await fenced(engine, [
      { fact: 'gone row', row_num: 1, source_markdown_slug: 'chat/gone' },
      { fact: 'live row', row_num: 1, source_markdown_slug: 'chat/live' },
      { fact: 'already expired', row_num: 2, source_markdown_slug: 'chat/gone', expired_at: LONG_AGO },
    ]);
    expect(expiredRow).toBeGreaterThan(0);
    const live = { before: await engine.listDeletedPageSlugsWithActiveFacts(SRC), body: await engine.readDeletedPageBody(SRC, 'chat/gone') };
    expect(live).toEqual({ before: [], body: null });
    const id = await pageId(engine, 'chat/gone');
    await engine.softDeletePage('chat/gone');
    const answers = {
      slugs: (await engine.listDeletedPageSlugsWithActiveFacts(SRC)).map((r) => r.slug),
      ids: (await engine.listExpirableFactIdsOfDeletedPage(SRC, 'chat/gone', id)).map((r) => Number(r.id)),
      wrongPage: await engine.listExpirableFactIdsOfDeletedPage(SRC, 'chat/gone', id + 1000),
      anyPage: (await engine.listExpirableFactIdsOfDeletedPage(SRC, 'chat/gone', null)).length,
      livePage: await engine.listExpirableFactIdsOfDeletedPage(SRC, 'chat/live', null),
      body: await engine.readDeletedPageBody(SRC, 'chat/gone'),
    };
    expect(answers.slugs).toEqual(['chat/gone']);
    expect(answers.ids).toEqual([goneRow]);
    expect(answers.wrongPage).toEqual([]);
    expect(answers.anyPage).toBe(1);
    expect(answers.livePage).toEqual([]);
    expect(answers.body).toMatchObject({ compiled_truth: 'gone body', timeline: 'gone timeline' });
    return { ...answers, ids: answers.ids.length };
  });

  parityTest('listOntologyObservationSlugs lists the root pages that source an active ontology observation', {
    methods: ['listOntologyObservationSlugs', 'mergeOntologyFact', 'expireFact'],
  }, async (engine) => {
    const merge = (source: string, value: string) => engine.mergeOntologyFact({ entitySlug: 'people/a-example', dimension: 'role', value, source, validFrom: '2024-01-01' } as never);
    const first = await merge('notes', 'founder');
    const nested = await merge('area/nested', 'advisor');
    expect(nested).toBeDefined();
    await fenced(engine, [{ fact: 'plain row', row_num: 1, source_markdown_slug: 'plain' }]);
    const slugs = await engine.listOntologyObservationSlugs(SRC);
    expect(slugs.map((r) => r.slug)).toEqual(['notes']);
    expect(first.factId).not.toBeNull();
    expect(await engine.expireFact(first.factId!)).toBe(true);
    const afterExpiry = await engine.listOntologyObservationSlugs(SRC);
    expect(afterExpiry).toEqual([]);
    return { slugs, afterExpiry };
  });

  parityTest('the facts home scan reads the unfenced active rows, the rows on a holding page and the fenced rows of a missing page', {
    methods: ['scanUnfencedFactRows', 'listHeldFactRows', 'listFencedFactsOfMissingPages', 'insertFact', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('people/alpha', note('A'));
    await engine.putPage('people/deleted', note('D'));
    await engine.putPage('memory/unattributed', note('Held'));
    await engine.putPage('people/missing-home', note('M'));
    const plain = (fact: string, entity: string | null) => engine.insertFact({ fact, entity_slug: entity, visibility: 'world', source: 't', embedding: null } as never, { source_id: SRC });
    await plain('on live page', 'people/alpha');
    await plain('on deleted page', 'people/deleted');
    await plain('no page', 'people/absent');
    await plain('no entity', null);
    await fenced(engine, [
      { fact: 'held row', row_num: 1, source_markdown_slug: 'memory/unattributed', entity_slug: 'people/zed' },
      { fact: 'lives on live page', row_num: 2, source_markdown_slug: 'memory/unattributed', entity_slug: 'people/alpha' },
      { fact: 'orphan', row_num: 1, source_markdown_slug: 'people/gone-page', entity_slug: 'people/gone-page' },
      { fact: 'on live fence', row_num: 1, source_markdown_slug: 'people/alpha', entity_slug: 'people/alpha' },
    ]);
    await engine.softDeletePage('people/deleted');
    const unfenced = (await engine.scanUnfencedFactRows(SRC)).map((r) => `${r.entity_slug ?? 'null'}:${r.fact}:${r.page_exists}:${r.page_deleted}`);
    const held = (await engine.listHeldFactRows(SRC, '30')).map((r) => `${r.entity_slug}:${r.fact}:${r.from_slug}:${r.page_exists}:${r.old}`);
    const orphaned = (await engine.listFencedFactsOfMissingPages(SRC)).map((r) => `${r.slug}`);
    expect(unfenced).toEqual(['null:no entity:false:false', 'people/absent:no page:false:false', 'people/alpha:on live page:true:false', 'people/deleted:on deleted page:false:true']);
    expect(held).toEqual(['people/alpha:lives on live page:memory/unattributed:true:false', 'people/zed:held row:memory/unattributed:false:false']);
    expect(orphaned).toEqual(['people/gone-page']);
    return { unfenced, held, orphaned };
  });

  parityTest('the facts home scan reports how long a held row has waited, the dimension of an unfenced row and a soft-deleted fence page', {
    methods: ['scanUnfencedFactRows', 'listHeldFactRows', 'listFencedFactsOfMissingPages', 'insertFacts', 'putPage', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('memory/unattributed', note('Held'));
    await engine.putPage('members/ann/memory/unattributed', note('Nested'));
    await engine.putPage('people/live', note('L'));
    await engine.putPage('people/closed', note('C'));
    const ids = await fenced(engine, [
      { fact: 'about live', row_num: 1, source_markdown_slug: 'memory/unattributed', entity_slug: 'people/live' },
      { fact: 'about a nested one', row_num: 1, source_markdown_slug: 'members/ann/memory/unattributed', entity_slug: 'people/aaa' },
      { fact: 'about a holding page', row_num: 2, source_markdown_slug: 'memory/unattributed', entity_slug: 'members/ann/memory/unattributed' },
      { fact: 'a slot', row_num: 3, source_markdown_slug: 'memory/unattributed', entity_slug: 'people/live', dimension: 'city', value: 'Paris' },
      { fact: 'expired', row_num: 4, source_markdown_slug: 'memory/unattributed', entity_slug: 'people/live', expired_at: LONG_AGO },
      { fact: 'on a closed page', row_num: 1, source_markdown_slug: 'people/closed', entity_slug: 'people/closed' },
      { fact: 'on no page at all', row_num: 1, source_markdown_slug: 'people/never', entity_slug: 'people/never' },
    ]);
    expect(ids).toHaveLength(7);
    await engine.insertFacts([{ fact: 'unfenced slot', kind: 'fact', visibility: 'world', source: 'fence', embedding: null, entity_slug: 'people/live', dimension: 'role', value: 'CEO' }] as never, { source_id: SRC });
    await engine.softDeletePage('people/closed');
    const young = await engine.listHeldFactRows(SRC, '30');
    const aged = await engine.listHeldFactRows(SRC, '-1');
    const shape = (rows: typeof young) => rows.map(r => `${r.entity_slug}|${r.from_slug}|${r.old}|${/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.held_since)}|${r.valid_from instanceof Date}`);
    const unfenced = (await engine.scanUnfencedFactRows(SRC)).map(r => `${r.entity_slug}|${r.fact}|${r.dimension}|${r.page_exists}|${r.page_deleted}`);
    const missing = (await engine.listFencedFactsOfMissingPages(SRC)).map(r => r.slug);
    expect(shape(young)).toEqual(['people/aaa|members/ann/memory/unattributed|false|true|true', 'people/live|memory/unattributed|false|true|true']);
    expect(shape(aged)).toEqual(['people/aaa|members/ann/memory/unattributed|true|true|true', 'people/live|memory/unattributed|true|true|true']);
    expect(unfenced).toEqual(['people/live|unfenced slot|role|true|false']);
    expect(missing).toEqual(['people/closed', 'people/never']);
    return { young: shape(young), aged: shape(aged), unfenced, missing };
  });

  parityTest('readSourceCheckoutPath reads a source\'s checkout path, null for a source without one or none', { methods: ['readSourceCheckoutPath'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/repo');
    await createSource(engine, backend, 'bare');
    const answers = {
      repo: await engine.readSourceCheckoutPath('repo'),
      bare: await engine.readSourceCheckoutPath('bare'),
      none: await engine.readSourceCheckoutPath('nope'),
    };
    expect(answers).toEqual({ repo: '/srv/repo', bare: null, none: null });
    return answers;
  });

  parityTest('readLiveStoredBody reads a live page\'s body, with the row lock inside a transaction, null for a deleted or missing page', {
    methods: ['readLiveStoredBody', 'transaction', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('guard/live', { type: 'note', title: 'Live', compiled_truth: 'the body', timeline: 'the timeline' });
    await engine.putPage('guard/gone', note('Gone'));
    await engine.softDeletePage('guard/gone');
    const locked = await engine.transaction((tx) => tx.readLiveStoredBody(SRC, 'guard/live', true));
    const answers = {
      plain: await engine.readLiveStoredBody(SRC, 'guard/live'),
      locked,
      deleted: await engine.readLiveStoredBody(SRC, 'guard/gone'),
      missing: await engine.readLiveStoredBody(SRC, 'guard/never'),
    };
    expect(answers).toEqual({
      plain: { compiled_truth: 'the body', timeline: 'the timeline' },
      locked: { compiled_truth: 'the body', timeline: 'the timeline' },
      deleted: null,
      missing: null,
    });
    return answers;
  });

  parityTest('listPageStates gives the live page row then its newest versions, and countSegmentedVersionsOfPage counts none for inline versions', {
    methods: ['listPageStates', 'countSegmentedVersionsOfPage', 'createVersion', 'addTag'],
  }, async (engine) => {
    await engine.putPage('guard/states', { type: 'note', title: 'States', compiled_truth: 'first body', timeline: '', frontmatter: { k: 'v' } });
    await engine.addTag('guard/states', 'alpha');
    await engine.createVersion('guard/states');
    await engine.putPage('guard/states', { type: 'note', title: 'States', compiled_truth: 'second body', timeline: '', frontmatter: { k: 'v' } });
    const states = await engine.listPageStates(SRC, 'guard/states');
    expect(states.map((s) => `${s.compiled_truth}:${s.title}:${s.type}`)).toEqual(['second body:States:note', 'first body:States:note']);
    expect(states[0]!.frontmatter).toMatchObject({ k: 'v' });
    expect(states[0]!.tags).toEqual(['alpha']);
    const answers = {
      none: await engine.listPageStates(SRC, 'guard/never'),
      segmented: await engine.countSegmentedVersionsOfPage(SRC, 'guard/states'),
      missing: await engine.countSegmentedVersionsOfPage(SRC, 'guard/never'),
    };
    expect(answers).toEqual({ none: [], segmented: 0, missing: 0 });
    return { states: states.map((s) => ({ body: s.compiled_truth, tags: s.tags })), ...answers };
  });
});
