/**
 * BrainEngine parity — the write-journal members (engine-sql/persistence-journal.ts): the limit read, the hold reads
 * and one request's admission, claim and completion.
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
});
