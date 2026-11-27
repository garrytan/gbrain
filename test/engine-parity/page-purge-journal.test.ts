/**
 * BrainEngine parity — the journal sweep and the intent redaction a page purge runs
 * (src/core/persistence/intent-redaction.ts findRequestsForSlugs, sweepRequestsCarrying, sweepRequestsForGroups,
 * recheckRequestsCarrying and redactRequestIntents).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the journal sweep finds the requests of one source whose intent, outcome, error detail or error message
 *    carry a claim (lowercased, raw or as it sits inside a JSON string), reports the unfinished ones apart, covers the
 *    sequence range it says it covered and stops at its match cap; the recheck finds the carriers admitted after that range
 *    and the pending ones that settled since; the redaction refuses a pending carrier (unless told to skip it), and for a
 *    terminal one removes the intent and error text, marks it compacted, scrubs the outcome, shrinks its terminal
 *    reservation to what the retained receipt needs and releases the difference from its counters: each answers the same, and
 *    leaves the same rows, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1) over one seeded journal with rows around it (another page, another source, a running request).
 *  - Regression: an engine that matches the text differently (case, JSON escaping, the error columns), reads a chunk past the
 *    wrong sequence, or releases the wrong bytes leaves a purged claim in the journal, or removes another request's receipt,
 *    or leaves the counters out of step with the receipts; the Rust engine has no SQL, so each statement has to exist as a
 *    typed member it can serve.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18), so
 *    only the PGLite and Postgres page purge suites (test/page-purge*.test.ts) exercised them.
 *  - Seam: the exported functions of persistence/intent-redaction.ts, called with the arm's engine (a transaction handle
 *    where they write). Every row is seeded through the typed journal members (insertWriteRequest, stampWriteClaim,
 *    insertPublicationEffects, completeWriteRow) and read back through readWriteRequestById and readCounterRows. Generated
 *    values (journal ids, sequences) are compared by label or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { findRequestsForSlugs, recheckRequestsCarrying, redactRequestIntents, sweepRequestsCarrying, sweepRequestsForGroups, type IntentRedactionTarget } from '../../src/core/persistence/intent-redaction.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const SLUG = 'notes/doomed';
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const CLAIM = 'Harbor Ledger Fact';
const QUOTED = 'He said "hi" \\ there';
const CAFE = 'café ledger';
const rid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** What each journal row is called, by id, per engine: ids and sequences differ between arms, labels do not. */
const labels = new WeakMap<BrainEngine, Map<string, string>>();
const name = (engine: BrainEngine, id: string, label?: string): string => {
  const names = labels.get(engine) ?? new Map<string, string>();
  labels.set(engine, names);
  if (label !== undefined) names.set(id, label);
  return names.get(id) ?? '<unknown>';
};

interface RowOpts { intent?: unknown; outcome?: unknown; state?: 'committed' | 'failed' | 'cancelled' | 'queued' | 'running'; errorMessage?: string; errorDetail?: unknown; sourceId?: string; effects?: boolean }

/** One journal row: admitted queued, then claimed (running) or completed in `state` (default committed when it has an outcome, else left queued). */
async function journal(engine: BrainEngine, label: string, n: number, operation: string, slug: string, opts: RowOpts = {}): Promise<string> {
  const sourceId = opts.sourceId ?? SRC;
  const source = await engine.readSourceMembership(sourceId);
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId: rid(n), operation, sourceId, sourceIncarnation: source!.incarnation, pageId: null, slug,
    worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: opts.intent ?? { kind: operation, slug }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  name(engine, row.id, label);
  const state = opts.state ?? (opts.outcome !== undefined ? 'committed' : 'queued');
  if (state !== 'queued') await engine.stampWriteClaim(row.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
  if (opts.effects) {
    await engine.transactionDirect(async tx => {
      await tx.declarePersistence();
      return tx.insertPublicationEffects({ requestId: row.id, revision: null, sourceId, sourceIncarnation: source!.incarnation, worktreeId: null,
        effects: [{ kind: 'git', data: { paths: [`${slug}.md`], note: 'a git effect with some bytes' } }, { kind: 'embedding', data: { slug } }] as never });
    });
  }
  if (state !== 'queued' && state !== 'running') {
    await engine.completeWriteRow({
      id: row.id, state, outcome: opts.outcome ?? null, errorCode: state === 'failed' ? 'parity_failure' : null, errorMessage: opts.errorMessage ?? null, consumerVersion: 'parity',
      consumerHostId: null, errorDetail: opts.errorDetail ?? null, resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500, terminalReservation: 4096, probePurges: false,
    });
  }
  return row.id;
}

/** The seeded journal: carriers of each kind, pending rows, a row of another page, another source and the purge's own request. */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<Record<string, string>> {
  await createSource(engine, backend, OTHER);
  const ids: Record<string, string> = {};
  const add = async (label: string, n: number, operation: string, slug: string, opts: RowOpts = {}) => { ids[label] = await journal(engine, label, n, operation, slug, opts); };
  await add('intentCarrier', 1, 'put_page', SLUG, { intent: { kind: 'put_page', slug: SLUG, content: `The ${CLAIM} stays here` }, outcome: { slug: SLUG, status: 'ok' } });
  await add('outcomeCarrier', 2, 'edit_page', SLUG, { outcome: { slug: SLUG, diff: `added ${CLAIM}`, keep: 'other text' }, effects: true });
  await add('messageCarrier', 3, 'put_page', 'notes/keeper', { state: 'failed', errorMessage: `could not write: ${CLAIM.toLowerCase()} missing` });
  await add('detailCarrier', 4, 'put_page', SLUG, { state: 'failed', errorMessage: 'plain failure', errorDetail: { why: QUOTED, other: 'fine' } });
  await add('queuedCarrier', 5, 'add_timeline_entry', SLUG, { intent: { kind: 'add_timeline_entry', slug: SLUG, entry: `pending ${CLAIM}` } });
  await add('runningCarrier', 6, 'put_page', SLUG, { state: 'running', intent: { kind: 'put_page', slug: SLUG, content: `running ${CAFE}` } });
  await add('otherSource', 7, 'put_page', SLUG, { sourceId: OTHER, intent: { kind: 'put_page', slug: SLUG, content: CLAIM }, outcome: { ok: true } });
  await add('shouting', 8, 'put_page', SLUG, { intent: { kind: 'put_page', slug: SLUG, content: CLAIM.toUpperCase() }, outcome: { ok: true } });
  await add('unrelated', 9, 'put_page', SLUG, { intent: { kind: 'put_page', slug: SLUG, content: 'nothing to see' }, outcome: { ok: true } });
  await add('cafeCarrier', 10, 'put_page', 'notes/keeper', { intent: { kind: 'put_page', slug: 'notes/keeper', content: `a ${CAFE} entry` }, outcome: { ok: true }, effects: true });
  await add('own', 11, 'delete_page', SLUG, { state: 'running', intent: { kind: 'delete_page', slug: SLUG, purge: true, why: CLAIM } });
  return ids;
}

/** Each journal row of the arm as a labelled view: the columns a redaction changes. */
async function rowsOf(engine: BrainEngine, ids: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [label, id] of Object.entries(ids)) {
    const r = await engine.readWriteRequestById(id);
    out[label] = r && { state: r.state, compacted: r.compacted, intent: r.intent, outcome: r.outcome, error_message: r.error_message, error_detail: r.error_detail ?? null, terminal_reservation: Number(r.terminal_reservation) };
  }
  return out;
}
const counters = async (engine: BrainEngine) => (await engine.readCounterRows(KEYS)).map(c => ({ key: c.key, outstanding: Number(c.outstanding_count), terminal: Number(c.terminal_bytes) }));

const targetView = (engine: BrainEngine, rows: IntentRedactionTarget[]) => rows.map(r => ({ id: name(engine, r.id), principal: `${r.principal_kind}:${r.principal_id}` }));

describe('engine parity: the journal sweep and the intent redaction of a page purge', () => {
  parityTest('findRequestsForSlugs lists the slug\'s uncompacted requests that still hold an intent, in sequence order after a cursor, up to a limit, in its source only', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transaction', 'listRequestsForSlugs'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    // Fewer than ten rows, so every sequence is one digit: the order is the same read as numbers or as text.
    const ids: Record<string, string> = {};
    const add = async (label: string, n: number, operation: string, slug: string, opts: RowOpts = {}) => { ids[label] = await journal(engine, label, n, operation, slug, opts); };
    await add('first', 1, 'put_page', SLUG, { outcome: { ok: true } });
    await add('second', 2, 'edit_page', SLUG, { outcome: { ok: true }, effects: true });
    await add('keeper', 3, 'put_page', 'notes/keeper', { outcome: { ok: true } });
    await add('other', 4, 'put_page', SLUG, { sourceId: OTHER, outcome: { ok: true } });
    await add('queued', 5, 'add_timeline_entry', SLUG);
    await add('running', 6, 'put_page', SLUG, { state: 'running' });
    await add('failed', 7, 'put_page', SLUG, { state: 'failed', errorMessage: 'no' });
    const list = async (sourceId: string, slugs: string[], limit?: number, after?: string) => {
      const rows = await findRequestsForSlugs(engine, sourceId, slugs, limit, after);
      return rows.map(r => ({ id: name(engine, r.id), principal: `${r.principal_kind}:${r.principal_id}`, sequenceIsText: /^\d+$/.test(String(r.sequence)) }));
    };
    const all = await findRequestsForSlugs(engine, SRC, [SLUG]);
    const view = await list(SRC, [SLUG]);
    expect(view.map(r => r.id)).toEqual(['first', 'second', 'queued', 'running', 'failed']);
    const limited = await list(SRC, [SLUG], 2);
    const after = await list(SRC, [SLUG], 100, all[1]!.sequence);
    const afterLast = await list(SRC, [SLUG], 100, all[all.length - 1]!.sequence);
    const both = await list(SRC, [SLUG, 'notes/keeper']);
    const none = [await list(SRC, []), await list(SRC, ['notes/never']), await list('nobody', [SLUG]), await list(OTHER, [SLUG]), await list(SRC, [SLUG], 0)];
    // A compacted request drops out of the list.
    await engine.transaction(tx => redactRequestIntents(tx, [{ id: ids.first!, principal_kind: PRINCIPAL.kind, principal_id: PRINCIPAL.id }], undefined, { skipPending: true, needles: [CLAIM] }));
    const compacted = await list(SRC, [SLUG]);
    expect(compacted.map(r => r.id)).toEqual(['second', 'queued', 'running', 'failed']);
    return { view, limited, after, afterLast, both, none, compacted };
  });

  parityTest('sweepRequestsCarrying finds the requests whose intent, outcome, error detail or error message carry a claim, lowercased, raw or as a JSON string, and reports the unfinished ones apart', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'readWriteRequestById', 'readJournalCeiling', 'sweepJournalChunk'],
  }, async (engine, backend) => {
    const ids = await seed(engine, backend);
    const sequences = new Map<string, string>();
    for (const [label, id] of Object.entries(ids)) sequences.set(String((await engine.readWriteRequestById(id))!.sequence), label);
    const view = (s: Awaited<ReturnType<typeof sweepRequestsCarrying>>) => ({ targets: targetView(engine, s.targets), pending: s.pendingAtScan.map(id => name(engine, id)),
      ceiling: s.ceiling === null ? null : sequences.get(s.ceiling) ?? '<unknown>', scanned: s.scanned, complete: s.complete, watermark: s.watermark == null ? null : sequences.get(s.watermark) ?? s.watermark });
    const sweep = (sourceId: string, claims: string[], opts = {}) => sweepRequestsCarrying(engine, sourceId, claims, opts);
    const plain = view(await sweep(SRC, [CLAIM]));
    const quoted = view(await sweep(SRC, [QUOTED]));
    const accented = view(await sweep(SRC, [CAFE]));
    const several = view(await sweep(SRC, [CLAIM, QUOTED, CAFE]));
    const excluded = view(await sweep(SRC, [CLAIM], { exclude: ids.own }));
    const chunked = view(await sweep(SRC, [CLAIM, QUOTED], { chunkRows: 2, exclude: ids.own }));
    const capped = view(await sweep(SRC, [CLAIM], { matchCap: 1, exclude: ids.own }));
    const tail = view(await sweep(SRC, [CLAIM], { after: String((await engine.readWriteRequestById(ids.detailCarrier!))!.sequence), exclude: ids.own }));
    const pastEnd = view(await sweep(SRC, [CLAIM], { after: String((await engine.readWriteRequestById(ids.own!))!.sequence) }));
    const other = view(await sweep(OTHER, [CLAIM]));
    const empty = [view(await sweep(SRC, [])), view(await sweep(SRC, [''])), view(await sweep('nobody', [CLAIM])), view(await sweep(SRC, ['no such text anywhere']))];
    expect(plain.targets.map(t => t.id)).toEqual(['intentCarrier', 'outcomeCarrier', 'messageCarrier', 'shouting']);
    expect(plain.pending).toEqual(['queuedCarrier', 'runningCarrier', 'own']);
    expect(capped.complete).toBe(false);
    return { plain, quoted, accented, several, excluded, chunked, capped, tail, pastEnd, other, empty };
  });

  parityTest('sweepRequestsForGroups reads the journal once for several claim groups and attributes each hit to the groups whose claims it carries', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'readWriteRequestById', 'readJournalCeiling', 'sweepJournalChunk'],
  }, async (engine, backend) => {
    const ids = await seed(engine, backend);
    const sequences = new Map<string, string>();
    for (const [label, id] of Object.entries(ids)) sequences.set(String((await engine.readWriteRequestById(id))!.sequence), label);
    const groups = [{ key: 'ledger', claims: [CLAIM] }, { key: 'quoted', claims: [QUOTED] }, { key: 'both', claims: [CLAIM, CAFE] }, { key: 'shared', claims: [CLAIM.toLowerCase()] }, { key: 'none', claims: [] }];
    const run = async (opts = {}) => {
      const swept = await sweepRequestsForGroups(engine, SRC, groups, opts);
      return Object.fromEntries([...swept].map(([key, s]) => [key, { targets: targetView(engine, s.targets), pending: s.pendingAtScan.map(id => name(engine, id)),
        ceiling: s.ceiling === null ? null : sequences.get(s.ceiling) ?? '<unknown>', scanned: s.scanned, complete: s.complete, watermark: s.watermark == null ? null : sequences.get(s.watermark) ?? s.watermark }]));
    };
    const whole = await run({ exclude: ids.own });
    const chunked = await run({ chunkRows: 3, exclude: ids.own });
    const capped = await run({ matchCap: 2, chunkRows: 4, exclude: ids.own });
    const tail = await run({ after: String((await engine.readWriteRequestById(ids.messageCarrier!))!.sequence), exclude: ids.own });
    const empty = await sweepRequestsForGroups(engine, 'nobody', groups);
    expect(whole.ledger!.targets.map(t => t.id)).toEqual(whole.shared!.targets.map(t => t.id));
    expect(whole.none!.targets).toEqual([]);
    expect([...empty.values()].map(s => [s.targets.length, s.ceiling, s.scanned, s.complete])).toEqual(groups.map(() => [0, null, 0, true]));
    return { whole, chunked, capped, tail };
  });

  parityTest('recheckRequestsCarrying finds the carriers admitted after the swept range and the pending ones that settled since, inside the purge transaction', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transaction', 'sweepJournalChunk'],
  }, async (engine, backend) => {
    const ids = await seed(engine, backend);
    const swept = await sweepRequestsCarrying(engine, SRC, [CLAIM], { exclude: ids.own });
    // After the scan: a carrier admitted past the ceiling (terminal and pending), and a pending carrier that settles with a carrying outcome.
    await journal(engine, 'lateCarrier', 20, 'put_page', SLUG, { intent: { kind: 'put_page', content: CLAIM }, outcome: { ok: true } });
    await journal(engine, 'latePending', 21, 'put_page', SLUG, { intent: { kind: 'put_page', content: CLAIM } });
    await journal(engine, 'lateClean', 22, 'put_page', SLUG, { intent: { kind: 'put_page', content: 'clean' }, outcome: { ok: true } });
    await engine.stampWriteClaim(ids.queuedCarrier!, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    await engine.completeWriteRow({ id: ids.queuedCarrier!, state: 'committed', outcome: { settled: CLAIM }, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null,
      errorDetail: null, resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500, terminalReservation: 4096, probePurges: false });
    const view = (r: Awaited<ReturnType<typeof recheckRequestsCarrying>>) => ({ targets: targetView(engine, r.targets).map(t => t.id).sort(), tail: r.tail, pendingRechecked: r.pendingRechecked, complete: r.complete });
    const recheck = (claims: string[], sweep: Parameters<typeof recheckRequestsCarrying>[3] = swept, opts = {}) => engine.transaction(tx => recheckRequestsCarrying(tx, SRC, claims, sweep, { exclude: ids.own, ...opts }));
    const found = view(await recheck([CLAIM]));
    const smallTail = view(await recheck([CLAIM], swept, { tailRows: 2 }));
    const noNeedles = view(await recheck([]));
    const fromStart = view(await recheck([CLAIM], { ceiling: null, pendingAtScan: [] }));
    const noPending = view(await recheck([CLAIM], { ceiling: swept.ceiling, pendingAtScan: [] }));
    const hooked: string[] = [];
    await recheck([CLAIM], swept, { beforePending: () => { hooked.push('beforePending'); } });
    expect(found.targets).toEqual(['lateCarrier', 'queuedCarrier'].sort());
    return { found, smallTail, noNeedles, fromStart, noPending, hooked };
  });

  parityTest('redactRequestIntents refuses a pending carrier unless told to skip it, and redacts a terminal one: intent and error text removed, outcome scrubbed, reservation shrunk, counters released', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'transaction', 'readWriteRequestById', 'readCounterRows', 'lockWriteRequestsById', 'readEffectBytes', 'redactWriteRequestRow', 'releaseTerminalBytes'],
  }, async (engine, backend) => {
    const ids = await seed(engine, backend);
    const target = (label: string): IntentRedactionTarget => ({ id: ids[label]!, principal_kind: PRINCIPAL.kind, principal_id: PRINCIPAL.id });
    const before = { rows: await rowsOf(engine, ids), counters: await counters(engine) };
    // A pending request (queued, running) refuses the whole redaction, and nothing changes.
    const refused = await engine.transaction(tx => redactRequestIntents(tx, [target('intentCarrier'), target('queuedCarrier')], undefined, { needles: [CLAIM] })).then(() => null, (e: { code?: string; message?: string }) => {
      if (e.code === 'engine_capability_missing') throw e;
      return { code: e.code, message: String(e.message) };
    });
    expect(refused?.code).toBe('purge_blocked_pending_recovery');
    const unchanged = { rows: await rowsOf(engine, ids), counters: await counters(engine) };
    expect(unchanged).toEqual(before);
    // No targets, and only the purge's own request: nothing to do.
    const nothing = [await engine.transaction(tx => redactRequestIntents(tx, [])), await engine.transaction(tx => redactRequestIntents(tx, [target('own')], ids.own))];
    // skipPending leaves the pending ones; the terminal ones are redacted (the failed one loses its message; the outcome carrier keeps its other text).
    const first = await engine.transaction(tx => redactRequestIntents(tx, [target('intentCarrier'), target('outcomeCarrier'), target('messageCarrier'), target('detailCarrier'),
      target('queuedCarrier'), target('runningCarrier'), target('shouting')], ids.own, { skipPending: true, needles: [CLAIM, CLAIM.toLowerCase(), QUOTED] }));
    const afterFirst = { rows: await rowsOf(engine, ids), counters: await counters(engine) };
    // A second pass finds them compacted with nothing left to scrub; an exact-text match scrubs one outcome string only, even on a compacted request.
    const second = await engine.transaction(tx => redactRequestIntents(tx, [target('intentCarrier'), target('outcomeCarrier'), target('messageCarrier'), target('detailCarrier')], undefined, { skipPending: true, needles: [CLAIM, QUOTED] }));
    const exact = await engine.transaction(tx => redactRequestIntents(tx, [target('outcomeCarrier'), target('cafeCarrier'), target('unrelated')], undefined, { skipPending: true, exact: new Set(['other text', 'nothing to see']) }));
    const afterExact = { rows: await rowsOf(engine, ids), counters: await counters(engine) };
    expect([first, second, exact]).toEqual([5, 0, 3]);
    return { before, nothing, first, afterFirst, second, exact, afterExact };
  });
  parityTest('the journal members answer edge inputs alike: an empty list, an unknown id or source, a chunk with ids and an exclusion, no ceiling, a clamped release', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'readWriteRequestById', 'readCounterRows',
      'transaction', 'listRequestsForSlugs', 'readJournalCeiling', 'sweepJournalChunk', 'lockWriteRequestsById', 'readEffectBytes', 'redactWriteRequestRow', 'releaseTerminalBytes'],
  }, async (engine, backend) => {
    const ids = await seed(engine, backend);
    const sequences = new Map<string, string>();
    for (const [label, id] of Object.entries(ids)) sequences.set(String((await engine.readWriteRequestById(id))!.sequence), label);
    const seq = (s: string | null) => (s === null ? null : sequences.get(s) ?? '<unknown>');
    const unknownId = 'f0000000-0000-4000-8000-0000000000ff';
    const chunk = async (over: Partial<Parameters<BrainEngine['sweepJournalChunk']>[0]> = {}) => {
      const out = await engine.sweepJournalChunk({ sourceId: SRC, needles: [CLAIM.toLowerCase()], after: '0', ceiling: null, limit: 100, ids: null, exclude: null, ...over });
      return { rows: out.rows.map(r => ({ id: name(engine, r.id), pending: r.pending, matched: r.matched, hits: r.hits })), scanned: out.scanned, last: seq(out.last) };
    };
    const seqOf = (label: string) => [...sequences].find(([, l]) => l === label)![0];
    const chunks = {
      plain: await chunk(),
      noNeedles: await chunk({ needles: [] }),
      twoNeedles: await chunk({ needles: ['plain failure', CLAIM.toLowerCase(), 'no such text'] }),
      emptyNeedleMatchesAll: await chunk({ needles: [''], limit: 3 }),
      onlyIds: await chunk({ ids: [ids.intentCarrier!, ids.queuedCarrier!, ids.otherSource!, unknownId] }),
      emptyIds: await chunk({ ids: [] }),
      excluded: await chunk({ exclude: ids.intentCarrier! }),
      excludedUnknown: await chunk({ exclude: unknownId }),
      limited: await chunk({ limit: 3 }),
      pastEnd: await chunk({ after: String(Math.max(...[...sequences.keys()].map(Number))) }),
      afterThird: await chunk({ after: seqOf('messageCarrier'), ceiling: seqOf('queuedCarrier') }),
      otherSource: await chunk({ sourceId: OTHER }),
      unknownSource: await chunk({ sourceId: 'nobody' }),
    };
    const listed = async (slugs: string[], limit: number, after: string, sourceId = SRC) => (await engine.listRequestsForSlugs(sourceId, slugs, limit, after)).map(r => seq(r.sequence));
    const lists = [await listed([SLUG, SLUG], 100, '0'), await listed([SLUG], 2, seqOf('detailCarrier')), await listed([SLUG], 100, '0', 'nobody'), await listed([], 100, '0'), await listed(['notes/keeper'], 100, '0', OTHER)];
    const ceilings = [seq(await engine.readJournalCeiling(SRC)), seq(await engine.readJournalCeiling(OTHER)), await engine.readJournalCeiling('nobody')];
    const locked = async (wanted: string[]) => (await engine.transaction(tx => tx.lockWriteRequestsById(wanted))).map(r => name(engine, r.id)).sort();
    const locks = [await locked([]), await locked([unknownId]), await locked([ids.intentCarrier!, ids.otherSource!, unknownId]), await locked([ids.cafeCarrier!, ids.cafeCarrier!])];
    const effectBytes = [await engine.readEffectBytes(ids.outcomeCarrier!), await engine.readEffectBytes(ids.cafeCarrier!), await engine.readEffectBytes(ids.unrelated!), await engine.readEffectBytes(unknownId)];
    const before = { rows: await rowsOf(engine, ids), counters: await counters(engine) };
    await engine.transaction(async tx => {
      // A request nobody has, a null outcome and error detail (stored as NULL), and a replaced outcome.
      await tx.redactWriteRequestRow({ id: unknownId, terminalReservation: 1, outcome: null, errorDetail: null });
      await tx.redactWriteRequestRow({ id: ids.unrelated!, terminalReservation: 2000, outcome: null, errorDetail: null });
      await tx.redactWriteRequestRow({ id: ids.shouting!, terminalReservation: 3000, outcome: { kept: ['a', { b: 1 }], text: 'ü "q"' }, errorDetail: { why: 'x' } });
    });
    const afterRedact = { rows: await rowsOf(engine, ids), counters: await counters(engine) };
    const key = KEYS[0]!;
    await engine.transaction(async tx => {
      await tx.releaseTerminalBytes(key, 0);
      await tx.releaseTerminalBytes('principal:nobody:nothing', 500);
      await tx.releaseTerminalBytes(key, 7);
    });
    const afterSmall = await counters(engine);
    await engine.transaction(tx => tx.releaseTerminalBytes('brain', 10 ** 12));
    const afterClamp = await counters(engine);
    return { chunks, lists, ceilings, locks, effectBytes, before, afterRedact, afterSmall, afterClamp };
  });
});

describe('engine parity: the slug listing pages by numeric request sequence', () => {
  // Contract: paging findRequestsForSlugs with a cursor (the last row's sequence) returns every matching request once, in
  // numeric sequence order, when the sequences cross a digit width (9 -> 10). Regression: the listing once ordered by
  // `sequence::text`, so `10` sorted before `9` while the cursor compares numbers; a page that ended on `9` then skipped
  // every two-digit request below it, and those intents were never redacted (expiry pages by 1,000, the purge sweep by 10,000).
  parityTest('findRequestsForSlugs pages every request once, in numeric order, across a digit width', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'readWriteRequestById', 'listRequestsForSlugs'],
  }, async (engine) => {
    const PAGED = 'notes/paged';
    const wanted: string[] = [];
    const sequences = new Map<string, string>();
    // The arms start the journal sequence at different points (a Postgres test database keeps counting across cases), so
    // requests of another page fill the journal up to six below the next power of ten, and twelve requests of the paged
    // page then sit on both sides of it (9 -> 10, 99 -> 100, ...).
    let fillers = 0;
    for (let n = 100; wanted.length < 12; n++) {
      const filler = `filler-${n}`;
      const id = await journal(engine, filler, n, 'put_page', 'notes/keeper');
      const seq = String((await engine.readWriteRequestById(id))!.sequence);
      const nextPower = 10n ** BigInt(seq.length);
      if (!wanted.length && nextPower - BigInt(seq) > 6n) {
        fillers++;
        expect(fillers).toBeLessThan(5000);
        continue;
      }
      // Inside the window: this request belongs to the paged page instead.
      const label = `paged-${String(wanted.length + 1).padStart(2, '0')}`;
      const pagedId = await journal(engine, label, 10_000 + n, 'put_page', PAGED);
      wanted.push(label);
      sequences.set(label, String((await engine.readWriteRequestById(pagedId))!.sequence));
    }
    const widths = new Set([...sequences.values()].map(s => s.length));
    // The case is only meaningful when the sequences cross a digit width.
    expect(widths.size).toBeGreaterThan(1);
    const pages: string[][] = [];
    let after = '0';
    for (let guard = 0; guard < 10; guard++) {
      const rows = await findRequestsForSlugs(engine, SRC, [PAGED], 5, after);
      if (!rows.length) break;
      pages.push(rows.map(r => name(engine, r.id)));
      after = String(rows[rows.length - 1]!.sequence);
    }
    const listed = pages.flat();
    expect(listed).toEqual(wanted);
    return { crossesDigitWidth: widths.size > 1, pageSizes: pages.map(p => p.length), listed };
  });
});
