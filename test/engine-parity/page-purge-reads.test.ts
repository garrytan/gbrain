/**
 * BrainEngine parity — the reads and tombstone edits of a page purge that ran through `executeRaw`
 * (src/core/persistence/page-purge.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readPurgeClaims, readSegmentClaims, linkStreamSlugs, readPagePurgeTombstones, listPagePurges and
 *    unpurgePage answer the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1) over one seeded page with facts (filed on it, extracted from it, an outcome marker, one
 *    about another page, one in another source), takes, links both ways, saved versions and tombstones.
 *  - Regression: an engine that answers one of these differently changes which claims a page purge searches the
 *    journal for, which belief streams it locks, which tombstones `gbrain pages purges list` shows and what `gbrain
 *    pages unpurge` clears; the Rust engine has no SQL, so each read has to exist as a typed member it can serve.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so only the PGLite and Postgres page purge suites (test/page-purge*.test.ts) exercised them.
 *  - Seam: the exported functions of persistence/page-purge.ts, called with the arm's engine (or a trusted local
 *    operation context for the two commands). Every row is seeded through the typed putPage, createVersion, insertFacts,
 *    addTakesBatch, addLink, upsertPagePurges, insertFactPurge, insertTakePurge and insertWriteRequest. Generated
 *    values (fact, take and request ids, purge times) are compared by label or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { TERMINAL_AUDIT_SOURCE } from '../../src/core/facts/audit-sources.ts';
import { linkStreamSlugs, listPagePurges, readPagePurgeTombstones, readPurgeClaims, readSegmentClaims, unpurgePage } from '../../src/core/persistence/page-purge.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const REQ = 'a0000000-0000-4000-8000-0000000000a1';
const REQ2 = 'a0000000-0000-4000-8000-0000000000a2';
const JOURNAL_KEYS = ['principal:local_cli:parity-writer', 'brain'];

const note = (title: string, body: string, source_path?: string) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter: {}, ...(source_path ? { source_path } : {}) });

function localCtx(engine: BrainEngine, remote = false): OperationContext {
  return { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote, sourceId: SRC } as unknown as OperationContext;
}

/** The next fence row number of each engine, so every arm numbers its rows alike. */
const rows = new WeakMap<BrainEngine, number>();
function nextRow(engine: BrainEngine): number {
  const n = (rows.get(engine) ?? 0) + 1;
  rows.set(engine, n);
  return n;
}

/** What each seeded fact is called, by id, per engine: ids differ between arms, labels do not. */
const labels = new WeakMap<BrainEngine, Map<number, string>>();
const label = (engine: BrainEngine, id: number | string) => labels.get(engine)?.get(Number(id)) ?? '<unknown-id>';

/** A fact held by a page's fence (`insertFacts` keeps `row_num` and `source_markdown_slug`). */
async function fenced(engine: BrainEngine, name: string, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const res = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: nextRow(engine), ...extra }] as never, { source_id: sourceId });
  const id = Number(res.ids[0]);
  labels.set(engine, (labels.get(engine) ?? new Map()).set(id, name));
  return id;
}

/** A fact filed on no page (`insertFact`): the page-extraction backstop's rows carry the page as their context head. */
async function loose(engine: BrainEngine, name: string, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: 'mcp:put_page', embedding: null, ...extra } as NewFact, { source_id: sourceId });
  expect(out.status).toBe('inserted');
  labels.set(engine, (labels.get(engine) ?? new Map()).set(Number(out.id), name));
  return Number(out.id);
}

/**
 * The page under test with facts, takes, links both ways, two saved versions (each with its own source path) and
 * tombstones of two requests; a second page, another source and another page's rows around it.
 */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<{ doomed: number; keeper: number }> {
  await createSource(engine, backend, 'other');
  const doomed = await engine.putPage('notes/doomed', note('Doomed', 'The harbor ledger starts here.', 'notes/doomed.md'));
  const keeper = await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.', 'notes/keeper.md'));
  await engine.putPage('notes/third', note('Third', 'Third notes.'));
  await engine.putPage('notes/unrelated', note('Unrelated', 'Unrelated notes.'));
  await engine.putPage('notes/unrelated-two', note('Unrelated Two', 'Unrelated notes two.'));
  // Facts: filed on the page (two visibilities, one with an entity), a short one, an outcome marker, one extracted from the
  // page and filed on none, one extracted from another page, one about another page, and one in another source.
  await fenced(engine, 'filed-world', 'Doomed harbor ledger fact', { source_markdown_slug: 'notes/doomed' });
  await fenced(engine, 'filed-entity', 'Alice keeps the harbor keys', { source_markdown_slug: 'notes/doomed', entity_slug: 'people/alice', visibility: 'private' });
  await fenced(engine, 'filed-short', 'tiny', { source_markdown_slug: 'notes/doomed' });
  await fenced(engine, 'filed-marker', 'EXTRACTION_COMPLETE', { source_markdown_slug: 'notes/doomed', source: TERMINAL_AUDIT_SOURCE });
  await loose(engine, 'extracted', 'Extracted harbor ledger fact', { context: 'notes/doomed — first paragraph' });
  await loose(engine, 'extracted-elsewhere', 'Extracted from another page entirely', { context: 'notes/unrelated — first paragraph' });
  await loose(engine, 'extracted-other-source', 'Extracted harbor ledger fact', { context: 'notes/doomed — first paragraph' }, 'other');
  await fenced(engine, 'other-page', 'Keeper harbor fact', { source_markdown_slug: 'notes/keeper' });
  await fenced(engine, 'other-source', 'Doomed harbor ledger fact', { source_markdown_slug: 'notes/doomed' }, 'other');
  // Takes: two on the page (one repeats a fact's text), one on the keeper.
  await engine.addTakesBatch([
    { page_id: doomed.id, row_num: 1, claim: 'Doomed harbor ledger fact', kind: 'take', holder: 'people/alice', weight: 0.6 },
    { page_id: doomed.id, row_num: 2, claim: 'The harbor will reopen in spring', kind: 'take', holder: 'people/bob', weight: 0.7 },
    { page_id: keeper.id, row_num: 1, claim: 'The keeper outlasts the harbor', kind: 'take', holder: 'people/alice', weight: 0.5 },
  ]);
  // Two saved versions, each of a different body and source path.
  await engine.createVersion('notes/doomed');
  await engine.putPage('notes/doomed', note('Doomed', 'The harbor ledger, second draft.', 'notes/doomed-old.md'));
  await engine.createVersion('notes/doomed');
  await engine.putPage('notes/doomed', note('Doomed', 'The harbor ledger, third draft.', 'notes/doomed.md'));
  // Links both ways, one recorded by another page's stream (origin notes/third), and one that does not touch the page.
  await engine.addLink('notes/doomed', 'notes/keeper', 'the doomed page cites the keeper', 'mentions');
  await engine.addLink('notes/keeper', 'notes/doomed', 'the keeper cites the doomed page', 'mentions');
  await engine.addLink('notes/unrelated', 'notes/doomed', 'recorded on the third page', 'mentions', 'frontmatter', 'notes/third', 'related');
  await engine.addLink('notes/unrelated', 'notes/unrelated-two', 'not about the doomed page', 'mentions');
  // Tombstones of two page purges: the page's own, and another slug's.
  await engine.upsertPagePurges({ sourceId: SRC, contentHashes: ['hash-doomed-1', 'hash-doomed-2'], slug: 'notes/doomed', requestId: REQ });
  await engine.upsertPagePurges({ sourceId: SRC, contentHashes: ['hash-gone-1'], slug: 'notes/gone', requestId: REQ2 });
  await engine.upsertPagePurges({ sourceId: 'other', contentHashes: ['hash-doomed-1'], slug: 'notes/doomed', requestId: null });
  await engine.insertFactPurge({ sourceId: SRC, visibility: 'world', subject: '*', factHash: 'fact-hash-1', requestId: REQ, actor: 'parity', reason: 'page purge' });
  await engine.insertFactPurge({ sourceId: SRC, visibility: 'private', subject: 'people/alice', factHash: 'fact-hash-2', requestId: REQ, actor: 'parity', reason: 'page purge' });
  await engine.insertFactPurge({ sourceId: SRC, visibility: 'world', subject: '*', factHash: 'fact-hash-3', requestId: REQ2, actor: 'parity', reason: 'page purge' });
  await engine.insertTakePurge({ sourceId: SRC, subject: 'notes/doomed', claimHash: 'take-hash-1', requestId: REQ });
  await engine.insertTakePurge({ sourceId: SRC, subject: 'notes/gone', claimHash: 'take-hash-2', requestId: REQ2 });
  return { doomed: doomed.id, keeper: keeper.id };
}

describe('engine parity: page purge reads and tombstone commands', () => {
  parityTest('readPurgeClaims and readSegmentClaims read the page\'s facts and takes: filed or extracted, outcome markers apart, one source only', {
    methods: ['putPage', 'insertFacts', 'insertFact', 'addTakesBatch', 'listPurgeClaimFacts', 'listPurgeClaimTakes', 'listPurgeSegmentClaims'],
  }, async (engine, backend) => {
    const { doomed, keeper } = await seed(engine, backend);
    const claims = await readPurgeClaims(engine, SRC, 'notes/doomed', doomed);
    const view = (c: Awaited<ReturnType<typeof readPurgeClaims>>) => ({
      facts: c.factRows.map(f => ({ id: label(engine, f.id), fact: f.fact, source: f.source })),
      takes: c.takeRows.map(t => ({ idIsNumber: typeof Number(t.id) === 'number', claim: t.claim })),
      needles: c.needles,
    });
    const out = {
      doomed: view(claims),
      keeper: view(await readPurgeClaims(engine, SRC, 'notes/keeper', keeper)),
      emptyPage: view(await readPurgeClaims(engine, SRC, 'notes/empty', 0)),
      otherSource: view(await readPurgeClaims(engine, 'other', 'notes/doomed', doomed)),
      segment: (await readSegmentClaims(engine, SRC, 'notes/doomed', doomed)).sort(),
      segmentKeeper: (await readSegmentClaims(engine, SRC, 'notes/keeper', keeper)).sort(),
      segmentOtherSource: (await readSegmentClaims(engine, 'other', 'notes/doomed', doomed)).sort(),
      segmentNothing: await readSegmentClaims(engine, SRC, 'notes/missing', 0),
    };
    // The page's own facts, filed on it or extracted from it, in id order; the outcome marker stays in the claims but never in the needles.
    expect(out.doomed.facts.map(f => f.id)).toEqual(['filed-world', 'filed-entity', 'filed-short', 'filed-marker', 'extracted']);
    expect(out.doomed.needles).toEqual(['Doomed harbor ledger fact', 'Alice keeps the harbor keys', 'Extracted harbor ledger fact', 'The harbor will reopen in spring']);
    expect(out.segment).toEqual(['Alice keeps the harbor keys', 'Doomed harbor ledger fact', 'Extracted harbor ledger fact', 'The harbor will reopen in spring']);
    expect(out.emptyPage.facts).toEqual([]);
    return out;
  });

  parityTest('linkStreamSlugs names the streams of every link to or from the page: the origin page\'s slug when it has one', {
    methods: ['putPage', 'addLink', 'listPageLinkStreams'],
  }, async (engine, backend) => {
    const { doomed, keeper } = await seed(engine, backend);
    const out = {
      doomed: await linkStreamSlugs(engine, SRC, doomed),
      keeper: await linkStreamSlugs(engine, SRC, keeper),
      otherSource: await linkStreamSlugs(engine, 'other', doomed),
      unknown: await linkStreamSlugs(engine, SRC, 987654),
    };
    expect(out.doomed).toEqual(['notes/doomed', 'notes/keeper', 'notes/third']);
    expect(out.otherSource).toEqual([]);
    return out;
  });

  parityTest('readPagePurgeTombstones maps content hashes to slugs for one source, newest first, up to a limit; listPagePurges lists them as the command shows', {
    methods: ['upsertPagePurges', 'listPagePurgeTombstones', 'listPagePurgeRows'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const shown = (r: Record<string, unknown>) => ({
      purges: (r.purges as Array<Record<string, unknown>>).map(p => ({ source_id: p.source_id, slug: p.slug, content_hash8: p.content_hash8, request_id: p.request_id, purgedAtIsIso: typeof p.purged_at === 'string' && !Number.isNaN(Date.parse(p.purged_at)) })),
      next: r.next,
    });
    const sortedPurges = (r: ReturnType<typeof shown>) => ({ ...r, purges: [...r.purges].sort((a, b) => `${a.source_id}/${a.slug}/${a.content_hash8}`.localeCompare(`${b.source_id}/${b.slug}/${b.content_hash8}`)) });
    const tombstones = (m: Map<string, string>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
    const out = {
      tombstones: tombstones(await readPagePurgeTombstones(engine, SRC)),
      otherSource: tombstones(await readPagePurgeTombstones(engine, 'other')),
      emptySource: tombstones(await readPagePurgeTombstones(engine, 'nobody')),
      limited: (await readPagePurgeTombstones(engine, SRC, 1)).size,
      all: sortedPurges(shown(await listPagePurges(localCtx(engine), {}))),
      oneSource: sortedPurges(shown(await listPagePurges(localCtx(engine), { source_id: 'other' }))),
      limit: shown(await listPagePurges(localCtx(engine), { limit: 1 })).purges.length,
      none: shown(await listPagePurges(localCtx(engine), { source_id: 'nobody' })),
    };
    expect(out.tombstones).toEqual([['hash-doomed-1', 'notes/doomed'], ['hash-doomed-2', 'notes/doomed'], ['hash-gone-1', 'notes/gone']]);
    expect(out.limited).toBe(1);
    expect(out.all.purges).toHaveLength(4);
    expect(out.none).toEqual({ purges: [], next: 'No page purge tombstones.' });
    return out;
  });

  parityTest('unpurgePage clears the slug\'s tombstones and the fact and take tombstones of their requests, in its source only', {
    methods: ['upsertPagePurges', 'insertFactPurge', 'insertTakePurge', 'transaction', 'lockSourceRow', 'deletePagePurgeTombstones', 'deleteFactPurgesByRequests', 'deleteTakePurgesByRequests', 'countPagePurgeTombstones'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const remaining = async () => ({
      doomed: await engine.countPagePurgeTombstones(SRC, 'notes/doomed'),
      gone: await engine.countPagePurgeTombstones(SRC, 'notes/gone'),
      otherSource: await engine.countPagePurgeTombstones('other', 'notes/doomed'),
      mapped: [...(await readPagePurgeTombstones(engine, SRC)).entries()].sort(([a], [b]) => a.localeCompare(b)),
    });
    const before = await remaining();
    const none = await unpurgePage(localCtx(engine), { slug: 'notes/never-purged' });
    const cleared = await unpurgePage(localCtx(engine), { slug: 'notes/doomed' });
    const afterFirst = await remaining();
    const again = await unpurgePage(localCtx(engine), { slug: 'notes/doomed' });
    const otherSource = await unpurgePage(localCtx(engine), { slug: 'notes/doomed', source_id: 'other' });
    const afterOther = await remaining();
    const remote = await unpurgePage(localCtx(engine, true), { slug: 'notes/gone' }).then(() => 'allowed', (e: { code?: string }) => e.code ?? 'error');
    const noSlug = await unpurgePage(localCtx(engine), {}).then(() => 'allowed', (e: { code?: string }) => e.code ?? 'error');
    const out = { before, none, cleared, afterFirst, again, otherSource, afterOther, remote, noSlug };
    expect(out.before).toMatchObject({ doomed: 2, gone: 1, otherSource: 1 });
    expect(out.cleared).toMatchObject({ slug: 'notes/doomed', source_id: SRC, cleared: 2, fact_tombstones_cleared: 2, take_tombstones_cleared: 1 });
    expect(out.afterFirst).toMatchObject({ doomed: 0, gone: 1, otherSource: 1 });
    expect(out.again).toMatchObject({ cleared: 0, fact_tombstones_cleared: 0, take_tombstones_cleared: 0 });
    expect(out.otherSource).toMatchObject({ cleared: 1, fact_tombstones_cleared: 0, take_tombstones_cleared: 0 });
    return out;
  });

  parityTest('listPurgeClaimFacts, listPurgeClaimTakes, listPurgeSegmentClaims, listPageMirrorFacts and listPageMirrorTakeHashes answer for a page, an empty page, another source and an unknown id', {
    methods: ['putPage', 'insertFacts', 'insertFact', 'addTakesBatch', 'listPurgeClaimFacts', 'listPurgeClaimTakes', 'listPurgeSegmentClaims', 'listPageMirrorFacts', 'listPageMirrorTakeHashes'],
  }, async (engine, backend) => {
    const { doomed, keeper } = await seed(engine, backend);
    const facts = async (sourceId: string, slug: string) => (await engine.listPurgeClaimFacts(sourceId, slug)).map(f => ({ id: label(engine, f.id), fact: f.fact, source: f.source }));
    const takes = async (pageId: number) => (await engine.listPurgeClaimTakes(pageId)).map(t => t.claim);
    const out = {
      facts: await facts(SRC, 'notes/doomed'),
      factsOtherSource: await facts('other', 'notes/doomed'),
      factsKeeper: await facts(SRC, 'notes/keeper'),
      factsNone: await facts(SRC, 'notes/never'),
      takes: await takes(doomed),
      takesKeeper: await takes(keeper),
      takesUnknown: [await takes(987654), await takes(-1)],
      segment: await engine.listPurgeSegmentClaims(SRC, 'notes/doomed', doomed),
      segmentNone: await engine.listPurgeSegmentClaims(SRC, 'notes/never', 987654),
      mirror: await engine.listPageMirrorFacts(SRC, 'notes/doomed'),
      mirrorOtherSource: await engine.listPageMirrorFacts('other', 'notes/doomed'),
      mirrorNone: await engine.listPageMirrorFacts(SRC, 'notes/never'),
      mirrorTakes: await engine.listPageMirrorTakeHashes(doomed),
      mirrorTakesNone: [await engine.listPageMirrorTakeHashes(987654), await engine.listPageMirrorTakeHashes(-1)],
    };
    // Five facts of the page (the outcome marker among them); the mirror drops the marker, and the two takes hash to two claims.
    expect(out.facts).toHaveLength(5);
    expect(out.takes).toEqual(['Doomed harbor ledger fact', 'The harbor will reopen in spring']);
    expect(out.mirror.map(m => m.subject).sort()).toEqual(['*', '*', '*', 'people/alice']);
    expect(out.mirrorTakes).toHaveLength(2);
    expect(out.mirrorNone).toEqual([]);
    expect(out.factsOtherSource.map(f => f.id)).toEqual(['extracted-other-source', 'other-source']);
    return out;
  });

  parityTest('listQueuedPagePurges lists the queued purge requests of a source after a sequence, by sequence, each with its page', {
    methods: ['putPage', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'listQueuedPagePurges'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const doomed = await engine.putPage('notes/doomed', note('Doomed', 'Doomed notes.'));
    const sequences: Record<string, string> = {};
    const admit = async (requestId: string, over: { operation?: string; slug?: string; intent?: unknown; sourceId?: string }, name: string) => {
      const sourceId = over.sourceId ?? SRC;
      const source = await engine.readSourceMembership(sourceId);
      await engine.lockPersistenceCounters(JOURNAL_KEYS);
      const slug = over.slug ?? 'notes/doomed';
      const row = await engine.insertWriteRequest({
        principalKind: 'local_cli', principalId: 'parity-writer', requestId, operation: over.operation ?? 'delete_page', sourceId,
        sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
        digest: 'd'.repeat(64), intent: over.intent ?? { kind: 'delete_page', slug, purge: true }, authority: { scopes: ['write'] }, intentBytes: 100,
        terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: JOURNAL_KEYS,
        clientRequestId: null, state: 'queued', deferredRefreshId: null,
      });
      sequences[name] = String(row.sequence);
    };
    await admit('b0000000-0000-4000-8000-0000000000b1', {}, 'first');
    await admit('b0000000-0000-4000-8000-0000000000b2', { slug: 'notes/no-page' }, 'no-page');
    await admit('b0000000-0000-4000-8000-0000000000b3', { intent: { kind: 'delete_page', purge: false } }, 'soft');
    await admit('b0000000-0000-4000-8000-0000000000b4', { operation: 'put_page' }, 'put');
    await admit('b0000000-0000-4000-8000-0000000000b5', { intent: { kind: 'delete_page' } }, 'plain');
    await admit('b0000000-0000-4000-8000-0000000000b6', { sourceId: 'other' }, 'other');
    await admit('b0000000-0000-4000-8000-0000000000b7', { slug: 'notes/doomed' }, 'last');
    const view = async (sourceId: string, after: string, limit: number) =>
      (await engine.listQueuedPagePurges(sourceId, after, limit)).map(r => ({ idIsUuid: /^[0-9a-f-]{36}$/.test(r.id), slug: r.slug, page: r.page_id === null ? null : r.page_id === doomed.id ? 'doomed' : 'other' }));
    const out = {
      all: await view(SRC, '0', 32),
      afterFirst: await view(SRC, sequences.first!, 32),
      afterLast: await view(SRC, sequences.last!, 32),
      limited: await view(SRC, '0', 1),
      zero: await view(SRC, '0', 0),
      otherSource: await view('other', '0', 32),
      noSource: await view('nobody', '0', 32),
    };
    expect(out.all.map(r => r.slug)).toEqual(['notes/doomed', 'notes/no-page', 'notes/doomed']);
    expect(out.all.map(r => r.page)).toEqual(['doomed', null, 'doomed']);
    expect(out.afterLast).toEqual([]);
    expect(out.limited).toHaveLength(1);
    return out;
  });

  parityTest('readPurgePageBody, listPageVersionBodiesForPurge, listPageVersionSourcePaths and countPageCascadeRows read the page\'s stored body, versions and cascade', {
    methods: ['putPage', 'createVersion', 'upsertChunks', 'addTimelineEntry', 'addTakesBatch', 'readPurgePageBody', 'listPageVersionBodiesForPurge', 'listPageVersionSourcePaths', 'countPageCascadeRows'],
  }, async (engine, backend) => {
    const { doomed, keeper } = await seed(engine, backend);
    await engine.upsertChunks('notes/doomed', [{ chunk_index: 0, chunk_text: 'The harbor ledger', chunk_source: 'compiled_truth' }, { chunk_index: 1, chunk_text: 'starts here', chunk_source: 'compiled_truth' }]);
    await engine.addTimelineEntry('notes/doomed', { date: '2026-01-02', summary: 'first entry' });
    await engine.addTimelineEntry('notes/doomed', { date: '2026-01-03', summary: 'second entry' });
    const versions = (await engine.listPageVersionBodiesForPurge(doomed)).map(v => ({
      title: v.title, type: v.type, compiled_truth: v.compiled_truth, timeline: v.timeline, frontmatter: v.frontmatter, tags: v.tags,
      body_storage: v.body_storage, body_generation: v.body_generation ?? null, hashIsText: typeof v.content_hash === 'string' }));
    const body = await engine.readPurgePageBody(doomed);
    const out = {
      body: body && { hashIsText: typeof body.content_hash === 'string', body_generation: body.body_generation },
      bodyKeeper: (await engine.readPurgePageBody(keeper))?.body_generation,
      bodyUnknown: [await engine.readPurgePageBody(987654), await engine.readPurgePageBody(-1)],
      versions,
      versionsUnknown: [await engine.listPageVersionBodiesForPurge(987654), await engine.listPageVersionBodiesForPurge(-1)],
      paths: await engine.listPageVersionSourcePaths(doomed),
      pathsKeeper: await engine.listPageVersionSourcePaths(keeper),
      pathsUnknown: await engine.listPageVersionSourcePaths(987654),
      cascade: await engine.countPageCascadeRows(doomed),
      cascadeKeeper: await engine.countPageCascadeRows(keeper),
      cascadeUnknown: [await engine.countPageCascadeRows(987654), await engine.countPageCascadeRows(-1)],
    };
    expect(out.versions.map(v => v.compiled_truth)).toEqual(['The harbor ledger, second draft.', 'The harbor ledger starts here.']);
    expect(out.paths).toEqual(['notes/doomed-old.md', 'notes/doomed.md']);
    expect(out.cascade).toEqual({ chunks: 2, versions: 2, takes: 2, timeline: 2 });
    expect(out.cascadeKeeper).toEqual({ chunks: 0, versions: 0, takes: 1, timeline: 0 });
    return out;
  });

  parityTest('insertPageFactPurges tombstones each distinct claim of the page once, outcome markers apart, and refuses a request id that is no uuid', {
    methods: ['putPage', 'insertFacts', 'insertFact', 'insertPageFactPurges', 'isFactPurged'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    // Fingerprints of purge tombstones are of the normalized claim: a differently written repeat is purged with it.
    await fenced(engine, 'repeat', 'doomed HARBOR ledger fact.', { source_markdown_slug: 'notes/doomed' });
    const purged = async (sourceId: string, visibility: 'private' | 'world', claim: string, entity: string | null) => engine.isFactPurged(sourceId, visibility, claim, entity);
    const probe = async () => ({
      filed: await purged(SRC, 'world', 'Doomed harbor ledger fact', null),
      repeat: await purged(SRC, 'world', 'DOOMED harbor ledger fact', null),
      entity: await purged(SRC, 'private', 'Alice keeps the harbor keys', 'people/alice'),
      entityOtherSubject: await purged(SRC, 'private', 'Alice keeps the harbor keys', 'people/bob'),
      extracted: await purged(SRC, 'private', 'Extracted harbor ledger fact', null),
      marker: await purged(SRC, 'private', 'EXTRACTION_COMPLETE', null),
      otherPage: await purged(SRC, 'world', 'Keeper harbor fact', null),
      otherSource: await purged('other', 'world', 'Doomed harbor ledger fact', null),
    });
    const before = await probe();
    await engine.insertPageFactPurges(SRC, 'notes/doomed', REQ, 'owner:local');
    await engine.insertPageFactPurges(SRC, 'notes/doomed', REQ2, 'owner:other');
    const after = await probe();
    await engine.insertPageFactPurges(SRC, 'notes/empty', REQ, 'owner:local');
    await engine.insertPageFactPurges('nobody', 'notes/empty', REQ, 'owner:local');
    const refused = await engine.insertPageFactPurges(SRC, 'notes/doomed', 'not-a-uuid', 'owner:local').then(() => 'allowed', () => 'refused');
    expect(Object.values(before).some(Boolean)).toBe(false);
    expect(after).toEqual({ filed: true, repeat: true, entity: true, entityOtherSubject: false, extracted: true, marker: false, otherPage: false, otherSource: false });
    return { before, after, refused };
  });

  parityTest('deletePagePurgeTombstones, deleteFactPurgesByRequests and deleteTakePurgesByRequests remove one slug\'s or one request\'s tombstones, in their source only', {
    methods: ['upsertPagePurges', 'insertFactPurge', 'insertTakePurge', 'deletePagePurgeTombstones', 'deleteFactPurgesByRequests', 'deleteTakePurgesByRequests', 'countPagePurgeTombstones'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const state = async () => ({
      doomed: await engine.countPagePurgeTombstones(SRC, 'notes/doomed'), gone: await engine.countPagePurgeTombstones(SRC, 'notes/gone'), other: await engine.countPagePurgeTombstones('other', 'notes/doomed'),
    });
    const before = await state();
    const none = await engine.deletePagePurgeTombstones(SRC, 'notes/never');
    const empty = [await engine.deleteFactPurgesByRequests(SRC, []), await engine.deleteTakePurgesByRequests(SRC, [])];
    const unknownRequest = [await engine.deleteFactPurgesByRequests(SRC, ['a0000000-0000-4000-8000-0000000000ff']), await engine.deleteTakePurgesByRequests(SRC, ['a0000000-0000-4000-8000-0000000000ff'])];
    const otherSource = [await engine.deleteFactPurgesByRequests('other', [REQ]), await engine.deleteTakePurgesByRequests('other', [REQ])];
    const badUuid = await engine.deleteFactPurgesByRequests(SRC, ['not-a-uuid']).then(() => 'allowed', () => 'refused');
    const slugless = await engine.deletePagePurgeTombstones('other', 'notes/doomed');
    const cleared = (await engine.deletePagePurgeTombstones(SRC, 'notes/doomed')).sort();
    const repeated = await engine.deletePagePurgeTombstones(SRC, 'notes/doomed');
    const facts = await engine.deleteFactPurgesByRequests(SRC, [REQ, REQ]);
    const takes = await engine.deleteTakePurgesByRequests(SRC, [REQ]);
    const factsAgain = await engine.deleteFactPurgesByRequests(SRC, [REQ]);
    const after = await state();
    const out = { before, none, empty, unknownRequest, otherSource, badUuid, slugless, cleared, repeated, facts, takes, factsAgain, after };
    expect(out.cleared).toEqual([REQ, REQ]);
    expect(out.slugless).toEqual([null]);
    expect(out).toMatchObject({ facts: 2, takes: 1, factsAgain: 0, after: { doomed: 0, gone: 1, other: 0 } });
    return out;
  });

  parityTest('listPageLinkStreams, listPagePurgeTombstones and listPagePurgeRows answer directly: one source or all, newest first, up to a limit, an unknown page or source empty', {
    methods: ['putPage', 'addLink', 'upsertPagePurges', 'listPageLinkStreams', 'listPagePurgeTombstones', 'listPagePurgeRows'],
  }, async (engine, backend) => {
    const { doomed, keeper } = await seed(engine, backend);
    const rowsView = (rows: Awaited<ReturnType<BrainEngine['listPagePurgeRows']>>) =>
      rows.map(r => ({ source_id: r.source_id, slug: r.slug, content_hash: r.content_hash, request_id: r.request_id, purgedAtIsDate: !Number.isNaN(new Date(r.purged_at).getTime()) }))
        .sort((a, b) => `${a.source_id}/${a.content_hash}`.localeCompare(`${b.source_id}/${b.content_hash}`));
    const out = {
      streams: [await engine.listPageLinkStreams(SRC, doomed), await engine.listPageLinkStreams(SRC, keeper), await engine.listPageLinkStreams('other', doomed), await engine.listPageLinkStreams(SRC, 987654), await engine.listPageLinkStreams(SRC, -1)],
      tombstones: (await engine.listPagePurgeTombstones(SRC, 10)).map(t => [t.content_hash, t.slug]).sort(),
      tombstonesLimited: (await engine.listPagePurgeTombstones(SRC, 1)).length,
      tombstonesZero: await engine.listPagePurgeTombstones(SRC, 0),
      tombstonesOther: (await engine.listPagePurgeTombstones('other', 10)).map(t => [t.content_hash, t.slug]),
      tombstonesNone: await engine.listPagePurgeTombstones('nobody', 10),
      rowsAll: rowsView(await engine.listPagePurgeRows(null, 10)),
      rowsOther: rowsView(await engine.listPagePurgeRows('other', 10)),
      rowsLimited: (await engine.listPagePurgeRows(null, 1)).length,
      rowsNone: await engine.listPagePurgeRows('nobody', 10),
    };
    expect(out.streams[0]).toEqual(['notes/doomed', 'notes/keeper', 'notes/third']);
    expect(out.rowsAll).toHaveLength(4);
    expect(out.rowsOther[0]).toMatchObject({ request_id: null, purgedAtIsDate: true });
    return out;
  });
});
