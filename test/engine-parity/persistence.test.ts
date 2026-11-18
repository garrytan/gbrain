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
    const one = await engine.findTopologyChanges('d0000000-0000-4000-8000-0000000000d1', [REQUEST]);
    const many = await engine.findTopologyChanges('d0000000-0000-4000-8000-0000000000d1', [REQUEST, OTHER_TOKEN]);
    expect({ one, many }).toEqual({ one: [], many: [] });
    return { one, many };
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
