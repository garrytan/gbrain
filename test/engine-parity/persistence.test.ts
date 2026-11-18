/**
 * BrainEngine parity — the write-journal members (engine-sql/persistence-journal.ts and persistence-claims.ts): the
 * limit read, the hold reads, one request's admission, claim and completion (in a transaction and member by member),
 * the claim upkeep (renewal, expiry, the claimable probe) and the admission reads (source membership, topology changes,
 * the ledger's source view).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the journal limit rows, the held-page and held-coverage reads, and the request lifecycle (lock the
 *    counters, insert the request, read it by request id and by journal id, stamp the claim, lock it, complete it)
 *    return the same observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers one of these differently (a limit key outside the prefix, a missing sentinel
 *    row, a counter that is not charged or not released, a claim that does not stamp the state) changes which writes a
 *    brain admits and when they finish; the Rust engine has no SQL, so each statement has to exist as a typed member.
 *  - Why existing coverage misses it: these statements ran through `executeRaw` inside journal.ts, limits.ts and
 *    held-reads.ts, which the parity cases cannot call (D18), so no case compared them across engines.
 *  - Seam: none in the cases. Typed members only (no executeRaw: D18). Generated values (the request's journal id, its
 *    sequence, time stamps, the source incarnation) are compared by shape or left out of the returned value.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import type { TopologyChange } from '../../src/core/engine-sql/persistence-claims.ts';
import { assertPageRequestIdentity } from '../../src/core/persistence/journal.ts';
import { CONSUMER_LIVE_MS, listHostConsumers, probeLiveFullConsumer, RESIDENT_CONSUMER_KINDS, startConsumerHeartbeat } from '../../src/core/persistence/consumer-heartbeat.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const REQUEST = 'b0000000-0000-4000-8000-0000000000b1';
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';

/** The counters as numbers, keyed by counter key. */
const counters = (rows: Array<{ key: string; outstanding_count: number | string; intent_bytes: number | string; lifetime_ids: number | string; terminal_bytes: number | string }>) =>
  Object.fromEntries(rows.map(r => [r.key, { outstanding: Number(r.outstanding_count), intentBytes: Number(r.intent_bytes), lifetimeIds: Number(r.lifetime_ids), terminalBytes: Number(r.terminal_bytes) }]));

/** The request columns every arm stores the same way. */
const view = (row: WriteRequest | null) => row && {
  principal: `${row.principal_kind}:${row.principal_id}`, requestId: row.request_id, operation: row.operation, source: row.source_id,
  slug: row.slug, state: row.state, digest: row.digest, intent: row.intent, authority: row.authority, targetKind: row.target_kind,
  protocol: row.protocol_version, intentBytes: Number(row.intent_bytes), terminalReservation: Number(row.terminal_reservation),
  outcome: row.outcome ?? null, errorCode: row.error_code ?? null, idIsUuid: UUID.test(row.id), completed: row.completed_at != null,
};

const HOST = 'e0000000-0000-4000-8000-0000000000e1';
const OTHER_TOKEN = 'c0000000-0000-4000-8000-0000000000c2';

/** The insert one parity request uses; `requestId` and `state` vary per case. */
const insertRow = (incarnation: string, requestId = REQUEST) => ({
  principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: 'put_page', sourceId: 'default',
  sourceIncarnation: incarnation, pageId: null, slug: 'notes/parity-example', worktreeId: null, topologyGeneration: null,
  digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/parity-example' }, authority: { scopes: ['write'] }, intentBytes: 100,
  terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
  clientRequestId: null, state: 'queued' as const, deferredRefreshId: null,
});

/** Admits one queued request outside a transaction, as each member runs on its own; returns its journal id. */
async function admitDirect(engine: BrainEngine, requestId = REQUEST): Promise<string> {
  const source = await engine.readSourceMembership('default');
  await engine.lockPersistenceCounters(KEYS);
  return (await engine.insertWriteRequest(insertRow(source!.incarnation, requestId))).id;
}

const WRITER = 'd0000000-0000-4000-8000-0000000000d1';
const OTHER_WRITER = 'd0000000-0000-4000-8000-0000000000d2';

/** A source-remove receipt of WRITER under REQUEST. */
const lifecycleRow = (incarnation: string) => ({
  principalId: WRITER, requestId: REQUEST, digest: 'e'.repeat(64), operation: 'remove', sourceId: 'default', sourceIncarnation: incarnation,
  worktreeIds: [], state: 'recovering' as const, recovery: { step: 1 }, recoveryBytes: 12, intentBytes: 34, terminalBytes: 4096,
  outcome: { operation: 'remove', source_id: 'default' },
});

/** The receipt columns every arm stores the same way. */
const topologyView = (row: TopologyChange | null, incarnation: string) => row && {
  idIsUuid: UUID.test(row.id), principal: row.principal_id, request: row.request_id, digest: row.digest, operation: row.operation,
  source: row.source_id, incarnation: row.source_incarnation === incarnation, worktrees: row.worktree_ids, state: row.state,
  recovery: row.recovery, recoveryBytes: Number(row.recovery_bytes), intentBytes: Number(row.intent_bytes),
  terminalBytes: Number(row.terminal_bytes), outcome: row.outcome,
};

async function lifecycle(engine: BrainEngine) {
  const source = await engine.readLedgerSource('default');
  expect(source?.incarnation).toMatch(UUID);
  return engine.transaction(async (tx) => {
    const locked = counters(await tx.lockPersistenceCounters(KEYS));
    const inserted = await tx.insertWriteRequest({
      principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId: REQUEST, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/parity-example', worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/parity-example' }, authority: { scopes: ['write'] }, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
    const charged = counters(await tx.lockPersistenceCounters(KEYS));
    const byRequest = await tx.readWriteRequest(PRINCIPAL.kind, PRINCIPAL.id, REQUEST);
    const byId = await tx.readWriteRequestById(inserted.id);
    const unknown = await tx.readWriteRequest(PRINCIPAL.kind, PRINCIPAL.id, 'b0000000-0000-4000-8000-0000000000b2');
    const claimed = await tx.stampWriteClaim(inserted.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const claim = claimed && { ...view(claimed), passedSync: claimed.passed_sync, seenSequence: claimed.seen_sequence, token: claimed.execution_token };
    const lockedRow = view(await tx.lockWriteRequest(inserted.id));
    const done = await tx.completeWriteRow({
      id: inserted.id, state: 'committed', outcome: { status: 'parity' }, errorCode: null, errorMessage: null, consumerVersion: 'parity',
      consumerHostId: null, errorDetail: null, resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500,
      terminalReservation: 4096, probePurges: true,
    });
    const completed = done && { ...view(done), purgeFacts: done.purge_has_facts, purgePages: done.purge_has_pages };
    const released = counters(await tx.lockPersistenceCounters(KEYS));
    return { locked, inserted: view(inserted), charged, byRequest: view(byRequest), sameRow: byId?.id === inserted.id, unknown, claim, lockedRow, completed, released };
  });
}

describe('engine parity: write journal', () => {
  parityTest('readJournalLimitRows returns the persistence.limits.* and page-body config rows, then the segmented-page row', { methods: ['setConfig', 'readJournalLimitRows'] }, async (engine) => {
    await engine.setConfig('persistence.limits.principal_lifetime_ids', '10');
    await engine.setConfig('persistence.limits.brain_outstanding', '50');
    await engine.setConfig('pages.max_bytes', '2000000');
    await engine.setConfig('persistence.limitsx', 'not a limit');
    await engine.setConfig('parity.journal.other', 'not a limit');
    const rows = await engine.readJournalLimitRows();
    const keyed = rows.filter(r => r.key !== null).sort((a, b) => a.key!.localeCompare(b.key!));
    const sentinel = rows.filter(r => r.key === null);
    expect(keyed).toEqual([
      { key: 'pages.max_bytes', value: '2000000' },
      { key: 'persistence.limits.brain_outstanding', value: '50' },
      { key: 'persistence.limits.principal_lifetime_ids', value: '10' },
    ]);
    expect(sentinel).toEqual([{ key: null, value: null }]);
    expect(rows.at(-1)).toEqual({ key: null, value: null });
    return { keyed, sentinel };
  });

  parityTest('the hold reads are empty on a brain with no held files', { methods: ['readHeldPageRows', 'readHeldCoverageRows'] }, async (engine) => {
    const pages = await engine.readHeldPageRows(['1', '2']);
    const noPages = await engine.readHeldPageRows([]);
    const everySource = await engine.readHeldCoverageRows(null);
    const oneSource = await engine.readHeldCoverageRows(['default']);
    const answers = { pages, noPages, everySource, oneSource };
    expect(answers).toEqual({ pages: [], noPages: [], everySource: [], oneSource: [] });
    return answers;
  });

  parityTest('one request is admitted, read, claimed, locked and completed, and its counters are charged then released', {
    methods: ['readLedgerSource', 'transaction', 'lockPersistenceCounters', 'insertWriteRequest', 'readWriteRequest', 'readWriteRequestById', 'stampWriteClaim', 'lockWriteRequest', 'completeWriteRow'],
  }, async (engine) => {
    const result = await lifecycle(engine);
    expect(result.locked).toEqual({ brain: { outstanding: 0, intentBytes: 0, lifetimeIds: 0, terminalBytes: 0 }, [KEYS[0]!]: { outstanding: 0, intentBytes: 0, lifetimeIds: 0, terminalBytes: 0 } });
    expect(result.charged.brain).toEqual({ outstanding: 1, intentBytes: 100, lifetimeIds: 1, terminalBytes: 4096 });
    expect(result.inserted?.state).toBe('queued');
    expect(result.byRequest).toEqual(result.inserted);
    expect(result.sameRow).toBe(true);
    expect(result.unknown).toBeNull();
    expect(result.claim).toMatchObject({ state: 'running', passedSync: false, seenSequence: null, token: TOKEN });
    expect(result.lockedRow?.state).toBe('running');
    expect(result.completed).toMatchObject({ state: 'committed', outcome: { status: 'parity' }, completed: true, purgeFacts: false, purgePages: false });
    expect(result.released.brain).toMatchObject({ outstanding: 0, intentBytes: 0, lifetimeIds: 1 });
    return result;
  });

  parityTest('each journal member works on its own, outside a transaction', {
    methods: ['readLedgerSource', 'lockPersistenceCounters', 'insertWriteRequest', 'readWriteRequest', 'readWriteRequestById', 'stampWriteClaim', 'lockWriteRequest', 'completeWriteRow'],
  }, async (engine) => {
    const source = await engine.readLedgerSource('default');
    const locked = counters(await engine.lockPersistenceCounters(KEYS));
    const inserted = await engine.insertWriteRequest(insertRow(source!.incarnation));
    const charged = counters(await engine.lockPersistenceCounters(KEYS));
    const byRequest = view(await engine.readWriteRequest(PRINCIPAL.kind, PRINCIPAL.id, REQUEST));
    const byId = view(await engine.readWriteRequestById(inserted.id));
    const claimed = await engine.stampWriteClaim(inserted.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const lockedRow = view(await engine.lockWriteRequest(inserted.id));
    const missing = await engine.lockWriteRequest('a0000000-0000-4000-8000-0000000000a9');
    const done = await engine.completeWriteRow({
      id: inserted.id, state: 'failed', outcome: null, errorCode: 'parity_error', errorMessage: 'parity', consumerVersion: 'parity',
      consumerHostId: null, errorDetail: { reason: 'parity' }, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 800,
      terminalReservation: 4096, probePurges: false,
    });
    const released = counters(await engine.lockPersistenceCounters(KEYS));
    const result = { locked, inserted: view(inserted), charged, byRequest, byId, claim: claimed && { ...view(claimed), passedSync: claimed.passed_sync, token: claimed.execution_token },
      lockedRow, missing, done: done && { ...view(done), detail: done.error_detail }, released };
    expect(result.byRequest).toEqual(result.inserted);
    expect(result.byId).toEqual(result.inserted);
    expect(result.claim).toMatchObject({ state: 'running', passedSync: false, token: TOKEN });
    expect(result.lockedRow?.state).toBe('running');
    expect(result.missing).toBeNull();
    expect(result.done).toMatchObject({ state: 'failed', errorCode: 'parity_error', completed: true, detail: { reason: 'parity' } });
    expect(result.released.brain).toMatchObject({ outstanding: 0, intentBytes: 0, lifetimeIds: 1 });
    return result;
  });

  parityTest('readWriteRequestProgress returns the progress columns of a queued, running and finished request, and null for an unknown id', {
    methods: ['readWriteRequestProgress', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const id = await admitDirect(engine);
    const progress = async () => {
      const row = await engine.readWriteRequestProgress(id);
      return row && { keys: Object.keys(row).sort(), state: row.state, errorCode: row.error_code ?? null, errorMessage: row.error_message ?? null,
        outcome: row.outcome ?? null, blocked: row.blocked_reason ?? null, deferredRefresh: row.deferred_refresh_id ?? null,
        deferredImport: row.deferred_import_from ?? null, completed: row.completed_at != null, updated: row.updated_at != null };
    };
    const queued = await progress();
    await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const running = await progress();
    await engine.completeWriteRow({
      id, state: 'failed', outcome: null, errorCode: 'parity_error', errorMessage: 'parity', consumerVersion: 'parity',
      consumerHostId: null, errorDetail: { reason: 'parity' }, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 800,
      terminalReservation: 4096, probePurges: false,
    });
    const finished = await progress();
    const missing = await engine.readWriteRequestProgress('a0000000-0000-4000-8000-0000000000a9');
    expect(queued).toMatchObject({ state: 'queued', completed: false, errorCode: null });
    expect(queued?.keys).toEqual(['blocked_reason', 'completed_at', 'deferred_import_from', 'deferred_refresh_id', 'error_code', 'error_message', 'outcome', 'state', 'updated_at']);
    expect(running).toMatchObject({ state: 'running', completed: false });
    expect(finished).toMatchObject({ state: 'failed', errorCode: 'parity_error', errorMessage: 'parity', completed: true });
    expect(missing).toBeNull();
    return { queued, running, finished, missing };
  });

  parityTest('the consumer row members find no consumers of a host without one, a renewed row is gone after its delete, and the worktree stamp changes nothing', {
    methods: ['listHostConsumerRows', 'probeLiveConsumerRows', 'renewConsumerRow', 'deleteConsumerRow', 'stampWorktreeHeartbeats'],
  }, async (engine) => {
    // The Rust store keeps no consumer rows (one process owns its brain), so the case compares no list taken between renew and delete.
    const host = 'e0000000-0000-4000-8000-0000000000e7';
    const key = { hostId: host, pid: 1, nonce: 'parity-nonce' };
    const before = await engine.listHostConsumerRows(host);
    const probe = await engine.probeLiveConsumerRows({ ...key, kinds: RESIDENT_CONSUMER_KINDS, liveMs: CONSUMER_LIVE_MS });
    const renewed = await engine.renewConsumerRow({ ...key, pidNs: null, kind: 'serve', mode: 'full', restartRequired: false, rootBarrierAgeMs: null,
      pool: null, hostJsonPath: '/parity/host.json', persistenceHome: '/parity', mintedUnder: null, version: 'parity', purgeMs: 60_000, bootId: null, processStart: null });
    await engine.deleteConsumerRow(key);
    const missingDelete = await engine.deleteConsumerRow(key);
    await engine.stampWorktreeHeartbeats(host);
    const after = await engine.listHostConsumerRows(host, { direct: true });
    expect(before).toEqual([]);
    expect(probe).toEqual([]);
    expect(after).toEqual([]);
    return { before, probe, renewed, missingDelete, after };
  });

  // PGLite admits one process, so its callers answer without an engine call; the Postgres and Rust arms reach every
  // consumer row member. The row read after the stop goes to the engine on every arm.
  parityTest('a consumer heartbeat renews and stops without a failure, and leaves the host with no live owner',
    { methods: ['listHostConsumerRows'] }, async (engine) => {
    const host = 'e0000000-0000-4000-8000-0000000000e8';
    const listed = await listHostConsumers(engine, host);
    const owner = await probeLiveFullConsumer(engine, host);
    const heartbeat = startConsumerHeartbeat(engine, host, { kind: 'serve', mode: 'full', everyMs: 3_600_000,
      report: () => ({ restart_required: false, root_barrier_age_ms: null }), paths: { host_json_path: '/parity/host.json', persistence_home: '/parity', minted_under: null } });
    await heartbeat.renew();
    const failures = heartbeat.failures;
    await heartbeat.stop();
    const afterStop = await listHostConsumers(engine, host);
    const rowsAfterStop = await engine.listHostConsumerRows(host);
    expect(listed).toEqual([]);
    expect(owner).toBeNull();
    expect(failures).toBe(0);
    expect(afterStop).toEqual([]);
    expect(rowsAfterStop).toEqual([]);
    return { listed, owner, failures, afterStop, rowsAfterStop };
  });

  parityTest('readSourceMembership returns the incarnation and archive flag, locked or not, and null for an unknown source', { methods: ['readSourceMembership'] }, async (engine) => {
    const plain = await engine.readSourceMembership('default');
    const locked = await engine.readSourceMembership('default', { lock: true });
    const unknown = await engine.readSourceMembership('parity-no-such-source');
    expect(plain?.incarnation).toMatch(UUID);
    expect(locked).toEqual(plain);
    expect(unknown).toBeNull();
    return { archived: plain?.archived, sameAsLocked: locked?.incarnation === plain?.incarnation, unknown };
  });

  parityTest('readLedgerSource reports no purges or coverage on a fresh brain, and the batch view adds the managed rows and plan mode', { methods: ['readLedgerSource'] }, async (engine) => {
    const plain = await engine.readLedgerSource('default');
    const batch = await engine.readLedgerSource('default', { batch: true });
    const unknown = await engine.readLedgerSource('parity-no-such-source');
    expect(batch?.incarnation).toBe(plain?.incarnation);
    expect(unknown).toBeNull();
    const strip = (s: typeof plain) => s && { ...s, incarnation: UUID.test(s.incarnation) };
    return { plain: strip(plain), batch: strip(batch), unknown };
  });

  parityTest('findTopologyChanges finds nothing for requests that changed no topology', { methods: ['findTopologyChanges'] }, async (engine) => {
    const one = await engine.findTopologyChanges(WRITER, [REQUEST]);
    const many = await engine.findTopologyChanges(WRITER, [REQUEST, OTHER_TOKEN]);
    expect({ one, many }).toEqual({ one: [], many: [] });
    return { one, many };
  });

  parityTest('a lifecycle receipt is stored, read back by (writer, request id), and a second one with the same id is refused', {
    methods: ['readLedgerSource', 'insertTopologyChange', 'readTopologyChange'],
  }, async (engine) => {
    const before = await engine.readTopologyChange(WRITER, REQUEST);
    const source = await engine.readLedgerSource('default');
    const inserted = await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const read = await engine.readTopologyChange(WRITER, REQUEST);
    const otherWriter = await engine.readTopologyChange(OTHER_WRITER, REQUEST);
    const otherRequest = await engine.readTopologyChange(WRITER, OTHER_TOKEN);
    const duplicate = await engine.insertTopologyChange(lifecycleRow(source!.incarnation)).then(() => 'stored', () => 'refused');
    const answers = { before, inserted: topologyView(inserted, source!.incarnation), read: topologyView(read, source!.incarnation),
      sameRow: read?.id === inserted.id, otherWriter, otherRequest, duplicate };
    expect(answers).toMatchObject({ before: null, sameRow: true, otherWriter: null, otherRequest: null, duplicate: 'refused' });
    expect(answers.read).toEqual(answers.inserted);
    expect(answers.inserted).toMatchObject({ idIsUuid: true, incarnation: true, state: 'recovering', recoveryBytes: 12, intentBytes: 34, terminalBytes: 4096 });
    return answers;
  });

  parityTest('findTopologyChanges finds the request id a lifecycle receipt of the same writer used', {
    methods: ['readLedgerSource', 'insertTopologyChange', 'findTopologyChanges'],
  }, async (engine) => {
    const source = await engine.readLedgerSource('default');
    await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const answers = {
      used: await engine.findTopologyChanges(WRITER, [OTHER_TOKEN, REQUEST]),
      otherWriter: await engine.findTopologyChanges(OTHER_WRITER, [REQUEST]),
      unused: await engine.findTopologyChanges(WRITER, [OTHER_TOKEN]),
    };
    expect(answers).toEqual({ used: [{ request_id: REQUEST }], otherWriter: [], unused: [] });
    return answers;
  });

  parityTest('a page write may not reuse the request id of the writer\'s lifecycle receipt', {
    methods: ['readLedgerSource', 'insertTopologyChange', 'readTopologyChange'],
  }, async (engine) => {
    const writer = { kind: 'local_cli', id: WRITER } as const;
    const outcome = (p: Promise<void>) => p.then(() => 'admitted', (e: { code?: string }) => e.code ?? 'error');
    const before = await outcome(assertPageRequestIdentity(engine, writer, REQUEST));
    const source = await engine.readLedgerSource('default');
    await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const after = await outcome(assertPageRequestIdentity(engine, writer, REQUEST));
    const otherRequest = await outcome(assertPageRequestIdentity(engine, writer, OTHER_TOKEN));
    const answers = { before, after, otherRequest };
    expect(answers).toMatchObject({ before: 'admitted', otherRequest: 'admitted' });
    expect(answers.after).not.toBe('admitted');
    return answers;
  });

  parityTest('hasClaimableWrite is false on an empty journal and true once a queued request waits', { methods: ['hasClaimableWrite', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim'] }, async (engine) => {
    const empty = await engine.hasClaimableWrite(HOST, []);
    const id = await admitDirect(engine);
    const queued = { config: await engine.hasClaimableWrite(HOST, []), on: await engine.hasClaimableWrite(HOST, [], { priority: true }),
      off: await engine.hasClaimableWrite(HOST, [], { priority: false }), excluded: await engine.hasClaimableWrite(HOST, ['/parity/elsewhere']) };
    await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    const claimed = await engine.hasClaimableWrite(HOST, []);
    const answers = { empty, queued, claimed };
    expect(answers).toEqual({ empty: false, queued: { config: true, on: true, off: true, excluded: true }, claimed: false });
    return answers;
  });

  parityTest('renewWriteClaim extends a claim held under its token and refuses any other token', { methods: ['renewWriteClaim', 'stampWriteClaim', 'readWriteRequestById'] }, async (engine) => {
    const id = await admitDirect(engine);
    await engine.stampWriteClaim(id, TOKEN, 1_000, JSON.stringify({ phase: 'preparing', token: TOKEN }));
    const before = await engine.readWriteRequestById(id);
    const held = await engine.renewWriteClaim({ id, token: TOKEN, leaseMs: 3_600_000, phaseJson: JSON.stringify({ phase: 'publishing', token: TOKEN }) });
    const renewed = await engine.readWriteRequestById(id);
    const keptPhase = await engine.renewWriteClaim({ id, token: TOKEN, leaseMs: 3_600_000, phaseJson: null });
    const kept = await engine.readWriteRequestById(id);
    const stranger = await engine.renewWriteClaim({ id, token: OTHER_TOKEN, leaseMs: 3_600_000, phaseJson: null });
    const unknown = await engine.renewWriteClaim({ id: 'a0000000-0000-4000-8000-0000000000a9', token: TOKEN, leaseMs: 1_000, phaseJson: null });
    const extended = new Date(renewed!.claim_expires_at!).getTime() - new Date(before!.claim_expires_at!).getTime() > 3_000_000;
    const answers = { held, phase: renewed?.claim_phase, keptPhase, keptPhaseValue: kept?.claim_phase, stranger, unknown, extended };
    expect(answers).toMatchObject({ held: true, phase: { phase: 'publishing' }, keptPhase: true, keptPhaseValue: { phase: 'publishing' }, stranger: false, unknown: false, extended: true });
    return answers;
  });

  parityTest('expireStaleWriteClaims returns an expired claim to queued, charges a preparing one when asked, and frees a dead owner\'s claim', {
    methods: ['expireStaleWriteClaims', 'stampWriteClaim', 'readWriteRequestById', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const expired = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const live = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const dead = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b3');
    await engine.stampWriteClaim(expired, TOKEN, -60_000, JSON.stringify({ phase: 'preparing', token: TOKEN }));
    await engine.stampWriteClaim(live, OTHER_TOKEN, 3_600_000, JSON.stringify({ phase: 'preparing', token: OTHER_TOKEN }));
    const deadToken = 'c0000000-0000-4000-8000-0000000000c3';
    await engine.stampWriteClaim(dead, deadToken, 3_600_000, JSON.stringify({ phase: 'publishing', token: deadToken, owner: { pid: 4242, nonce: 'n1', start: 's1' } }));
    await engine.expireStaleWriteClaims({ hostId: HOST, charge: true, deadOwners: [] });
    const afterExpiry = await Promise.all([expired, live, dead].map(id => engine.readWriteRequestById(id)));
    await engine.expireStaleWriteClaims({ hostId: HOST, charge: true, deadOwners: ['4242:n1:s1'] });
    const afterDead = await engine.readWriteRequestById(dead);
    const state = (r: WriteRequest | null) => r && { state: r.state, token: r.execution_token ?? null, leased: r.claim_expires_at != null, attempts: Number(r.preparation_attempts) };
    const answers = { afterExpiry: afterExpiry.map(state), afterDead: state(afterDead) };
    expect(answers).toEqual({
      afterExpiry: [{ state: 'queued', token: null, leased: false, attempts: 1 }, { state: 'running', token: OTHER_TOKEN, leased: true, attempts: 0 },
        { state: 'running', token: deadToken, leased: true, attempts: 0 }],
      afterDead: { state: 'queued', token: null, leased: false, attempts: 0 },
    });
    return answers;
  });
});

/** Admits a queued request and completes it as committed outside a transaction; returns its journal id. */
async function completeDirect(engine: BrainEngine, requestId: string): Promise<string> {
  const id = await admitDirect(engine, requestId);
  await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
  await engine.completeWriteRow({
    id, state: 'committed', outcome: { status: 'parity' }, errorCode: null, errorMessage: null, consumerVersion: 'parity',
    consumerHostId: null, errorDetail: null, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 800,
    terminalReservation: 4096, probePurges: false,
  });
  return id;
}

const TURN = { op: 'parity-housekeeping', hostId: HOST, leaseMs: 3_600_000, consumerKinds: ['serve', 'sync', 'jobs', 'autopilot', 'mcp'], consumerLiveMs: 30_000 };

describe('engine parity: write-journal housekeeping', () => {
  parityTest('claimHousekeepingTurn leases a free turn once, and completeHousekeepingTurn frees it after its interval', {
    methods: ['claimHousekeepingTurn', 'completeHousekeepingTurn'],
  }, async (engine) => {
    const first = await engine.claimHousekeepingTurn({ ...TURN, intervalMs: 3_600_000 });
    const leased = await engine.claimHousekeepingTurn({ ...TURN, intervalMs: 3_600_000 });
    const otherHost = await engine.claimHousekeepingTurn({ ...TURN, hostId: 'e0000000-0000-4000-8000-0000000000e2', intervalMs: 3_600_000 });
    await engine.completeHousekeepingTurn({ op: TURN.op, hostId: HOST });
    const inInterval = await engine.claimHousekeepingTurn({ ...TURN, intervalMs: 3_600_000 });
    const afterInterval = await engine.claimHousekeepingTurn({ ...TURN, intervalMs: -60_000 });
    const answers = { first, leased, otherHost, inInterval, afterInterval };
    expect(answers).toEqual({ first: true, leased: false, otherHost: true, inInterval: false, afterInterval: true });
    return answers;
  });

  parityTest('readReceiptBudget reads the retention setting, the brain\'s reserved terminal bytes and the cutoff', {
    methods: ['readReceiptBudget', 'setConfig', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const unset = await engine.readReceiptBudget('persistence.receipts.parity_retention_days', 30);
    await engine.setConfig('persistence.receipts.parity_retention_days', '45');
    await admitDirect(engine);
    const set = await engine.readReceiptBudget('persistence.receipts.parity_retention_days', 30);
    const cutoffShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
    const days = (Date.now() - Date.parse(set.cutoff)) / 86_400_000;
    const answers = { unsetRetention: unset.retention, retention: set.retention, used: Number(set.used), cutoffShape: cutoffShape.test(set.cutoff), cutoffDays: Math.round(days) };
    expect(answers).toEqual({ unsetRetention: null, retention: '45', used: 4096, cutoffShape: true, cutoffDays: 30 });
    return answers;
  });

  parityTest('listReservationsAfter walks the journal in sequence order past a cursor', {
    methods: ['listReservationsAfter', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
  }, async (engine) => {
    const ids = [await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b1'), await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2'),
      await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b3')];
    const all = await engine.listReservationsAfter('0', 10);
    const firstTwo = await engine.listReservationsAfter('0', 2);
    const rest = await engine.listReservationsAfter(firstTwo.at(-1)!.sequence, 10);
    const ascending = all.every((r, i) => i === 0 || BigInt(r.sequence) > BigInt(all[i - 1]!.sequence));
    const answers = { all: all.map(r => ids.indexOf(r.id)), compacted: all.map(r => r.compacted), firstTwo: firstTwo.map(r => ids.indexOf(r.id)),
      rest: rest.map(r => ids.indexOf(r.id)), ascending, sequenceIsText: all.every(r => typeof r.sequence === 'string') };
    expect(answers).toEqual({ all: [0, 1, 2], compacted: [false, false, false], firstTwo: [0, 1], rest: [2], ascending: true, sequenceIsText: true });
    return answers;
  });

  parityTest('listTrueUpRequests returns only the terminal requests asked for, with their effect bytes', {
    methods: ['listTrueUpRequests', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const done = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const queued = await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const rows = await engine.listTrueUpRequests<Record<string, unknown>>([done, queued, 'a0000000-0000-4000-8000-0000000000a9']);
    const none = await engine.listTrueUpRequests([]);
    const answers = { rows: rows.map(r => ({ done: r.id === done, principal: `${r.principal_kind}:${r.principal_id}`, outcome: r.outcome, authority: r.authority,
      terminalReservation: Number(r.terminal_reservation), compacted: r.compacted, effectBytes: r.effect_bytes, unfinished: r.unfinished })), none };
    expect(answers).toEqual({ rows: [{ done: true, principal: 'local_cli:parity-writer', outcome: { status: 'parity' }, authority: { scopes: ['write'] },
      terminalReservation: 800, compacted: false, effectBytes: '0', unfinished: false }], none: [] });
    return answers;
  });

  parityTest('listCompactableReceipts lists finished receipts older than the retention, oldest first', {
    methods: ['listCompactableReceipts', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const first = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    const second = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b3');
    const retained = await engine.listCompactableReceipts<{ id: string }>(30);
    const due = await engine.listCompactableReceipts<{ id: string; state: string }>(-1);
    const answers = { retained: retained.length, due: due.map(r => ({ which: [first, second].indexOf(r.id), state: r.state })) };
    expect(answers).toEqual({ retained: 0, due: [{ which: 0, state: 'committed' }, { which: 1, state: 'committed' }] });
    return answers;
  });

  parityTest('readCapacityForecastInputs buckets the window per writer and day, with the history and what compaction frees', {
    methods: ['readCapacityForecastInputs', 'readLedgerSource', 'insertTopologyChange', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'],
  }, async (engine) => {
    const empty = await engine.readCapacityForecastInputs({ light: true });
    const first = await completeDirect(engine, 'b0000000-0000-4000-8000-0000000000b1');
    await admitDirect(engine, 'b0000000-0000-4000-8000-0000000000b2');
    const source = await engine.readLedgerSource('default');
    await engine.insertTopologyChange(lifecycleRow(source!.incarnation));
    const full = await engine.readCapacityForecastInputs();
    const light = await engine.readCapacityForecastInputs({ light: true });
    const day = new Date().toISOString().slice(0, 10);
    const days = (inputs: typeof full) => inputs.days.map(d => ({ ...d, today: d.day === day, day: undefined })).sort((a, b) => a.scope.localeCompare(b.scope));
    const answers = {
      emptyDays: empty.days, emptyHistory: empty.history && { ...empty.history, age_days: empty.history.age_days === null ? null : 'set' },
      counters: full.counters.map(c => ({ key: c.key, lifetimeIds: c.lifetime_ids })),
      days: days(full),
      history: full.history && { firstIsOldest: full.history.first_id === first, ageDays: Math.round(full.history.age_days ?? -1), compactionAgeDays: Math.round(full.history.compaction_age_days ?? -1) },
      reclaimScopes: full.reclaim.map(r => r.scope),
      lightReclaim: light.reclaim, lightTableBytes: light.tableBytes, lightDays: days(light),
    };
    expect(answers).toMatchObject({
      emptyDays: [], counters: [{ key: 'brain', lifetimeIds: '2' }, { key: 'principal:local_cli:parity-writer', lifetimeIds: '2' }],
      history: { firstIsOldest: true, ageDays: 0, compactionAgeDays: 0 }, reclaimScopes: ['principal:local_cli:parity-writer'], lightReclaim: [], lightTableBytes: null,
    });
    expect(answers.days.map(d => [d.scope, d.ids, d.gross, d.recent_ids, d.today])).toEqual([
      ['principal:local_cli:d0000000-0000-4000-8000-0000000000d1', '1', '4096', '1', true],
      ['principal:local_cli:parity-writer', '2', '4896', '2', true],
    ]);
    expect(answers.lightDays).toEqual(answers.days);
    return answers;
  });

  parityTest('readCapacityForecastInputs lists the counters in byte order of their keys, whatever the server locale', {
    methods: ['readCapacityForecastInputs', 'lockPersistenceCounters'],
  }, async (engine) => {
    // en_US.utf8 sorts a before B and ignores the punctuation of 'a-b' against 'ab'; byte order puts B first and '-' before 'b'.
    const keys = ['principal:local_cli:ab', 'principal:local_cli:a', 'principal:local_cli:B', 'principal:local_cli:a-b', 'brain'];
    await engine.lockPersistenceCounters(keys);
    const read = (await engine.readCapacityForecastInputs({ light: true })).counters.map(c => c.key);
    expect(read).toEqual(['brain', 'principal:local_cli:B', 'principal:local_cli:a', 'principal:local_cli:a-b', 'principal:local_cli:ab']);
    return read;
  });

  parityTest('page writes queue, re-queue and drop projection jobs, and the window read lists them in key order', {
    methods: ['putPage', 'sealChunks', 'softDeletePage', 'deletePage', 'restorePage', 'updateSlug', 'readPageSnapshot', 'readSourceMembership',
      'listPendingSegmentedProjections', 'selectProjectionWindowJobs'],
  }, async (engine) => {
    const page = (slug: string) => ({ type: 'note' as const, title: slug, compiled_truth: `${slug} body` });
    for (const slug of ['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e']) await engine.putPage(slug, page(slug));
    // The same text again keeps the revision, so the job stays as it is.
    await engine.putPage('notes/a', page('notes/a'));
    await engine.sealChunks('notes/e', [{ chunk_index: 0, chunk_text: 'notes/e body', chunk_source: 'compiled_truth' }]);
    await engine.softDeletePage('notes/c');
    await engine.deletePage('notes/d');
    await engine.restorePage('notes/c');
    await engine.updateSlug('notes/b', 'notes/b2');
    const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
    const revisions = new Map<string, string>();
    for (const slug of ['notes/a', 'notes/b2', 'notes/c']) revisions.set(slug, (await engine.readPageSnapshot(slug))!.revision);
    const TS = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;
    const rows = (all: Awaited<ReturnType<BrainEngine['selectProjectionWindowJobs']>>) => all.map(r => ({
      lane: r.lane, ord: r.ord === null ? null : Number(r.ord), ordType: typeof r.ord, slug: r.slug,
      inc: r.source_incarnation === null ? null : r.source_incarnation === incarnation,
      revision: r.revision === null ? null : r.revision === revisions.get(r.slug ?? ''), highWater: r.high_water === null ? null : TS.test(r.high_water),
    })).sort((x, y) => (x.lane ?? '').localeCompare(y.lane ?? '') || (x.ord ?? 0) - (y.ord ?? 0) || (x.slug ?? '').localeCompare(y.slug ?? ''));
    const start = { after: { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' }, highWater: null };
    const first = await engine.selectProjectionWindowJobs(start, true);
    const highWater = first[0]!.high_water!;
    const wrapped = await engine.selectProjectionWindowJobs({ after: { source_incarnation: incarnation, slug: 'notes/a' }, highWater }, false);
    const later = await engine.selectProjectionWindowJobs({ ...start, highWater: '2999-01-01 00:00:00+00' }, true);
    const pending = await engine.listPendingSegmentedProjections({ limit: 10 });
    const anyPending = await engine.listPendingSegmentedProjections({ limit: 10, retryCooldown: false });
    const answers = { first: rows(first), wrapped: rows(wrapped), later: rows(later), pending, anyPending };
    const row = (lane: string, ord: number, slug: string) => ({ lane, ord, ordType: 'number' as const, slug, inc: true, revision: true, highWater: true });
    expect(answers).toEqual({
      first: [row('recent', 0, 'notes/a'), row('recent', 0, 'notes/b2'), row('recent', 0, 'notes/c'),
        row('window', 1, 'notes/a'), row('window', 2, 'notes/b2'), row('window', 3, 'notes/c')],
      wrapped: [row('recent', 0, 'notes/a'), row('recent', 0, 'notes/b2'), row('recent', 0, 'notes/c'),
        row('window', 1, 'notes/b2'), row('window', 2, 'notes/c'), row('window', 3, 'notes/a')],
      later: [row('window', 1, 'notes/a'), row('window', 2, 'notes/b2'), row('window', 3, 'notes/c')],
      pending: [], anyPending: [],
    });
    return answers;
  });

  parityTest('the projection queue reads find no pending job on a brain whose pages are projected', {
    methods: ['listPendingSegmentedProjections', 'selectProjectionWindowJobs'],
  }, async (engine) => {
    const pending = await engine.listPendingSegmentedProjections({ limit: 10 });
    const cooldownOff = await engine.listPendingSegmentedProjections({ limit: 10, retryCooldown: false, reasons: ['segmented_projecting'], exclude: ['x/y'] });
    const cursor = { after: { source_incarnation: '00000000-0000-0000-0000-000000000000', slug: '' }, highWater: null };
    const window = await engine.selectProjectionWindowJobs(cursor, true);
    const anyWindow = await engine.selectProjectionWindowJobs(cursor, false);
    const nulls = [{ lane: null, ord: null, source_incarnation: null, slug: null, revision: null, high_water: null }];
    const answers = { pending, cooldownOff, window, anyWindow };
    expect(answers).toEqual({ pending: [], cooldownOff: [], window: nulls, anyWindow: nulls });
    return answers;
  });
});
