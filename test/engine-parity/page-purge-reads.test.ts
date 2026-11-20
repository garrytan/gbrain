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
    methods: ['putPage', 'insertFacts', 'insertFact', 'addTakesBatch', 'executeRaw'],
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
    methods: ['putPage', 'addLink', 'executeRaw'],
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
    methods: ['upsertPagePurges', 'executeRaw'],
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
    methods: ['upsertPagePurges', 'insertFactPurge', 'insertTakePurge', 'transaction', 'countPagePurgeTombstones', 'executeRaw'],
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
});
