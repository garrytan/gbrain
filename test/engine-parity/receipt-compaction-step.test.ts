/**
 * Parity for one receipt's compaction (persistence/journal.ts `compactReceipt`): the step the consumer's compaction pass
 * and `gbrain repair receipt-compaction` run on each candidate receipt.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a settled receipt with no unfinished effect is compacted: its intent and error message are dropped, it is marked
 *    compacted, its reservation shrinks to what a compacted receipt keeps, and its counters release the rest. A receipt
 *    of a managed-sync run whose cursor is still open is kept (`open_sync_cursor`); a receipt in a state the call does
 *    not take, or one already compacted, is kept (`changed`); an unknown id is kept (`changed`).
 *  - Regression: every statement of the step ran as raw SQL (the two transaction-local timeouts, the locked receipt read
 *    with its open-cursor and open-pass checks, the unfinished-effect probe, the effect bytes, and the two updates),
 *    which the Rust engine refuses, so a Rust brain could not compact a receipt and its journal only grew.
 *  - Why existing coverage misses it: persistence.test.ts covers the compaction reads (the window and the candidate
 *    list), and repair-runner.test.ts applies the repair on an empty journal, so no case reaches the compaction itself.
 *  - Seam: the case calls the step on receipts seeded through typed members, rather than a whole consumer pass. Times
 *    and generated ids differ per arm, so it compares outcomes, flags and byte counts.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { compactReceipt } from '../../src/core/persistence/journal.ts';

const { parityTest } = parityArms(testBackends());

const PRINCIPAL = { kind: 'local_cli' as const, id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';

/** Admits, claims and settles one receipt with a 4096-byte reservation; returns its journal id. */
async function settle(engine: BrainEngine, requestId: string, intent: Record<string, unknown>, state: 'committed' | 'failed'): Promise<string> {
  const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  await engine.lockPersistenceCounters(KEYS);
  const { id } = await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: 'notes/compaction-example', worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent, authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page',
    protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS, clientRequestId: null, state: 'queued',
    deferredRefreshId: null,
  });
  await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
  await engine.completeWriteRow({
    id, state, outcome: {}, errorCode: state === 'failed' ? 'storage_error' : null, errorMessage: state === 'failed' ? 'parity failure' : null,
    consumerVersion: 'parity', consumerHostId: null, errorDetail: null, resultBytes: 0, counterKeys: KEYS, intentBytes: 100, retainedBytes: 4096,
    terminalReservation: 4096, probePurges: false,
  });
  return id;
}

/** The outcome of one compaction, or the refusal's code. */
const compact = (engine: BrainEngine, id: string, opts?: { states?: readonly string[] }) =>
  compactReceipt(engine, { id, principal_kind: PRINCIPAL.kind, principal_id: PRINCIPAL.id }, opts)
    .then(r => r, (e: { code?: string; message?: string }) => ({ refused: e.code ?? e.message ?? String(e) }));

/** What a compaction left on the receipt. */
async function receipt(engine: BrainEngine, id: string) {
  const row = await engine.readWriteRequestById(id);
  return row && { compacted: row.compacted === true, intent: row.intent ?? null, errorMessage: row.error_message ?? null,
    terminalReservation: Number(row.terminal_reservation) };
}

const terminalBytes = async (engine: BrainEngine) =>
  Object.fromEntries((await engine.readCounterRows(KEYS)).map(r => [r.key, Number(r.terminal_bytes)]));

describe('engine parity: a receipt compaction', () => {
  parityTest('a settled receipt is compacted and its counters release the rest; an open run, a state not taken and a compacted receipt are kept', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow',
      'writeOpCheckpointRecord', 'readWriteRequestById', 'readCounterRows'],
    timeout: 60_000,
  }, async (engine) => {
    const plain = await settle(engine, 'b0000000-0000-4000-8000-0000000000f1', { kind: 'put_page', slug: 'notes/compaction-example' }, 'committed');
    const run = await settle(engine, 'b0000000-0000-4000-8000-0000000000f2', { kind: 'put_page', slug: 'notes/compaction-example', runId: 'run-open' }, 'committed');
    const failed = await settle(engine, 'b0000000-0000-4000-8000-0000000000f3', { kind: 'put_page', slug: 'notes/compaction-example' }, 'failed');
    await engine.writeOpCheckpointRecord('managed-sync', 'parity-open-run', [{ runId: 'run-open', done: false }]);
    const before = await terminalBytes(engine);
    const out = {
      plain: await compact(engine, plain),
      plainAfter: await receipt(engine, plain),
      again: await compact(engine, plain),
      openRun: await compact(engine, run),
      runAfter: await receipt(engine, run),
      notTaken: await compact(engine, failed, { states: ['committed'] }),
      failed: await compact(engine, failed),
      failedAfter: await receipt(engine, failed),
      unknown: await compact(engine, 'a0000000-0000-4000-8000-0000000000a9'),
      released: Object.fromEntries(Object.entries(await terminalBytes(engine)).map(([k, v]) => [k, (before[k] ?? 0) - v])),
    };
    const compacted = { compacted: true, intent: null, errorMessage: null, terminalReservation: 1046 };
    expect(out).toEqual({
      plain: { freed_bytes: 3050 }, plainAfter: compacted, again: { skipped: 'changed' },
      openRun: { skipped: 'open_sync_cursor' },
      runAfter: { compacted: false, intent: { kind: 'put_page', slug: 'notes/compaction-example', runId: 'run-open' }, errorMessage: null, terminalReservation: 4096 },
      notTaken: { skipped: 'changed' }, failed: { freed_bytes: 3050 }, failedAfter: compacted, unknown: { skipped: 'changed' },
      released: { brain: 6100, 'principal:local_cli:parity-writer': 6100 },
    });
    return out;
  });
});
