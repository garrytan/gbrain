/**
 * BrainEngine parity — the stores a page purge sweeps and the segment storage it deletes
 * (src/core/persistence/page-purge.ts sweepPurgedPage, timelineReceipts and deletePageWithSegments).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the page sweep removes the proposals, review rows, write-gate holds and receipts, facts, file records and
 *    add_timeline_entry and edit_page receipts that name one page, and the segment delete removes the page's texts, stagings and
 *    the unreferenced texts that hold its claims: each answers the same, and leaves the same rows, on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) over one seeded page with rows around it
 *    (another page, another source).
 *  - Regression: an engine that sweeps one of these stores differently leaves a purged page's claims, receipts or texts
 *    behind (or removes another page's), and the purge receipt counts the wrong rows; the Rust engine has no SQL, so each
 *    statement has to exist as a typed member it can serve.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18),
 *    so only the PGLite and Postgres page purge suites (test/page-purge*.test.ts) exercised them.
 *  - Seam: the exported functions of persistence/page-purge.ts, called with the arm's engine (a transaction handle where they
 *    write). Every row is seeded through typed writers: putPage, insertFacts, insertFact, addTakesBatch, insertDecideProposal,
 *    insertDecideReviewProposal, applyDecideReviewQueue, insertTrustProposal, upsertWriteGateHold, upsertWriteGateReceipt,
 *    upsertFile, the page-body fixtures and the write journal. The slug stores the sweep also scrubs are covered by
 *    page-purge-stores.test.ts. Generated values (ids, request ids, times) are compared by label or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { TERMINAL_AUDIT_SOURCE } from '../../src/core/facts/audit-sources.ts';
import { deletePageWithSegments, sweepPurgedPage, timelineReceipts } from '../../src/core/persistence/page-purge.ts';
import { hexOf, pageMeta, publishSegmentedPage, segmentText, stageGeneration, stagingInput } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const SLUG = 'notes/doomed';
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const PURGE_REQUEST = 'a0000000-0000-4000-8000-0000000000a0';

const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter: {} });

/** The next fence row number of each engine, so every arm numbers its rows alike. */
const rows = new WeakMap<BrainEngine, number>();
function nextRow(engine: BrainEngine): number {
  const n = (rows.get(engine) ?? 0) + 1;
  rows.set(engine, n);
  return n;
}

/** What each seeded row is called, by id, per engine: ids differ between arms, labels do not. */
const labels = new WeakMap<BrainEngine, Map<string, string>>();
const name = (engine: BrainEngine, table: string, id: number | string, label?: string) => {
  const names = labels.get(engine) ?? new Map<string, string>();
  labels.set(engine, names);
  if (label !== undefined) names.set(`${table}:${id}`, label);
  return names.get(`${table}:${id}`) ?? `${table}:<unknown>`;
};

/** A fact held by a page's fence (`insertFacts` keeps `row_num` and `source_markdown_slug`). */
async function fenced(engine: BrainEngine, label: string, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const res = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: nextRow(engine), ...extra }] as never, { source_id: sourceId });
  const id = Number(res.ids[0]);
  name(engine, 'facts', id, label);
  return id;
}

/** A fact filed on no page: the page-extraction backstop's rows carry the page as their context head. */
async function loose(engine: BrainEngine, label: string, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: 'mcp:put_page', embedding: null, ...extra } as NewFact, { source_id: sourceId });
  expect(out.status).toBe('inserted');
  name(engine, 'facts', Number(out.id), label);
  return Number(out.id);
}

/** One journal row of the page: admitted, claimed and completed with `outcome` (null: left queued). */
async function journal(engine: BrainEngine, requestId: string, operation: string, slug: string, opts: { intent?: unknown; outcome?: unknown; sourceId?: string } = {}): Promise<string> {
  const sourceId = opts.sourceId ?? SRC;
  const source = await engine.readSourceMembership(sourceId);
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation, sourceId, sourceIncarnation: source!.incarnation, pageId: null, slug,
    worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: opts.intent ?? { kind: operation, slug }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  if (opts.outcome !== undefined) {
    await engine.stampWriteClaim(row.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    await engine.completeWriteRow({
      id: row.id, state: 'committed', outcome: opts.outcome, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
      resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500, terminalReservation: 4096, probePurges: false,
    });
  }
  return row.id;
}

const receiptView = (r: { request_id: string; operation: string; slug: string; outcome?: unknown; intent?: unknown } | null) =>
  r && { operation: r.operation, slug: r.slug, outcome: r.outcome ?? null, intent: r.intent ?? null };

interface Seeded {
  doomed: number; keeper: number;
  facts: { filed: number; entity: number; marker: number; extracted: number; keeper: number; otherSource: number };
  takes: { first: number; second: number; keeper: number };
}

/**
 * The page under test with its facts, takes, proposals, review rows, held writes, gate receipts, files and journal receipts;
 * a second page, another source and another page's rows around it.
 */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<Seeded> {
  await createSource(engine, backend, OTHER);
  const doomed = await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'));
  const keeper = await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.'));
  name(engine, 'pages', doomed.id, 'doomed');
  name(engine, 'pages', keeper.id, 'keeper');
  const facts = {
    filed: await fenced(engine, 'filed', 'Doomed harbor ledger fact', { source_markdown_slug: SLUG }),
    entity: await fenced(engine, 'entity', 'Alice keeps the harbor keys', { source_markdown_slug: SLUG, entity_slug: 'people/alice', visibility: 'private' }),
    marker: await fenced(engine, 'marker', 'EXTRACTION_COMPLETE', { source_markdown_slug: SLUG, source: TERMINAL_AUDIT_SOURCE }),
    extracted: await loose(engine, 'extracted', 'Extracted harbor ledger fact', { context: 'notes/doomed — first paragraph' }),
    keeper: await fenced(engine, 'keeper', 'Keeper harbor fact', { source_markdown_slug: 'notes/keeper' }),
    otherSource: await fenced(engine, 'otherSource', 'Doomed harbor ledger fact', { source_markdown_slug: SLUG }, OTHER),
  };
  await engine.addTakesBatch([
    { page_id: doomed.id, row_num: 1, claim: 'Doomed harbor ledger fact', kind: 'take', holder: 'people/alice', weight: 0.6 },
    { page_id: doomed.id, row_num: 2, claim: 'The harbor will reopen in spring', kind: 'take', holder: 'people/bob', weight: 0.7 },
    { page_id: keeper.id, row_num: 1, claim: 'The keeper outlasts the harbor', kind: 'take', holder: 'people/alice', weight: 0.5 },
  ]);
  const taken = await engine.listTakes({ page_id: doomed.id } as never);
  const kept = await engine.listTakes({ page_id: keeper.id } as never);
  const takes = { first: Number(taken.find(t => t.claim === 'Doomed harbor ledger fact')!.id), second: Number(taken.find(t => t.claim === 'The harbor will reopen in spring')!.id), keeper: Number(kept[0]!.id) };
  name(engine, 'takes', takes.first, 'first');
  name(engine, 'takes', takes.second, 'second');
  name(engine, 'takes', takes.keeper, 'keeperTake');

  // Decide proposals, review proposals and the review queue name facts by id (a ref is the id as text).
  const proposal = (index: number, newer: number, older: number) => ({ source_id: SRC, sweep_id: 's1', pair_index: index, new_fact_id: newer, old_fact_id: older,
    direction: 'new_supersedes_old' as const, p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a' });
  await engine.insertDecideProposal(proposal(0, facts.filed, facts.keeper));
  await engine.insertDecideProposal(proposal(1, facts.keeper, facts.extracted));
  await engine.insertDecideProposal(proposal(2, facts.keeper, facts.otherSource));
  const review = (a: string, b: string) => ({ kind: 'duplicate_page', source_id: SRC, sweep_id: 'r1', a_ref: a, b_ref: b, subject: '*', visibility: null,
    p_action: 0.75, threshold: 0.6, model_resolved: 'model-a', question_version: '1', receipt: null });
  await engine.insertDecideReviewProposal(review(String(facts.filed), 'pages/x'));
  await engine.insertDecideReviewProposal(review('pages/y', String(facts.entity)));
  await engine.insertDecideReviewProposal(review(String(facts.keeper), 'pages/x'));
  const queue = (a: string, b: string) => engine.applyDecideReviewQueue({ op: 'enqueue', kind: 'duplicate_page', source_id: SRC, a_ref: a, b_ref: b, evidence: null });
  await queue(String(facts.filed), 'pages/x'); await queue('pages/y', String(facts.extracted)); await queue(String(facts.keeper), 'pages/x'); await queue('pages/z', 'pages/x');
  // Trust proposals name the page, its facts and its takes as target or related row.
  await engine.insertTrustProposal({ action: 'lower_page', sourceId: SRC, target: { table: 'pages', id: doomed.id }, before: {}, proposer: 'parity' });
  await engine.insertTrustProposal({ action: 'confirm', sourceId: SRC, target: { table: 'facts', id: facts.keeper }, related: { table: 'pages', id: doomed.id }, before: {}, proposer: 'parity' });
  await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'facts', id: facts.filed }, before: {}, proposer: 'parity' });
  await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: takes.first }, before: {}, proposer: 'parity' });
  await engine.insertTrustProposal({ action: 'confirm', sourceId: SRC, target: { table: 'facts', id: facts.keeper }, related: { table: 'takes', id: takes.second }, before: {}, proposer: 'parity' });
  await engine.insertTrustProposal({ action: 'lower_page', sourceId: SRC, target: { table: 'pages', id: keeper.id }, before: {}, proposer: 'parity' });
  await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: takes.keeper }, before: {}, proposer: 'parity' });
  // Held writes of the slug (and of the keeper and another source) and the gate receipts on the page, its rows and its holds.
  const hold = (slug: string, fingerprint: string, sourceId = SRC) => engine.upsertWriteGateHold({ kind: 'fact', source_id: sourceId, slug, fingerprint, detector_version: 1,
    tier: 'agent_written', reason_families: ['prompt_injection'], reasons: ['ignore previous instructions'], detector_error: false, payload: { fact: `held ${fingerprint}` },
    write_origin: null, request_id: null });
  const holds = { first: await hold(SLUG, 'fp-1'), second: await hold(SLUG, 'fp-2'), keeper: await hold('notes/keeper', 'fp-3'), otherSource: await hold(SLUG, 'fp-4', OTHER) };
  for (const [label, id] of Object.entries(holds)) name(engine, 'write_gate_holds', id, `hold:${label}`);
  const receipt = (table: string, id: number, label: string) => {
    name(engine, `receipt:${table}`, id, label);
    return engine.upsertWriteGateReceipt({ target_table: table as never, target_id: String(id), source_id: SRC, content_hash: `h-${table}-${id}`, tier: 'agent_written',
      detector_version: 1, verdict: 'flag', reason_families: ['standing_instruction'], reasons: ['r'], detector_error: false, request_id: null });
  };
  await receipt('pages', doomed.id, 'page:doomed'); await receipt('pages', keeper.id, 'page:keeper');
  await receipt('facts', facts.filed, 'fact:filed'); await receipt('facts', facts.keeper, 'fact:keeper');
  await receipt('takes', takes.first, 'take:first'); await receipt('takes', takes.keeper, 'take:keeper');
  await receipt('write_gate_holds', holds.first, 'hold:first'); await receipt('write_gate_holds', holds.keeper, 'hold:keeper');
  // File records: one on the page, one orphaned from it that still names its slug, one of the keeper, one of another source under the same slug.
  await engine.upsertFile({ page_slug: SLUG, page_id: doomed.id, filename: 'a.png', storage_path: 'doomed/a.png', content_hash: 'ha', size_bytes: 1 });
  await engine.upsertFile({ page_slug: SLUG, page_id: null, filename: 'b.png', storage_path: 'doomed/b.png', content_hash: 'hb', size_bytes: 2 });
  await engine.upsertFile({ page_slug: 'notes/keeper', page_id: keeper.id, filename: 'k.png', storage_path: 'keeper/k.png', content_hash: 'hk', size_bytes: 3 });
  await engine.upsertFile({ source_id: OTHER, page_slug: SLUG, page_id: null, filename: 'o.png', storage_path: 'other/o.png', content_hash: 'ho', size_bytes: 4 });
  return { doomed: doomed.id, keeper: keeper.id, facts, takes };
}

/** Journal receipts of add_timeline_entry and edit_page on the slug, and around it. */
async function seedJournal(engine: BrainEngine): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const rec = async (label: string, requestId: string, operation: string, slug: string, outcome: unknown, opts: { sourceId?: string; intent?: unknown } = {}) => {
    ids[label] = await journal(engine, requestId, operation, slug, { outcome, ...opts });
  };
  await rec('timelineA', 'b0000000-0000-4000-8000-0000000000b1', 'add_timeline_entry', SLUG, { entry: { summary: 'Harbor ledger audited', source: 'audit log' }, bullet: '- 2026-01-02 Harbor ledger audited' });
  await rec('timelineB', 'b0000000-0000-4000-8000-0000000000b2', 'add_timeline_entry', SLUG, { entry: { summary: 'Keys rotated' }, bullet: '- 2026-01-03 Keys rotated' });
  await rec('timelineNoEntry', 'b0000000-0000-4000-8000-0000000000b3', 'add_timeline_entry', SLUG, { status: 'noop' });
  await rec('edit', 'b0000000-0000-4000-8000-0000000000b4', 'edit_page', SLUG, { diff: '--- a\n+++ b\n-The harbor ledger starts here.\n+The harbor ledger, second draft.\n' });
  await rec('editNoDiff', 'b0000000-0000-4000-8000-0000000000b5', 'edit_page', SLUG, { status: 'noop' });
  await rec('putPage', 'b0000000-0000-4000-8000-0000000000b6', 'put_page', SLUG, { slug: SLUG }, { intent: { kind: 'put_page', slug: SLUG, content: 'The harbor ledger starts here.' } });
  await rec('timelineKeeper', 'b0000000-0000-4000-8000-0000000000b7', 'add_timeline_entry', 'notes/keeper', { entry: { summary: 'Keeper visited' }, bullet: '- 2026-01-04 Keeper visited' });
  await rec('timelineOtherSource', 'b0000000-0000-4000-8000-0000000000b8', 'add_timeline_entry', SLUG, { entry: { summary: 'Other source entry' }, bullet: '- other' }, { sourceId: OTHER });
  await rec('timelineC', 'b0000000-0000-4000-8000-0000000000b9', 'add_timeline_entry', SLUG, { entry: { summary: 'Third entry', source: 'memo' }, bullet: null });
  return ids;
}

/** The rows around the seeded page, as each store lists them: what a sweep leaves and what it must not touch. */
async function pageState(engine: BrainEngine, s: Seeded) {
  const factNames = (id: number | string) => name(engine, 'facts', id);
  // A ref is a fact id as text (different on each arm) or a page path.
  const ref = (value: string) => (/^\d+$/.test(value) ? factNames(value) : value);
  return {
      facts: (await engine.listFactsSince(SRC, new Date(0), { activeOnly: false, limit: 1000 } as never)).map(f => f.fact).sort(),
      factsOther: (await engine.listFactsSince(OTHER, new Date(0), { activeOnly: false, limit: 1000 } as never)).map(f => f.fact).sort(),
      decide: (await engine.listDecideProposals({ status: 'all' })).map(r => [factNames(r.new_fact_id), factNames(r.old_fact_id)]).sort(),
      reviewProposals: (await engine.listDecideReviewProposals('all')).map(r => [ref(r.a_ref), ref(r.b_ref)]).sort(),
      queue: (await engine.listDueDecideReviewQueue('duplicate_page', SRC, 100)).length,
      trust: (await engine.listTrustProposals({ status: 'all' })).map(r => [r.action, r.target_table, r.related_table]).sort(),
      holds: (await engine.listWriteGateHoldRows({ status: 'all', limit: 100 })).map(h => name(engine, 'write_gate_holds', h.id)).sort(),
      receipts: await Promise.all([['pages', s.doomed], ['pages', s.keeper], ['facts', s.facts.filed], ['facts', s.facts.keeper], ['takes', s.takes.first], ['takes', s.takes.keeper]]
        .map(async ([table, id]) => [name(engine, `receipt:${table}`, id as number), (await engine.listWriteGateReceiptsFor(table as string, String(id), 10)).length])),
      files: (await engine.listFilesForPage(s.doomed)).map(f => f.storage_path),
      filesKeeper: (await engine.listFilesForPage(s.keeper)).map(f => f.storage_path),
      };
}

describe('engine parity: the page purge sweep, its segment storage and its slug stores', () => {
  // A NUL byte: Postgres text cannot hold it, so the SQL engines' statements cannot run with one. Main's Rust deletes
  // (facts/purge_writes.rs) check the source id for NUL but not the refs.
  const refusal = (run: () => Promise<number>) => run().then(deleted => ({ deleted }), () => ({ refused: true }));
  parityTest('a NUL byte in the source id of the purge review and decide deletes is refused on every engine', {
    methods: ['deletePurgeReviewQueue', 'deletePurgeReviewProposals', 'deletePurgeDecideProposals'],
  }, async (engine) => {
    const seen = {
      queue: await refusal(() => engine.deletePurgeReviewQueue('de\0fault', ['5'])),
      proposals: await refusal(() => engine.deletePurgeReviewProposals('de\0fault', ['5'])),
      decide: await refusal(() => engine.deletePurgeDecideProposals('de\0fault', [5])),
    };
    expect(seen).toEqual({ queue: { refused: true }, proposals: { refused: true }, decide: { refused: true } });
    return seen;
  });

  // The ref case: PGLite and Postgres refuse (their text type has no NUL: invalid byte sequence 0x00); the Rust store scans its
  // keys, matches nothing and answers 0 (test/rust-expected-divergence/page_purge.tsv names the difference).
  parityTest('a NUL byte in a ref of the purge review deletes is refused on every engine', {
    methods: ['deletePurgeReviewQueue', 'deletePurgeReviewProposals'],
  }, async (engine) => {
    // A ref binds as Postgres text, which cannot hold a NUL byte; the Rust store refuses it the same way
    // (facts/purge_writes.rs), where it used to answer 0 deleted.
    const seen = {
      queueRef: await refusal(() => engine.deletePurgeReviewQueue(SRC, ['5', '5\0'])),
      proposalsRef: await refusal(() => engine.deletePurgeReviewProposals(SRC, ['5\0'])),
    };
    expect(seen).toEqual({ queueRef: { refused: true }, proposalsRef: { refused: true } });
    return seen;
  });

  parityTest('sweepPurgedPage removes the proposals, review rows, held writes, gate receipts, facts, file records and journal receipts that name the page, and nothing of another page or source', {
    methods: ['putPage', 'insertFacts', 'insertFact', 'addTakesBatch', 'listTakes', 'insertDecideProposal', 'insertDecideReviewProposal', 'applyDecideReviewQueue', 'insertTrustProposal',
      'upsertWriteGateHold', 'upsertWriteGateReceipt', 'upsertFile', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow',
      'transaction', 'listDecideProposals', 'listDecideReviewProposals', 'listDueDecideReviewQueue', 'listTrustProposals', 'listWriteGateHoldRows',
      'listWriteGateReceiptsFor', 'listFilesForPage', 'listFactsSince'],
    timeout: 120_000,
  }, async (engine, backend) => {
    const s = await seed(engine, backend);
    await seedJournal(engine);
    const state = () => pageState(engine, s);
    const before = await state();
    const out = await engine.transaction(tx => sweepPurgedPage(tx, {
      sourceId: SRC, slug: SLUG, pageId: s.doomed, requestId: PURGE_REQUEST, factIds: [s.facts.filed, s.facts.entity, s.facts.marker, s.facts.extracted],
      takeIds: [s.takes.first, s.takes.second], needles: ['Doomed harbor ledger fact', 'Alice keeps the harbor keys'], reasons: [],
      census: async () => ({ targets: [], complete: true }),
    }));
    const after = await state();
    const result = { removed: out.removed, blobs: [...out.blobs].sort(), missingCaches: out.missingCaches, complete: out.complete };
    expect(before.facts).toHaveLength(5);
    expect(result.removed).toMatchObject({ decide_review_queue: 2, decide_review_proposals: 2, decide_proposals: 2, trust_proposals: 5, write_gate_holds: 2, write_gate_receipts: 4, facts: 4, files: 2 });
    expect(result.blobs).toEqual(['doomed/a.png', 'doomed/b.png']);
    return { before, result, after };
  });

  parityTest('the sweep\'s typed deletes remove what names the page, in its source only, and answer zero for ids that name nothing', {
    methods: ['putPage', 'insertFacts', 'insertFact', 'addTakesBatch', 'listTakes', 'insertDecideProposal', 'insertDecideReviewProposal', 'applyDecideReviewQueue', 'insertTrustProposal',
      'upsertWriteGateHold', 'upsertWriteGateReceipt', 'upsertFile', 'transaction', 'listDecideProposals', 'listDecideReviewProposals', 'listDueDecideReviewQueue', 'listTrustProposals',
      'listWriteGateHoldRows', 'listWriteGateReceiptsFor', 'listFilesForPage', 'listFactsSince', 'deletePurgeReviewQueue', 'deletePurgeReviewProposals', 'deletePurgeDecideProposals',
      'deletePurgedPageTrustProposals', 'deletePurgedPageHolds', 'deletePurgedPageGateReceipts', 'deletePurgedPageFacts', 'deletePurgedPageFiles'],
    timeout: 120_000,
  }, async (engine, backend) => {
    const s = await seed(engine, backend);
    const factIds = [s.facts.filed, s.facts.entity, s.facts.marker, s.facts.extracted];
    const refs = factIds.map(String);
    const takeIds = [s.takes.first, s.takes.second];
    const before = await pageState(engine, s);
    // Nothing named: no ids, ids no row has, another source, another slug.
    const nothing = await engine.transaction(async tx => ({
      queue: [await tx.deletePurgeReviewQueue(SRC, []), await tx.deletePurgeReviewQueue(SRC, ['999999']), await tx.deletePurgeReviewQueue('nobody', refs)],
      reviews: [await tx.deletePurgeReviewProposals(SRC, []), await tx.deletePurgeReviewProposals(SRC, ['999999']), await tx.deletePurgeReviewProposals('nobody', refs)],
      decide: [await tx.deletePurgeDecideProposals(SRC, []), await tx.deletePurgeDecideProposals(SRC, [999999]), await tx.deletePurgeDecideProposals('nobody', factIds)],
      trust: [await tx.deletePurgedPageTrustProposals(SRC, 999999, [], []), await tx.deletePurgedPageTrustProposals('nobody', s.doomed, factIds, takeIds)],
      holds: [await tx.deletePurgedPageHolds(SRC, 'notes/never'), await tx.deletePurgedPageHolds('nobody', SLUG)],
      receipts: await tx.deletePurgedPageGateReceipts(999999, [], [], []),
      facts: [await tx.deletePurgedPageFacts(SRC, 'notes/never'), await tx.deletePurgedPageFacts('nobody', SLUG)],
      files: [await tx.deletePurgedPageFiles(SRC, 'notes/never', 999999), await tx.deletePurgedPageFiles('nobody', 'notes/never', 999999)],
    }));
    const untouched = await pageState(engine, s);
    const removed = await engine.transaction(async tx => {
      const holds = await tx.deletePurgedPageHolds(SRC, SLUG, s.doomed);
      return {
        queue: await tx.deletePurgeReviewQueue(SRC, refs), reviews: await tx.deletePurgeReviewProposals(SRC, refs), decide: await tx.deletePurgeDecideProposals(SRC, factIds),
        trust: await tx.deletePurgedPageTrustProposals(SRC, s.doomed, factIds, takeIds),
        holds: holds.map(id => name(engine, 'write_gate_holds', id)),
        receipts: await tx.deletePurgedPageGateReceipts(s.doomed, factIds, takeIds, holds),
        facts: await tx.deletePurgedPageFacts(SRC, SLUG), files: await tx.deletePurgedPageFiles(SRC, SLUG, s.doomed),
        again: [await tx.deletePurgedPageHolds(SRC, SLUG, s.doomed), await tx.deletePurgedPageFacts(SRC, SLUG), await tx.deletePurgedPageFiles(SRC, SLUG, s.doomed)],
      };
    });
    const after = await pageState(engine, s);
    expect(untouched).toEqual(before);
    expect(removed).toMatchObject({ queue: 2, reviews: 2, decide: 2, trust: 5, receipts: 4, facts: 4, files: ['doomed/a.png', 'doomed/b.png'], again: [[], 0, []] });
    expect(removed.holds).toHaveLength(2);
    expect(after.factsOther).toEqual(before.factsOther);
    return { before, nothing, removed, after };
  });

  parityTest('timelineReceipts lists a slug\'s add_timeline_entry receipts, and its edit_page diffs when asked, in sequence order after a cursor, up to a limit, in its source only', {
    methods: ['putPage', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transaction', 'listPageTimelineReceipts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'));
    const ids = await seedJournal(engine);
    const label = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? `unknown:${id}`;
    const view = (rows: Awaited<ReturnType<typeof timelineReceipts>>) => rows.map(r => ({ id: label(r.id), principal: `${r.principal_kind}:${r.principal_id}`, sequenceIsText: /^\d+$/.test(String(r.sequence)),
      summary: r.summary, source: r.source, bullet: r.bullet, diff: r.diff }));
    const out = await engine.transaction(async tx => {
      const all = await timelineReceipts(tx, SRC, [SLUG], 100);
      const withDiffs = await timelineReceipts(tx, SRC, [SLUG], 100, '0', true);
      const afterFirst = await timelineReceipts(tx, SRC, [SLUG], 100, all[0]!.sequence, true);
      return {
        all: view(all), withDiffs: view(withDiffs), afterFirst: view(afterFirst), limited: view(await timelineReceipts(tx, SRC, [SLUG], 2, '0', true)),
        zero: view(await timelineReceipts(tx, SRC, [SLUG], 0, '0', true)),
        twoSlugs: view(await timelineReceipts(tx, SRC, [SLUG, 'notes/keeper'], 100)),
        noSlugs: view(await timelineReceipts(tx, SRC, [], 100)),
        otherSource: view(await timelineReceipts(tx, OTHER, [SLUG], 100)),
        unknown: view(await timelineReceipts(tx, SRC, ['notes/never'], 100, '0', true)),
      };
    });
    expect(out.all.map(r => r.id)).toEqual(['timelineA', 'timelineB', 'timelineC']);
    expect(out.withDiffs.map(r => r.id)).toEqual(['timelineA', 'timelineB', 'edit', 'timelineC']);
    expect(out.otherSource.map(r => r.id)).toEqual(['timelineOtherSource']);
    expect(out.limited).toHaveLength(2);
    return out;
  });

  parityTest('deletePageWithSegments deletes a segmented page, its stagings, its texts and the unreferenced texts that hold its claims, and keeps the texts another page or a live staging needs', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'setBodyStagingState', 'flipBodyGeneration', 'readSegmentTexts',
      'readManifest', 'getPage', 'transaction', 'listPageSegmentShas', 'countPageManifestRows', 'deletePageStagings', 'deletePage', 'deletePageSegmentTexts', 'sweepPageTextsForClaims'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const claim = segmentText('Today Alice likes tea at noon\n');
    const clean = segmentText('Nothing about her here\n');
    const shared = segmentText('A text two pages share\n');
    const replaced = segmentText('The second draft of the page\n');
    const recorded = segmentText('A staged text that only a staging recorded\n');
    const orphanClaim = segmentText('An orphan that says alice likes tea\n');
    const orphanFence = segmentText('An orphan row: Alice \\| tea\n');
    const orphanClean = segmentText('An orphan that says nothing\n');
    const keptByStaging = segmentText('Another live staging holds this alice likes tea text\n');
    const elsewhere = segmentText('Texts of another source: alice likes tea\n');
    const doomed = await publishSegmentedPage(engine, 'notes/seg', [claim, clean, shared]);
    const keeper = await publishSegmentedPage(engine, 'notes/keeps', [shared]);
    // A second generation staged for the doomed page and a create's staging with no page row.
    const draft = await stageGeneration(engine, { pageId: doomed.pageId, slug: 'notes/seg', genFrom: 2, texts: [replaced] });
    const createId = 'c0000000-0000-4000-8000-0000000000c1';
    await engine.transaction(async tx => {
      await tx.openBodyStaging(stagingInput({ id: createId, slug: 'notes/seg' }));
      await tx.stageSegmentTexts(SRC, [recorded], { stagingId: createId });
    });
    // Another page's live staging holds a text that holds the claim too.
    const otherShell = (await engine.createSegmentedPageShell('notes/other-staging', pageMeta('Other'), { sourceId: SRC })).id;
    const otherStaging = await stageGeneration(engine, { pageId: otherShell, slug: 'notes/other-staging', genFrom: 1, texts: [keptByStaging] });
    await engine.stageSegmentTexts(SRC, [orphanClaim, orphanFence, orphanClean]);
    await engine.stageSegmentTexts(OTHER, [elsewhere, orphanClaim]);
    const texts = new Map<string, string>(([[claim, 'claim'], [clean, 'clean'], [shared, 'shared'], [replaced, 'replaced'], [recorded, 'recorded'], [orphanClaim, 'orphanClaim'],
      [orphanFence, 'orphanFence'], [orphanClean, 'orphanClean'], [keptByStaging, 'keptByStaging'], [elsewhere, 'elsewhere']] as const).map(([t, n]) => [hexOf(t.sha256), n]));
    const stored = async (sourceId: string) => {
      const found = await engine.readSegmentTexts(sourceId, [...texts.keys()].map(h => Uint8Array.from(Buffer.from(h, 'hex'))));
      return [...found.keys()].map(h => texts.get(h) ?? `unknown:${h}`).sort();
    };
    const state = async () => ({
      source: await stored(SRC), other: await stored(OTHER),
      page: !!(await engine.getPage('notes/seg', { sourceId: SRC })), keeper: !!(await engine.getPage('notes/keeps', { sourceId: SRC })),
      keeperManifest: (await engine.readManifest(keeper.pageId)).length, otherStagingManifest: (await engine.readManifest(otherShell, { stagingId: otherStaging.stagingId })).length,
    });
    const before = await state();
    const result = await engine.transaction(tx => deletePageWithSegments(tx, SRC, 'notes/seg', doomed.pageId, ['Alice likes tea']));
    const after = await state();
    const view = { shas: result.shas.map(h => texts.get(h) ?? `unknown:${h}`).sort(), page_body_manifest: result.page_body_manifest, page_body_stagings: result.page_body_stagings, page_segment_texts: result.page_segment_texts };
    expect(before.source).toEqual(['claim', 'clean', 'keptByStaging', 'orphanClaim', 'orphanClean', 'orphanFence', 'recorded', 'replaced', 'shared']);
    expect(draft.stagingId).not.toBe(otherStaging.stagingId);
    expect(after.page).toBe(false);
    expect(after.keeper).toBe(true);
    expect(after.other).toEqual(['elsewhere', 'orphanClaim']);
    expect(view.page_body_manifest).toBeGreaterThan(0);
    return { before, view, after };
  });

  parityTest('the segment members answer a page\'s shas, manifest rows and stagings, delete only unreferenced unrecorded texts, and sweep claim texts a chunk at a time', {
    methods: ['readSegmentTexts', 'stageSegmentTexts', 'transaction', 'listPageSegmentShas', 'countPageManifestRows', 'deletePageStagings', 'deletePage', 'deletePageSegmentTexts',
      'sweepPageTextsForClaims', 'listPageTimelineReceipts'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const kept = segmentText('Kept by the manifest alice likes tea\n');
    const doomed = await publishSegmentedPage(engine, 'notes/seg', [kept, segmentText('Second text\n')]);
    const loose = segmentText('A loose text: Alice likes tea\n');
    const clean = segmentText('A clean loose text\n');
    await engine.stageSegmentTexts(SRC, [loose, clean]);
    await engine.stageSegmentTexts(OTHER, [loose]);
    const names = new Map([[hexOf(kept.sha256), 'kept'], [hexOf(loose.sha256), 'loose'], [hexOf(clean.sha256), 'clean']]);
    const label = (h: string) => names.get(h) ?? 'second';
    const stored = async (sourceId: string) => (await engine.readSegmentTexts(sourceId, [kept.sha256, loose.sha256, clean.sha256])).size;
    const forms = ['alice likes tea'];
    const out = await engine.transaction(async tx => {
      const shas = (await tx.listPageSegmentShas(SRC, 'notes/seg', doomed.pageId)).map(label);
      const none = await tx.listPageSegmentShas(OTHER, 'notes/never', 987654);
      const manifest = [await tx.countPageManifestRows(doomed.pageId), await tx.countPageManifestRows(987654)];
      // The manifest still names its texts, so nothing it names deletes.
      const whileNamed = await tx.deletePageSegmentTexts(SRC, [hexOf(kept.sha256), 'ab'.repeat(32)]);
      const zeroBudget = await tx.sweepPageTextsForClaims(SRC, '', forms, 0);
      const swept = await tx.sweepPageTextsForClaims(SRC, '', forms, 4 * 1024 * 1024);
      const stagings = [await tx.deletePageStagings(SRC, 'notes/seg', doomed.pageId), await tx.deletePageStagings(SRC, 'notes/seg', doomed.pageId)];
      await tx.deletePage('notes/seg', { sourceId: SRC });
      const afterPage = [await tx.countPageManifestRows(doomed.pageId), await tx.deletePageSegmentTexts(SRC, [hexOf(kept.sha256)]), await tx.deletePageSegmentTexts(SRC, [])];
      return { shas, none, manifest, whileNamed, zeroBudget: { last: zeroBudget.last === null, deleted: zeroBudget.deleted }, swept: { hasLast: swept.last !== null, deleted: swept.deleted.map(label) }, stagings, afterPage,
        timeline: await tx.listPageTimelineReceipts(SRC, [SLUG], 10, '0', true) };
    });
    const after = { source: await stored(SRC), other: await stored(OTHER) };
    expect(out.whileNamed).toBe(0);
    expect(out.swept.deleted).toEqual(['loose']);
    expect(after.other).toBe(1);
    return { out, after };
  });

  parityTest('deletePageWithSegments answers zeros and deletes nothing for a page that is not segmented and has no stagings, whatever its claims', {
    methods: ['putPage', 'getPage', 'transaction', 'readSegmentTexts', 'stageSegmentTexts', 'listPageSegmentShas', 'countPageManifestRows', 'deletePageStagings', 'deletePage', 'sweepPageTextsForClaims'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const plain = await engine.putPage('notes/plain', note('Plain', 'Plain notes about the harbor.'));
    const keeper = await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.'));
    const orphan = segmentText('An orphan that says alice likes tea\n');
    await engine.stageSegmentTexts(SRC, [orphan]);
    const noClaims = await engine.transaction(tx => deletePageWithSegments(tx, SRC, 'notes/keeper', keeper.id));
    const unrelatedClaims = await engine.transaction(tx => deletePageWithSegments(tx, SRC, 'notes/none', 987654, ['a claim nobody ever stored']));
    const remaining = async () => ({ plain: !!(await engine.getPage('notes/plain', { sourceId: SRC })), keeper: !!(await engine.getPage('notes/keeper', { sourceId: SRC })),
      orphan: (await engine.readSegmentTexts(SRC, [orphan.sha256])).size });
    const before = await remaining();
    const plainGone = await engine.transaction(tx => deletePageWithSegments(tx, SRC, 'notes/plain', plain.id, []));
    const after = await remaining();
    expect(noClaims).toEqual({ shas: [], page_body_manifest: 0, page_body_stagings: 0, page_segment_texts: 0 });
    expect(plainGone).toEqual({ shas: [], page_body_manifest: 0, page_body_stagings: 0, page_segment_texts: 0 });
    expect(after).toEqual({ plain: false, keeper: false, orphan: 1 });
    return { before, noClaims, unrelatedClaims, plainGone, after };
  });
});
