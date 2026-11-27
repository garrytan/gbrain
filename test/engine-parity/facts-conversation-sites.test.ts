/**
 * BrainEngine parity: the group 5 facts statements of conversation fact publication and relink
 * (src/core/engine-sql/facts-conversation.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the 30 members below return the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): the journal reads of a conversation batch, the newest, highest,
 *    active and total counts of a page's extractor rows, the window key counts, moves and stamps, the clear of a page's prior
 *    batch (expire what a loop, a successor or a relink holds, delete the rest), the outcome-row delete, the slot hash read, the
 *    purge-tombstone match, the merged-alias read, the extraction page count, the relink publication reads, the reextract
 *    memo reads, the two planner row reads, the entity-hint page read, the page lock, the cleared relinked rows and the
 *    embedded-fact count.
 *  - Regression: an engine that answers one of these differently publishes a replacement batch over the wrong rows, deletes a
 *    row an open loop holds, counts a window wrong (so a collection looks settled when it is not), links a fact to the wrong
 *    entity, or re-extracts a page it should skip. The Rust engine has no SQL, so each read has to exist as a typed method it
 *    can implement or refuse (rust/docs/store/facts.md).
 *  - Why existing coverage misses it: these statements ran through `executeRaw` inside src/core/facts/*.ts, which the parity
 *    cases cannot call (D18), so no case compared them across engines.
 *  - Seam: pages, facts, aliases, open loops, tombstones and sources are seeded through the typed members (`putPage`,
 *    `updateSlug`, `insertFacts`, `mergeOntologyFact`, `upsertOpenLoop`, `insertFactPurge`); the harness fixtures `createSource`,
 *    `archiveSource` and `restrictFolder` write the rest with SQL, and the Rust arm stops there on the typed raw_sql refusal.
 *    The write journal (persistence_requests, persistence_counters) is seeded through the typed journal members
 *    (`readSourceMembership`, `lockPersistenceCounters`, `insertWriteRequest`, `stampWriteClaim`, `completeWriteRow`), so its four
 *    reads are compared on queued, failed, committed and other-slug batch requests as well as on the empty journal; a
 *    request is compacted through the typed `compactTerminalIntent` member, so every arm, the Rust one included, compares. The
 *    request join is also pinned by the SQL text pin (test/facts-conversation-sites-sql-pin.test.ts). Generated values (ids)
 *    are compared by relation, never by value.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, basisEmbedding, parityArms, restrictFolder, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const PAGE = 'conversations/c1';
const EXTRACTOR = 'cli:extract-conversation-facts';
const TERMINAL = 'cli:extract-conversation-facts:terminal:v2';
const NON_EXTRACTABLE = 'cli:extract-conversation-facts:non-extractable:v2';
const LEGACY_TERMINAL = 'cli:extract-conversation-facts:terminal';
const REQUEST = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
const WRITER = { kind: 'local_cli', id: 'writer-1' };
const WRITER_KEYS = ['principal:local_cli:writer-1', 'brain'];
const CLAIM = 'c0000000-0000-4000-8000-0000000000c1';
const req = (n: number) => `b0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const note = (title: string, body = 'body', frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: body, frontmatter });

/** The next fence row number of each engine, so every arm numbers its rows alike. */
const rows = new WeakMap<BrainEngine, number>();
function nextRow(engine: BrainEngine): number {
  const n = (rows.get(engine) ?? 0) + 1;
  rows.set(engine, n);
  return n;
}

/** An extractor row of a conversation page: database-only (no row number), as the extractor writes it. Returns the id as a number. */
async function derived(engine: BrainEngine, slug: string, text: string, extra: Partial<NewFact> & Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const out = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'private', source: EXTRACTOR, ...extra,
    row_num: null, source_markdown_slug: slug } as never], { source_id: sourceId });
  return Number(out.ids[0]);
}

/** A fact held by a page's fence (`row_num` set). */
async function fenced(engine: BrainEngine, slug: string, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const out = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', ...extra,
    row_num: nextRow(engine), source_markdown_slug: slug } as never], { source_id: sourceId });
  return Number(out.ids[0]);
}

/** The ids as labels, so an answer names a row by the claim the case wrote. */
const labels = (named: Record<string, number>) => new Map(Object.entries(named).map(([label, id]) => [id, label]));
const nameOf = (names: Map<number, string>, id: number | string) => names.get(Number(id)) ?? `unknown:${id}`;

/** Every fact of the default source as (claim, expired), by claim: the extractor's database-only rows are not fence rows, so no page read lists them. */
async function state(engine: BrainEngine) {
  const found = await engine.listFactsSince(SRC, new Date(0), { activeOnly: false, limit: 500 } as never);
  return sorted(found.map(r => ({ fact: r.fact, expired: r.expired_at !== null })), r => r.fact);
}

/** One conversation batch request in the write journal, queued; returns its journal id. `pages` are the batch's stored entries. */
async function enqueueBatch(engine: BrainEngine, requestId: string, pages: Array<Record<string, unknown>>, over: { slug?: string; digest?: string } = {}): Promise<string> {
  const source = await engine.readSourceMembership(SRC);
  return engine.transaction(async tx => {
    await tx.lockPersistenceCounters(WRITER_KEYS);
    return (await tx.insertWriteRequest({
      principalKind: WRITER.kind, principalId: WRITER.id, requestId, operation: 'submit_job', sourceId: SRC,
      sourceIncarnation: source!.incarnation, pageId: null, slug: over.slug ?? PAGE, worktreeId: null, topologyGeneration: null,
      digest: over.digest ?? 'a'.repeat(64), intent: { kind: 'submit_job', pages }, authority: { scopes: ['write'] }, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: WRITER_KEYS,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    })).id;
  });
}

/** Claim a queued request and finish it in `state`. */
async function settleBatch(engine: BrainEngine, id: string, state: 'committed' | 'failed', errorCode: string | null): Promise<void> {
  await engine.transaction(async tx => {
    await tx.lockPersistenceCounters(WRITER_KEYS);
    await tx.stampWriteClaim(id, CLAIM, 60_000, JSON.stringify({ phase: 'parity' }));
    await tx.completeWriteRow({
      id, state, outcome: state === 'committed' ? { published: true } : null, errorCode, errorMessage: errorCode === null ? null : 'the batch did not publish',
      consumerVersion: 'parity', consumerHostId: null, errorDetail: null, resultBytes: 1200, counterKeys: WRITER_KEYS, intentBytes: 100,
      retainedBytes: 1500, terminalReservation: 4096, probePurges: false,
    });
  });
}

/** Compacts a settled request through the typed compaction member (journal.ts finishTerminal's step), on every engine. */
async function markCompacted(engine: BrainEngine, id: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.lockPersistenceCounters(WRITER_KEYS);
    await tx.compactTerminalIntent({ id, left: 1500, reservation: 4096, counterKeys: WRITER_KEYS });
  });
}

const win = (occurrence: number, ordinal: number, sha: string) => ({ occurrence_id: occurrence, window_ordinal: ordinal, window_text_sha: sha });

describe('engine parity: group 5 facts conversation publication and relink statements', () => {
  parityTest('the write journal reads answer the empty journal: no spent request, no batch request, no stored entry, no counters', {
    methods: ['findSpentConversationRequest', 'listConversationBatchRequests', 'readStoredConversationEntry', 'readPrincipalCounters'],
  }, async (engine) => {
    const spent = await engine.findSpentConversationRequest('local_cli', 'writer-1', REQUEST, 'digest');
    const batches = await engine.listConversationBatchRequests('local_cli', 'writer-1', SRC, PAGE);
    const stored = await engine.readStoredConversationEntry(REQUEST, 'generation-1');
    const counters = await engine.readPrincipalCounters('principal:local_cli:writer-1');
    expect({ spent, batches, stored, counters }).toEqual({ spent: null, batches: [], stored: null, counters: null });
    return { spent, batches, stored, counters };
  });

  parityTest('the write journal reads see seeded batch requests: spent ids, unsettled and failed batches in order, stored entries and counters', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transaction',
      'findSpentConversationRequest', 'listConversationBatchRequests', 'readStoredConversationEntry', 'readPrincipalCounters', 'compactTerminalIntent'],
  }, async (engine) => {
    const entry = (generation: string, attempt: number) => ({ generation, attempt, slug: PAGE, text: `window ${generation}` });
    const queued = await enqueueBatch(engine, req(1), [entry('g1', 1), entry('g2', 2)]);
    const failed = await enqueueBatch(engine, req(2), [entry('g3', 1)]);
    const committed = await enqueueBatch(engine, req(3), [entry('g4', 1)]);
    const compacted = await enqueueBatch(engine, req(4), [entry('g5', 1)]);
    const elsewhere = await enqueueBatch(engine, req(5), [entry('g6', 1)], { slug: 'conversations/c2' });
    const settledCompacted = await enqueueBatch(engine, req(6), [entry('g7', 1)]);
    await settleBatch(engine, failed, 'failed', 'conversation_batch_failed');
    await settleBatch(engine, committed, 'committed', null);
    await settleBatch(engine, compacted, 'failed', 'conversation_batch_failed');
    await settleBatch(engine, settledCompacted, 'committed', null);
    const counters = await engine.readPrincipalCounters(WRITER_KEYS[0]!);
    // The compaction pass, which has no typed member, marks the two settled requests compacted.
    await markCompacted(engine, compacted);
    await markCompacted(engine, settledCompacted);
    const names = new Map([[queued, 'queued'], [failed, 'failed'], [committed, 'committed'], [compacted, 'compacted'], [elsewhere, 'elsewhere'], [settledCompacted, 'settledCompacted']]);
    const nameOf = (id: string) => names.get(id) ?? `unknown:${id}`;
    const spentOf = async (n: number, digest: string) => (await engine.findSpentConversationRequest(WRITER.kind, WRITER.id, req(n), digest))?.request_id === req(n);
    const batchView = async (slug: string) => (await engine.listConversationBatchRequests(WRITER.kind, WRITER.id, SRC, slug)).map(b => ({
      keys: Object.keys(b).sort(), id: nameOf(b.id), request_id: b.request_id === req(Number(b.request_id.slice(-2))) ? Number(b.request_id.slice(-2)) : b.request_id,
      state: b.state, error_code: b.error_code, members: b.members }));
    const out = {
      spent: {
        sameDigest: await spentOf(1, 'a'.repeat(64)), otherDigest: await spentOf(1, 'b'.repeat(64)), compactedFailed: await spentOf(4, 'a'.repeat(64)),
        compactedCommitted: await spentOf(6, 'a'.repeat(64)), committed: await spentOf(3, 'a'.repeat(64)), unknown: await spentOf(99, 'a'.repeat(64)),
        otherWriter: await engine.findSpentConversationRequest('local_cli', 'writer-2', req(1), 'b'.repeat(64)),
      },
      batches: await batchView(PAGE), elsewhere: await batchView('conversations/c2'), none: await batchView('conversations/none'),
      otherWriter: await engine.listConversationBatchRequests('local_cli', 'writer-2', SRC, PAGE),
      stored: {
        first: await engine.readStoredConversationEntry(queued, 'g1'), second: await engine.readStoredConversationEntry(queued, 'g2'),
        failed: await engine.readStoredConversationEntry(failed, 'g3'), committed: await engine.readStoredConversationEntry(committed, 'g4'),
        wrongGeneration: await engine.readStoredConversationEntry(queued, 'g3'), compacted: await engine.readStoredConversationEntry(compacted, 'g5'),
        unknownRow: await engine.readStoredConversationEntry(req(77), 'g1'),
      },
      counters: counters && { keys: Object.keys(counters).sort(), outstanding: Number(counters.outstanding_count), terminal: Number(counters.terminal_bytes), lifetime: Number(counters.lifetime_ids) },
      brain: (await engine.readPrincipalCounters(WRITER_KEYS[1]!)) !== null,
      noCounters: await engine.readPrincipalCounters('principal:local_cli:nobody'),
    };
    expect(out.spent).toEqual({ sameDigest: false, otherDigest: true, compactedFailed: true, compactedCommitted: false, committed: false, unknown: false, otherWriter: null });
    expect(out.batches.map(b => [b.id, b.state, b.error_code])).toEqual([['queued', 'queued', null], ['failed', 'failed', 'conversation_batch_failed']]);
    expect(out.batches[0]!.members).toEqual([{ generation: 'g1', attempt: 1 }, { generation: 'g2', attempt: 2 }]);
    expect(out.elsewhere.map(b => b.id)).toEqual(['elsewhere']);
    expect({ none: out.none, otherWriter: out.otherWriter }).toEqual({ none: [], otherWriter: [] });
    expect(out.stored.first).toEqual(entry('g1', 1) as never);
    expect(out.stored.second).toEqual(entry('g2', 2) as never);
    expect(out.stored.compacted).toBeNull();
    expect(out.stored.wrongGeneration).toBeNull();
    // Six requests were admitted and four settled: two stay outstanding.
    expect(out.counters).toMatchObject({ outstanding: 2, lifetime: 6 });
    return out;
  });

  parityTest('the page counts: newest id, highest row number, active and total extractor rows, audit rows aside, and the held slots', {
    methods: ['putPage', 'insertFacts', 'expireFact', 'readNewestConversationFactId', 'maxConversationRowNum', 'countActiveConversationFacts',
      'countPageConversationFacts', 'listHeldFactSlots'],
  }, async (engine) => {
    await engine.putPage(PAGE, note('Chat'));
    const noneNewest = await engine.readNewestConversationFactId(SRC, PAGE);
    const noneTop = await engine.maxConversationRowNum(SRC, PAGE);
    const a = await derived(engine, PAGE, 'alpha');
    const b = await derived(engine, PAGE, 'bravo');
    const gone = await derived(engine, PAGE, 'charlie');
    const audit = await derived(engine, PAGE, 'EXTRACTION_COMPLETE', { source: TERMINAL });
    const other = await derived(engine, 'conversations/c2', 'elsewhere');
    const held = await fenced(engine, PAGE, 'a fence row', { source: 'mcp:remember' });
    await derived(engine, PAGE, 'slotted', { entity_slug: 'people/a', dimension: 'role', value: 'cto', valid_from: new Date('2024-01-01T00:00:00Z') });
    expect(await engine.expireFact(gone)).toBe(true);
    expect(other).toBeGreaterThan(audit);
    const newest = await engine.readNewestConversationFactId(SRC, PAGE);
    const top = await engine.maxConversationRowNum(SRC, PAGE);
    const slots = await engine.listHeldFactSlots(SRC, PAGE);
    const out = {
      noneNewest, noneTop,
      newestIsLast: Number(newest) > audit && Number(newest) !== other,
      top: top === null ? null : Number(top),
      active: await engine.countActiveConversationFacts(SRC, PAGE),
      page: await engine.countPageConversationFacts(SRC, PAGE),
      otherPage: await engine.countPageConversationFacts(SRC, 'conversations/c2'),
      slots: slots.map(s => ({ entity_slug: s.entity_slug, dimension: s.dimension, hashed: /^[0-9a-f]+$/.test(s.value_hash), valid_from: new Date(s.valid_from).toISOString() })),
      noSlots: await engine.listHeldFactSlots(SRC, 'conversations/none'),
    };
    expect(out).toEqual({
      noneNewest: null, noneTop: null, newestIsLast: true, top: 1,
      active: 3, page: 4, otherPage: 1,
      slots: [{ entity_slug: 'people/a', dimension: 'role', hashed: true, valid_from: '2024-01-01T00:00:00.000Z' }],
      noSlots: [],
    });
    expect([a, b, held].every(id => id > 0)).toBe(true);
    return out;
  });

  parityTest('stamping, counting and moving source windows: a key counts the active anchored rows, the rest are outside', {
    methods: ['putPage', 'insertFacts', 'expireFact', 'stampConversationSourceWindows', 'countConversationWindowFacts',
      'countConversationFactsOutsideWindows', 'moveConversationSourceWindows'],
  }, async (engine) => {
    await engine.putPage(PAGE, note('Chat'));
    const f1 = await derived(engine, PAGE, 'one');
    const f2 = await derived(engine, PAGE, 'two');
    const f3 = await derived(engine, PAGE, 'three');
    await derived(engine, PAGE, 'four');
    const f5 = await derived(engine, PAGE, 'five');
    await derived(engine, PAGE, 'EXTRACTION_COMPLETE', { source: TERMINAL });
    await engine.stampConversationSourceWindows([{ id: f1, w: win(1, 1, 'x') }, { id: f2, w: win(1, 1, 'x') }, { id: f3, w: win(1, 2, 'y') }, { id: f5, w: win(1, 1, 'x') }]);
    expect(await engine.expireFact(f5)).toBe(true);
    const before = {
      x: await engine.countConversationWindowFacts(SRC, PAGE, '1:1:x'),
      y: await engine.countConversationWindowFacts(SRC, PAGE, '1:2:y'),
      none: await engine.countConversationWindowFacts(SRC, PAGE, '9:9:z'),
      outsideX: await engine.countConversationFactsOutsideWindows(SRC, PAGE, ['1:1:x']),
      outsideBoth: await engine.countConversationFactsOutsideWindows(SRC, PAGE, ['1:1:x', '1:2:y']),
      outsideNone: await engine.countConversationFactsOutsideWindows(SRC, PAGE, []),
    };
    expect(before).toEqual({ x: 2, y: 1, none: 0, outsideX: 2, outsideBoth: 1, outsideNone: 4 });
    expect(await engine.moveConversationSourceWindows(SRC, PAGE, [{ from: '1:2:y', to: win(9, 5, 'z') }, { from: '1:1:x', to: win(1, 1, 'x2') }])).toBeUndefined();
    const after = {
      x: await engine.countConversationWindowFacts(SRC, PAGE, '1:1:x'),
      x2: await engine.countConversationWindowFacts(SRC, PAGE, '1:1:x2'),
      y: await engine.countConversationWindowFacts(SRC, PAGE, '1:2:y'),
      z: await engine.countConversationWindowFacts(SRC, PAGE, '9:5:z'),
    };
    expect(after).toEqual({ x: 0, x2: 2, y: 0, z: 1 });
    expect(await engine.moveConversationSourceWindows(SRC, PAGE, [])).toBeUndefined();
    return { before, after };
  });

  parityTest('clearConversationPageFacts: a window clear takes the keyed rows, keep takes the others, and the whole-page clear expires what is held', {
    methods: ['putPage', 'insertFacts', 'stampConversationSourceWindows', 'clearConversationPageFacts', 'listFactsSince'],
  }, async (engine) => {
    await engine.putPage(PAGE, note('Chat'));
    await engine.putPage('conversations/c2', note('Other chat'));
    const a = await derived(engine, PAGE, 'in window a');
    const b = await derived(engine, PAGE, 'in window b');
    const c = await derived(engine, PAGE, 'in window c');
    await derived(engine, PAGE, 'unanchored');
    await derived(engine, PAGE, 'EXTRACTION_COMPLETE', { source: TERMINAL });
    await derived(engine, 'conversations/c2', 'untouched on another page');
    await engine.stampConversationSourceWindows([{ id: a, w: win(1, 1, 'a') }, { id: b, w: win(1, 2, 'b') }, { id: c, w: win(1, 3, 'c') }]);
    // Replace window a only: its row goes, the audit row, the unanchored row and the other windows stay.
    const windowA = await engine.clearConversationPageFacts(SRC, PAGE, { keys: ['1:1:a'], keep: false, unanchored: false });
    const afterA = await state(engine);
    // Keep window b: window c and the unanchored row go (the audit row is never a window clear's).
    const keepB = await engine.clearConversationPageFacts(SRC, PAGE, { keys: ['1:2:b'], keep: true, unanchored: true });
    const afterKeep = await state(engine);
    expect({ windowA, keepB }).toEqual({ windowA: 1, keepB: 2 });
    expect(afterA.map(r => r.fact)).toEqual(['EXTRACTION_COMPLETE', 'in window b', 'in window c', 'unanchored', 'untouched on another page']);
    expect(afterKeep.map(r => r.fact)).toEqual(['EXTRACTION_COMPLETE', 'in window b', 'untouched on another page']);
    return { windowA, keepB, afterA, afterKeep };
  });

  parityTest('clearConversationPageFacts: the whole-page clear deletes the unheld rows and expires the rows a loop or a relink holds', {
    methods: ['putPage', 'insertFacts', 'upsertOpenLoop', 'clearConversationPageFacts', 'listFactsSince', 'listHeldFactSlots', 'countActiveConversationFacts'],
  }, async (engine) => {
    const slug = PAGE;
    await engine.putPage(slug, note('Whole page'));
    const plain = await derived(engine, slug, 'plain');
    const looped = await derived(engine, slug, 'held by a loop', { entity_slug: 'people/a', dimension: 'role', value: 'cto', valid_from: new Date('2024-01-01T00:00:00Z') });
    const successor = await derived(engine, slug, 'the successor');
    const relinked = await derived(engine, slug, 'relinked row', { entity_slug: 'people/b', context: 'seen; entity relinked from alice' });
    await derived(engine, slug, 'retired by labels', { context: 'retired: conversation-labels' });
    await derived(engine, slug, 'EXTRACTION_COMPLETE', { source: TERMINAL });
    const at = '2026-03-01T10:00:00.000Z';
    await engine.upsertOpenLoop({ sourceId: SRC, dedupKey: 'loop', loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com',
      summary: 'loop', evidence: [], detector: 'manual', factId: looped, lastActivityAt: at, openedAt: at });
    expect((await engine.listHeldFactSlots(SRC, slug)).length).toBe(1);
    expect(await engine.countActiveConversationFacts(SRC, slug)).toBe(5);
    expect([plain, successor, relinked].every(id => id > 0)).toBe(true);
    const total = await engine.clearConversationPageFacts(SRC, slug);
    const out = { total, state: await state(engine), slots: await engine.listHeldFactSlots(SRC, slug), active: await engine.countActiveConversationFacts(SRC, slug) };
    // Deleted (3): plain, the successor and the audit row. Expired and kept (1 + 1): the relinked row, then the loop's row. Untouched: the labels row.
    expect(out.total).toBe(5);
    expect(out.state).toEqual([
      { fact: 'held by a loop', expired: true },
      { fact: 'relinked row', expired: true },
      { fact: 'retired by labels', expired: false },
    ]);
    expect(out.slots).toEqual([]);
    expect(out.active).toBe(1);
    return out;
  });

  parityTest('deleteConversationOutcomeRows deletes the page\'s audit rows and names them, leaving every other row', {
    methods: ['putPage', 'insertFacts', 'deleteConversationOutcomeRows', 'listFactsSince'],
  }, async (engine) => {
    await engine.putPage(PAGE, note('Chat'));
    const t = await derived(engine, PAGE, 'EXTRACTION_COMPLETE', { source: TERMINAL });
    const n = await derived(engine, PAGE, 'EXTRACTION_NOT_APPLICABLE', { source: NON_EXTRACTABLE });
    const legacy = await derived(engine, PAGE, 'EXTRACTION_COMPLETE', { source: LEGACY_TERMINAL });
    await derived(engine, PAGE, 'a real fact');
    const elsewhere = await derived(engine, 'conversations/c2', 'EXTRACTION_COMPLETE', { source: TERMINAL });
    const deleted = await engine.deleteConversationOutcomeRows(SRC, PAGE);
    const names = labels({ t, n, legacy, elsewhere });
    const out = { deleted: deleted.map(r => nameOf(names, r.id)).sort(), left: (await state(engine)).map(r => r.fact), again: await engine.deleteConversationOutcomeRows(SRC, PAGE) };
    expect(out).toEqual({ deleted: ['legacy', 'n', 't'], left: ['EXTRACTION_COMPLETE', 'a real fact'], again: [] });
    return out;
  });

  parityTest('readConversationSlotValueHash returns the latest live conversation value at or before the instant, null before any', {
    methods: ['insertFacts', 'expireFact', 'readConversationSlotValueHash'],
  }, async (engine) => {
    const slot = (value: string, from: string, extra: Record<string, unknown> = {}) =>
      derived(engine, PAGE, `role ${value}`, { entity_slug: 'people/a', dimension: 'role', value, valid_from: new Date(from), ...extra });
    await slot('cto', '2024-01-01T00:00:00Z');
    const coo = await slot('coo', '2024-05-01T00:00:00Z');
    await slot('ceo', '2025-01-01T00:00:00Z');
    expect(await engine.expireFact(coo)).toBe(true);
    const at = async (when: string, entity = 'people/a', dimension = 'role') =>
      (await engine.readConversationSlotValueHash(SRC, entity, dimension, when))?.value_hash ?? null;
    const early = await at('2023-06-01T00:00:00Z');
    const mid = await at('2024-06-01T00:00:00Z');
    const midLater = await at('2024-12-31T00:00:00Z');
    const late = await at('2025-06-01T00:00:00Z');
    const asDate = (await engine.readConversationSlotValueHash(SRC, 'people/a', 'role', new Date('2024-06-01T00:00:00Z')))?.value_hash ?? null;
    const out = { early, midHashed: !!mid, midStable: mid === midLater, lateDiffers: !!late && late !== mid, asDate: asDate === mid,
      otherEntity: await at('2024-06-01T00:00:00Z', 'people/b'), otherDimension: await at('2024-06-01T00:00:00Z', 'people/a', 'location') };
    expect(out).toEqual({ early: null, midHashed: true, midStable: true, lateDiffers: true, asDate: true, otherEntity: null, otherDimension: null });
    return out;
  });

  parityTest('listPurgeTombstoneMatches reports the positions of the claims a tombstone covers, exempting outcome markers', {
    methods: ['putPage', 'insertFacts', 'loadPurgeTarget', 'insertFactPurge', 'listPurgeTombstoneMatches'],
  }, async (engine) => {
    await engine.putPage('people/ana-example', note('Ana', 'Ana.', {}, 'person'));
    const hashOf = async (claim: string) => {
      const id = await fenced(engine, 'people/ana-example', claim, { entity_slug: 'people/ana-example' });
      return (await engine.loadPurgeTarget(id, SRC))!.fact_hash;
    };
    const purge = (visibility: string, subject: string, factHash: string) =>
      engine.insertFactPurge({ sourceId: SRC, visibility, subject, factHash, requestId: REQUEST, actor: 'owner:local', reason: 'parity' });
    expect(await purge('world', '*', await hashOf('likes tea'))).toBe(true);
    expect(await purge('world', 'people/ana-example', await hashOf('likes jam'))).toBe(true);
    expect(await purge('private', 'people/zed-example', await hashOf('likes figs'))).toBe(true);
    expect(await purge('world', '*', await hashOf('EXTRACTION_COMPLETE'))).toBe(true);
    const matches = async (claims: Array<[string, string, string | null, string | null]>) =>
      (await engine.listPurgeTombstoneMatches(SRC, {
        facts: claims.map(c => c[0]), visibilities: claims.map(c => c[1]), entitySlugs: claims.map(c => c[2]), sources: claims.map(c => c[3]),
      })).map(r => Number(r.ord)).sort((x, y) => x - y);
    const out = {
      anySubject: await matches([['likes tea', 'world', 'people/other', 'x'], ['likes tea', 'private', 'people/other', 'x'], ['likes tea', 'world', null, null]]),
      ownSubject: await matches([['likes jam', 'world', 'people/ana-example', 'x'], ['likes jam', 'world', 'people/other', 'x'], ['likes jam', 'world', null, 'x']]),
      unbackedKey: await matches([['likes figs', 'private', 'ana', 'x'], ['likes figs', 'private', 'people/ana-example', 'x'], ['likes figs', 'private', 'people/zed-example', 'x']]),
      marker: await matches([['EXTRACTION_COMPLETE', 'world', null, TERMINAL], ['EXTRACTION_COMPLETE', 'world', null, 'fence'], ['EXTRACTION_COMPLETE', 'world', null, LEGACY_TERMINAL]]),
      unmatched: await matches([['likes nothing', 'world', 'people/ana-example', 'x']]),
      empty: await matches([]),
    };
    expect(out).toEqual({ anySubject: [1, 3], ownSubject: [1], unbackedKey: [1, 3], marker: [2], unmatched: [], empty: [] });
    return out;
  });

  parityTest('listMergedEntityAliases maps an alias that no longer names a live page to its live canonical page', {
    methods: ['putPage', 'updateSlug', 'listMergedEntityAliases'],
  }, async (engine) => {
    const person = (slug: string) => engine.putPage(slug, note(slug, `${slug} body`, {}, 'person'));
    await person('people/old-name');
    expect(await engine.updateSlug('people/old-name', 'people/new-name')).toBe(1);
    await person('people/back');
    expect(await engine.updateSlug('people/back', 'people/back-new')).toBe(1);
    await person('people/back');
    await person('people/gone');
    expect(await engine.updateSlug('people/gone', 'people/gone-new')).toBe(1);
    await engine.softDeletePage('people/gone-new');
    const merged = (slugs: string[]) => engine.listMergedEntityAliases(SRC, slugs).then(r => sorted(r, x => x.alias_slug));
    const out = {
      one: await merged(['people/old-name', 'people/old-name', 'people/other']),
      shadowed: await merged(['people/back']),
      canonicalGone: await merged(['people/gone']),
      canonicalIsNotAnAlias: await merged(['people/new-name']),
      none: await merged([]),
    };
    expect(out).toEqual({
      one: [{ alias_slug: 'people/old-name', canonical_slug: 'people/new-name' }],
      shadowed: [], canonicalGone: [], canonicalIsNotAnAlias: [], none: [],
    });
    return out;
  });

  parityTest('countConversationPagesToExtract counts live pages of the types with no active v2 outcome row, or all of them when forced', {
    methods: ['putPage', 'softDeletePage', 'insertFacts', 'expireFact', 'countConversationPagesToExtract'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    for (const slug of ['conversations/p1', 'conversations/p2', 'conversations/p3', 'conversations/p4', 'conversations/p5', 'conversations/p6']) {
      await engine.putPage(slug, note(slug));
    }
    await engine.putPage('meetings/m1', note('Meeting', 'body', {}, 'meeting'));
    await engine.putPage('people/x', note('Person', 'body', {}, 'person'));
    await engine.putPage('conversations/p7', note('Elsewhere'), { sourceId: 'other' });
    await engine.softDeletePage('conversations/p6');
    await derived(engine, 'conversations/p2', 'EXTRACTION_COMPLETE', { source: TERMINAL });
    await derived(engine, 'conversations/p3', 'EXTRACTION_NOT_APPLICABLE', { source: NON_EXTRACTABLE });
    const expired = await derived(engine, 'conversations/p4', 'EXTRACTION_COMPLETE', { source: TERMINAL });
    expect(await engine.expireFact(expired)).toBe(true);
    await derived(engine, 'conversations/p5', 'EXTRACTION_COMPLETE', { source: LEGACY_TERMINAL });
    await derived(engine, 'conversations/p1', 'a fact, not an outcome');
    await derived(engine, 'conversations/p7', 'EXTRACTION_COMPLETE', { source: TERMINAL }, 'other');
    const out = {
      pending: await engine.countConversationPagesToExtract(SRC, ['note'], false),
      forced: await engine.countConversationPagesToExtract(SRC, ['note'], true),
      pendingWithMeeting: await engine.countConversationPagesToExtract(SRC, ['note', 'meeting'], false),
      otherSource: await engine.countConversationPagesToExtract('other', ['note'], false),
      noTypes: await engine.countConversationPagesToExtract(SRC, [], true),
    };
    expect(out).toEqual({ pending: 3, forced: 5, pendingWithMeeting: 4, otherSource: 0, noTypes: 0 });
    return out;
  });

  parityTest('findSameClaimFenceRow finds the oldest active fence row of the same claim and source, any visibility', {
    methods: ['putPage', 'insertFacts', 'expireFact', 'findSameClaimFenceRow'],
  }, async (engine) => {
    await engine.putPage(PAGE, note('Chat'));
    const gone = await fenced(engine, PAGE, 'Prefers email', { source: 'fence', visibility: 'world' });
    const first = await fenced(engine, PAGE, 'Prefers email', { source: 'fence', visibility: 'private' });
    await fenced(engine, PAGE, 'Prefers email', { source: 'fence', visibility: 'world' });
    await derived(engine, PAGE, 'Prefers email', { source: 'fence' });
    expect(await engine.expireFact(gone)).toBe(true);
    const names = labels({ gone, first });
    const view = (row: { id: number | string; visibility: string } | null) => (row ? { id: nameOf(names, row.id), visibility: row.visibility } : null);
    const out = {
      oldestActive: view(await engine.findSameClaimFenceRow(SRC, PAGE, 'Prefers email', 'fence')),
      otherSource: view(await engine.findSameClaimFenceRow(SRC, PAGE, 'Prefers email', 'mcp:remember')),
      nullVersusSource: view(await engine.findSameClaimFenceRow(SRC, PAGE, 'Prefers email', null)),
      otherClaim: view(await engine.findSameClaimFenceRow(SRC, PAGE, 'Prefers phone', 'fence')),
      otherPage: view(await engine.findSameClaimFenceRow(SRC, 'conversations/none', 'Prefers email', 'fence')),
    };
    expect(out).toEqual({ oldestActive: { id: 'first', visibility: 'private' }, otherSource: null, nullVersusSource: null, otherClaim: null, otherPage: null });
    return out;
  });

  parityTest('findOntologyTwin finds the page\'s observation at the same slot key as a fact, null for a fact with no twin', {
    methods: ['putPage', 'insertFacts', 'mergeOntologyFact', 'expireFact', 'findOntologyTwin'],
  }, async (engine) => {
    await engine.putPage('people/a', note('A', 'A body', {}, 'person'));
    const validFrom = '2024-01-01T00:00:00.000Z';
    const twin = await engine.mergeOntologyFact({ entitySlug: 'people/a', dimension: 'role', value: 'cto', source: 'people/a', validFrom } as never);
    const mine = await derived(engine, PAGE, 'role cto', { entity_slug: 'people/a', dimension: 'role', value: 'cto', valid_from: new Date(validFrom) });
    const other = await derived(engine, PAGE, 'role ceo', { entity_slug: 'people/a', dimension: 'role', value: 'ceo', valid_from: new Date(validFrom) });
    const names = labels({ twin: Number(twin.factId), mine, other });
    const view = (row: { id: number | string } | null) => (row ? nameOf(names, row.id) : null);
    const found = view(await engine.findOntologyTwin(SRC, 'people/a', mine));
    const noTwin = view(await engine.findOntologyTwin(SRC, 'people/a', other));
    const otherPage = view(await engine.findOntologyTwin(SRC, 'people/other', mine));
    expect(await engine.expireFact(Number(twin.factId))).toBe(true);
    const expired = view(await engine.findOntologyTwin(SRC, 'people/a', mine));
    const unknown = view(await engine.findOntologyTwin(SRC, 'people/a', 999_999));
    const out = { found, noTwin, otherPage, expired, unknown };
    expect(out).toEqual({ found: 'twin', noTwin: null, otherPage: null, expired: 'twin', unknown: null });
    return out;
  });

  parityTest('readRelinkSource reads a registered source\'s checkout and kind, and its archived flag, null for an unknown source', {
    methods: ['readRelinkSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', { kind: 'git' }, '/srv/repo');
    const read = async (id: string) => {
      const row = await engine.readRelinkSource(id);
      return row ? { incarnation: typeof row.incarnation, archived: row.archived, local_path: row.local_path, kind: row.kind } : null;
    };
    const plain = await read(SRC);
    const repo = await read('repo');
    await archiveSource(engine, backend, 'repo');
    const archived = await read('repo');
    const unknown = await read('nowhere');
    expect(repo).toEqual({ incarnation: 'string', archived: false, local_path: '/srv/repo', kind: 'git' });
    expect(archived).toEqual({ ...repo!, archived: true });
    expect(plain).toMatchObject({ archived: false, kind: null });
    expect(unknown).toBeNull();
    return { plain, repo, archived, unknown };
  });

  parityTest('factRelinkAttemptsTableExists is true on a migrated brain', { methods: ['factRelinkAttemptsTableExists'] }, async (engine) => {
    const exists = await engine.factRelinkAttemptsTableExists();
    expect(exists).toBe(true);
    return exists;
  });

  parityTest('readReextractOutcomeRow returns the newest active terminal outcome row with its live page\'s content hash', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'insertFacts', 'expireFact', 'readReextractOutcomeRow'],
  }, async (engine) => {
    for (const slug of ['conversations/r1', 'conversations/r2', 'conversations/r3', 'conversations/r4', 'conversations/r5']) await engine.putPage(slug, note(slug, `${slug} body`));
    await derived(engine, 'conversations/r1', 'EXTRACTION_COMPLETE', { source: TERMINAL });
    const newest = await derived(engine, 'conversations/r1', 'EXTRACTION_COMPLETE', { source: TERMINAL });
    const expired = await derived(engine, 'conversations/r1', 'EXTRACTION_COMPLETE', { source: TERMINAL });
    expect(await engine.expireFact(expired)).toBe(true);
    await derived(engine, 'conversations/r2', 'EXTRACTION_NOT_APPLICABLE', { source: NON_EXTRACTABLE });
    await derived(engine, 'conversations/r3', 'EXTRACTION_COMPLETE', { source: TERMINAL });
    await engine.softDeletePage('conversations/r3');
    await derived(engine, 'conversations/r5', 'EXTRACTION_COMPLETE', { source: LEGACY_TERMINAL });
    const r1 = await engine.readReextractOutcomeRow(SRC, 'conversations/r1');
    const hash = (await engine.getPage('conversations/r1'))?.content_hash;
    const out = {
      newest: r1 ? { isNewest: Number(r1.id) === newest, hashIsPage: r1.hash === hash && r1.hash.length > 0 } : null,
      nonExtractable: await engine.readReextractOutcomeRow(SRC, 'conversations/r2'),
      deletedPage: await engine.readReextractOutcomeRow(SRC, 'conversations/r3'),
      noOutcome: await engine.readReextractOutcomeRow(SRC, 'conversations/r4'),
      legacy: await engine.readReextractOutcomeRow(SRC, 'conversations/r5'),
    };
    expect(out).toEqual({ newest: { isNewest: true, hashIsPage: true }, nonExtractable: null, deletedPage: null, noOutcome: null, legacy: null });
    return out;
  });

  parityTest('listUnbackedConversationRows lists the live derived rows on an unbacked name key of the pages, in (page, id) order', {
    methods: ['insertFacts', 'expireFact', 'listUnbackedConversationRows'],
  }, async (engine) => {
    const kept = await derived(engine, 'conversations/u2', 'second page', { entity_slug: 'bob', context: 'ctx', attributed_to: 'assistant' });
    await derived(engine, 'conversations/u1', 'first page, newer', { entity_slug: 'alice' });
    const first = await derived(engine, 'conversations/u1', 'first page, older', { entity_slug: 'alice' });
    const expired = await derived(engine, 'conversations/u1', 'expired', { entity_slug: 'dave' });
    await derived(engine, 'conversations/u1', 'backed key', { entity_slug: 'people/alice' });
    await derived(engine, 'conversations/u1', 'unlinked', { entity_slug: null });
    await derived(engine, 'conversations/u1', 'EXTRACTION_COMPLETE', { source: TERMINAL, entity_slug: 'erin' });
    await derived(engine, 'conversations/u1', 'other extractor', { source: 'mcp:remember', entity_slug: 'frank' });
    await derived(engine, 'conversations/u1', 'lapsed', { entity_slug: 'gina', valid_until: new Date('2020-01-01T00:00:00Z') });
    await derived(engine, 'conversations/u3', 'not asked for', { entity_slug: 'hank' });
    expect(await engine.expireFact(expired)).toBe(true);
    const view = (found: Awaited<ReturnType<BrainEngine['listUnbackedConversationRows']>>) =>
      found.map(({ id: _id, ...r }) => r);
    const rowsOut = await engine.listUnbackedConversationRows(SRC, ['conversations/u2', 'conversations/u1']);
    const out = { rows: view(rowsOut), ids: rowsOut.map(r => Number(r.id)), none: await engine.listUnbackedConversationRows(SRC, []) };
    expect(out.rows.map(r => r.fact)).toEqual(['first page, newer', 'first page, older', 'second page']);
    expect(out.ids[2]).toBe(kept);
    expect(out.ids[0]).toBeLessThan(out.ids[1]!);
    expect(first).toBeGreaterThan(0);
    expect(out.rows[2]).toMatchObject({ slug: 'conversations/u2', entity_slug: 'bob', context: 'ctx', attributed_to: 'assistant' });
    expect(out.none).toEqual([]);
    return { rows: out.rows, none: out.none };
  });

  parityTest('listUnlinkedConversationRows lists the live derived rows with no entity of the pages, in (page, id) order', {
    methods: ['insertFacts', 'expireFact', 'listUnlinkedConversationRows'],
  }, async (engine) => {
    await derived(engine, 'conversations/l2', 'second page', { context: 'ctx', attributed_to: 'user' });
    await derived(engine, 'conversations/l1', 'first page, older');
    await derived(engine, 'conversations/l1', 'first page, newer', { attributed_to: 'assistant' });
    const expired = await derived(engine, 'conversations/l1', 'expired');
    await derived(engine, 'conversations/l1', 'lapsed', { valid_until: new Date('2020-01-01T00:00:00Z') });
    await derived(engine, 'conversations/l1', 'linked', { entity_slug: 'people/alice' });
    await derived(engine, 'conversations/l1', 'EXTRACTION_COMPLETE', { source: TERMINAL });
    await derived(engine, 'conversations/l1', 'other extractor', { source: 'mcp:remember' });
    await derived(engine, 'conversations/l3', 'not asked for');
    expect(await engine.expireFact(expired)).toBe(true);
    const found = await engine.listUnlinkedConversationRows(SRC, ['conversations/l2', 'conversations/l1']);
    const out = { rows: found.map(({ id: _id, ...r }) => r), none: await engine.listUnlinkedConversationRows(SRC, []) };
    expect(out.rows.map(r => r.fact)).toEqual(['first page, older', 'first page, newer', 'second page']);
    expect(out.rows[1]).toMatchObject({ slug: 'conversations/l1', attributed_to: 'assistant' });
    expect(out.rows[2]).toMatchObject({ slug: 'conversations/l2', context: 'ctx', attributed_to: 'user' });
    expect(out.none).toEqual([]);
    return out;
  });

  // restrictFolder (harness.ts) seeds the folder rule on every arm; the Rust listEntityHintPages reads the store's folder
  // rules and pending prefixes (facts/repair.rs folder_restricted), so the case is equal on all three arms.
  parityTest('listEntityHintPages reads the live pages of the slugs with their retired and folder-restricted flags', {
    methods: ['putPage', 'softDeletePage', 'listEntityHintPages'],
  }, async (engine, backend) => {
    const person = (slug: string, frontmatter: Record<string, unknown> = {}) => engine.putPage(slug, note(slug, `${slug} body`, frontmatter, 'person'));
    await person('people/live', { role: 'cto' });
    await person('people/merged', { merged_into: 'people/live' });
    await person('people/redirect', { status: 'redirect' });
    await person('people/not-canonical', { canonical: 'false' });
    await person('people/gone');
    await person('private/closed');
    await engine.softDeletePage('people/gone');
    await restrictFolder(engine, backend, SRC, 'private/', 'pending');
    const found = await engine.listEntityHintPages(SRC, ['private/closed', 'people/gone', 'people/live', 'people/merged', 'people/redirect', 'people/not-canonical', 'people/missing', 'people/live']);
    const out = sorted(found.map(r => ({ slug: r.slug, type: r.type, frontmatter: r.frontmatter, retired: r.retired, folder_restricted: r.folder_restricted })), r => r.slug);
    expect(out.map(r => `${r.slug}:${r.retired}:${r.folder_restricted}`)).toEqual([
      'people/live:false:false', 'people/merged:true:false', 'people/not-canonical:true:false', 'people/redirect:true:false', 'private/closed:false:true',
    ]);
    expect(out[0]).toMatchObject({ type: 'person', frontmatter: { role: 'cto' } });
    expect(await engine.listEntityHintPages(SRC, [])).toEqual([]);
    return out;
  });

  parityTest('lockPageById takes the row lock of a page and returns nothing', { methods: ['putPage', 'getPage', 'lockPageById'] }, async (engine) => {
    await engine.putPage(PAGE, note('Chat'));
    const page = await engine.getPage(PAGE);
    expect(page?.id).toBeGreaterThan(0);
    const locked = await engine.lockPageById(page!.id);
    expect(locked).toBeUndefined();
    expect(await engine.lockPageById(999_999)).toBeUndefined();
    return locked;
  });

  parityTest('listClearedRelinkedFacts lists a page\'s expired relinked rows whose entity page is live, newest first', {
    methods: ['putPage', 'softDeletePage', 'insertFacts', 'expireFact', 'listClearedRelinkedFacts'],
  }, async (engine) => {
    await engine.putPage('people/alive', note('Alive', 'body', {}, 'person'));
    await engine.putPage('people/dead', note('Dead', 'body', {}, 'person'));
    await engine.softDeletePage('people/dead');
    const relinked = (text: string, entity: string | null, extra: Record<string, unknown> = {}, slug = PAGE) =>
      derived(engine, slug, text, { entity_slug: entity, context: `said; entity relinked from ${text}`, ...extra });
    const older = await relinked('older', 'people/alive');
    const newer = await relinked('newer', 'people/alive');
    const active = await relinked('active', 'people/alive');
    const dead = await relinked('dead', 'people/dead');
    const missing = await relinked('missing', 'people/missing');
    const plain = await derived(engine, PAGE, 'plain', { entity_slug: 'people/alive', context: 'no marker' });
    const otherSource = await relinked('other source', 'people/alive', { source: 'mcp:remember' });
    const otherPage = await relinked('other page', 'people/alive', {}, 'conversations/c2');
    for (const id of [older, newer, dead, missing, plain, otherSource, otherPage]) expect(await engine.expireFact(id)).toBe(true);
    expect(active).toBeGreaterThan(0);
    const found = await engine.listClearedRelinkedFacts(SRC, PAGE);
    expect(found).toEqual([
      { fact: 'newer', entity_slug: 'people/alive', context: 'said; entity relinked from newer' },
      { fact: 'older', entity_slug: 'people/alive', context: 'said; entity relinked from older' },
    ]);
    expect(await engine.listClearedRelinkedFacts(SRC, 'conversations/none')).toEqual([]);
    return found;
  });

  parityTest('countEmbeddedFactsAmong counts the named facts of the source that carry an embedding', {
    methods: ['insertFacts', 'countEmbeddedFactsAmong'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const embedded = (text: string, sourceId = SRC) => derived(engine, PAGE, text, { embedding: basisEmbedding(0), embedding_model: 'm1' }, sourceId);
    const a = await embedded('a');
    const b = await embedded('b');
    const bare = await derived(engine, PAGE, 'bare');
    const away = await embedded('away', 'other');
    const out = {
      both: await engine.countEmbeddedFactsAmong(SRC, [a, b, bare]),
      oneEmbedded: await engine.countEmbeddedFactsAmong(SRC, [bare, a]),
      noneEmbedded: await engine.countEmbeddedFactsAmong(SRC, [bare]),
      otherSource: await engine.countEmbeddedFactsAmong(SRC, [away]),
      unknown: await engine.countEmbeddedFactsAmong(SRC, [999_999]),
      empty: await engine.countEmbeddedFactsAmong(SRC, []),
    };
    expect(out).toEqual({ both: 2, oneEmbedded: 1, noneEmbedded: 0, otherSource: 0, unknown: 0, empty: 0 });
    return out;
  });
});
