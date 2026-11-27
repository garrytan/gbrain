/**
 * Parity for the write and the `effective` probes of a restricted `sync.admission` (engine-sql/sync-admission.ts):
 * persistence/sync-admission.ts `writeSyncAdmission` dates the value it stores, and `syncAdmissionStatus` asks
 * whether a pass pinned before that date still holds the drain lease, or a destructive request admitted before it is
 * still unpublished.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1) writeSyncAdmission stores the value and a dating row `[{value, set_at}]` in one
 *    transaction and returns `set_at`; writeSyncAdmissionStamp refuses nothing it is given; readSyncAdmissionEffects
 *    reports `pinned` only for an `open` pass row whose lease token holds the live lock and that started before
 *    `set_at` (or with no `set_at`), and `destructive` only for a queued, running or recovering request of the source
 *    incarnation with a destructive kind created before `set_at`.
 *  - Regression: a wrong `pinned` or `destructive` tells the user a restricted admission is in effect while a pass or a
 *    delete admitted before it can still remove files, or the reverse.
 *  - Why existing coverage misses it: the stamp INSERT and the probe SELECT ran through `executeRaw`, which the Rust
 *    engine refuses, and test/sync-admission-6712.test.ts runs on PGLite and Postgres only. The statement texts are
 *    pinned by test/engine-sql-caller-raw-sql-pins.test.ts.
 *  - Seam: the pass row is written through writeOpCheckpointRecords (the parent writePassRow writes), the lease through
 *    acquireCycleLock and requests through the journal members. `set_at` differs between arms, so it is compared by
 *    presence and order.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { refusesInput } from './input-refusal.ts';
import { syncLockId } from '../../src/core/db-lock.ts';
import { SYNC_ADMISSION_DESTRUCTIVE_KINDS, SYNC_ADMISSION_KEY, SYNC_ADMISSION_SET_OP, writeSyncAdmission } from '../../src/core/persistence/sync-admission.ts';
import { MANAGED_SYNC_PASS_OP, passFingerprint } from '../../src/core/persistence/sync-pass-row.ts';

const { parityTest } = parityArms(testBackends());

const TOKEN = 'a1000000-0000-4000-8000-000000000001';
const OTHER_TOKEN = 'a1000000-0000-4000-8000-000000000002';
const rid = (n: number) => `f1000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

async function incarnationOf(engine: BrainEngine): Promise<string> {
  return (await engine.readSourceMembership('default'))!.incarnation;
}

/** The source's pass row: `open` unless `outcome` says otherwise, started at `startedAt`, holding `token`. */
async function pass(engine: BrainEngine, incarnation: string, token: string, startedAt: string, outcome = 'open'): Promise<void> {
  await engine.writeOpCheckpointRecords(MANAGED_SYNC_PASS_OP, [{ fingerprint: passFingerprint('default', incarnation), record: {
    source_id: 'default', incarnation, lease_token: token, obligations: { baseline_commit: null, mismatch: {}, not_converged_streak: 0, faults: {} },
    telemetry: { pass_id: 'b1000000-0000-4000-8000-000000000001', target: 'f'.repeat(40), started_at: startedAt, ended_at: null, kind: 'full', round: 1,
      outcome, stop_reason: null, candidates: 3, settled: 0, remaining: 3, counts: {}, duration_ms: null, timings_ms: {} } } }]);
}

/** One request of the source incarnation with intent kind `kind`, in `state` (queued unless named). */
async function request(engine: BrainEngine, n: number, kind: string, incarnation: string, state = 'queued'): Promise<void> {
  const keys = ['principal:local_cli:parity-admission', 'brain'];
  await engine.lockPersistenceCounters(keys);
  await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'parity-admission', requestId: rid(n), operation: 'submit_job', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: `notes/alice-example-${n}`, worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64),
    intent: { kind }, authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1,
    admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null,
    // The member types an admission's own states; this case also stores rows already in later states, which the column accepts.
    state: state as 'queued' | 'deferred', deferredRefreshId: null,
  });
}

function effects(engine: BrainEngine, incarnation: string, setAt: string | null, kinds: readonly string[] = SYNC_ADMISSION_DESTRUCTIVE_KINDS) {
  return engine.readSyncAdmissionEffects({ lockId: syncLockId('default'), passOp: MANAGED_SYNC_PASS_OP, passKey: passFingerprint('default', incarnation),
    setAt, sourceId: 'default', incarnation, kinds });
}

const stamp = async (engine: BrainEngine, value: string) => engine.writeSyncAdmissionStamp(SYNC_ADMISSION_SET_OP, 'brain', value);

parityTest('writeSyncAdmission stores the value and its dating row in one transaction and returns set_at', {
  methods: ['transaction', 'setConfig', 'writeSyncAdmissionStamp', 'readOpCheckpointRecords', 'readStoredConfigValue'],
}, async (engine) => {
  const first = await writeSyncAdmission(engine, 'imports_only');
  const second = await writeSyncAdmission(engine, 'classify_only');
  const [row] = await engine.readOpCheckpointRecords(SYNC_ADMISSION_SET_OP, ['brain']) as Array<{ value: string; set_at: string }>;
  // A transaction that fails after the stamp keeps neither the value nor the stamp.
  const rolledBack = await engine.transaction(async (tx) => {
    await tx.setConfig(SYNC_ADMISSION_KEY, 'normal');
    await tx.writeSyncAdmissionStamp(SYNC_ADMISSION_SET_OP, 'brain', 'normal');
    throw new Error('parity rollback');
  }).catch((e: Error) => e.message);
  const [kept] = await engine.readOpCheckpointRecords(SYNC_ADMISSION_SET_OP, ['brain']) as Array<{ value: string; set_at: string }>;
  return {
    iso: [first, second].every(t => !Number.isNaN(Date.parse(t)) && t.endsWith('Z')), ordered: Date.parse(first) <= Date.parse(second),
    row: { keys: Object.keys(row!).sort(), value: row!.value, setAtParses: !Number.isNaN(Date.parse(row!.set_at)),
      sameInstant: Date.parse(row!.set_at) === Date.parse(second) },
    stored: await engine.readStoredConfigValue(SYNC_ADMISSION_KEY), rolledBack, kept: kept!.value, keptInstant: Date.parse(kept!.set_at) === Date.parse(second),
  };
});

parityTest('readSyncAdmissionEffects: pinned only for an open pass that started before set_at and still holds the live lease', {
  methods: ['readSyncAdmissionEffects', 'writeSyncAdmissionStamp', 'writeOpCheckpointRecords', 'acquireCycleLock', 'readSourceMembership'],
}, async (engine) => {
  const incarnation = await incarnationOf(engine);
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const nothing = await effects(engine, incarnation, null);
  await pass(engine, incarnation, TOKEN, past);
  const noLease = await effects(engine, incarnation, null);
  await engine.acquireCycleLock(syncLockId('default'), { holderPid: 4242, holderHost: 'host-example', acquisitionToken: TOKEN, ttlMinutes: 2, stealGraceSeconds: 0 });
  const setAt = await stamp(engine, 'imports_only');
  const held = { unset: await effects(engine, incarnation, null), before: await effects(engine, incarnation, setAt) };
  await pass(engine, incarnation, TOKEN, future);
  const startedAfter = await effects(engine, incarnation, setAt);
  await pass(engine, incarnation, OTHER_TOKEN, past);
  const otherToken = await effects(engine, incarnation, setAt);
  await pass(engine, incarnation, TOKEN, past, 'converged');
  const closed = await effects(engine, incarnation, setAt);
  await pass(engine, incarnation, TOKEN, past);
  const otherIncarnation = await effects(engine, 'f0000000-0000-4000-8000-000000000000', null);
  const out = { nothing, noLease, held, startedAfter, otherToken, closed, otherIncarnation, again: await effects(engine, incarnation, setAt) };
  expect(Object.fromEntries(Object.entries({ ...out, ...held }).filter(([k]) => k !== 'held').map(([k, v]) => [k, (v as { pinned: boolean }).pinned]))).toEqual({
    nothing: false, noLease: false, startedAfter: false, otherToken: false, closed: false, otherIncarnation: false, again: true, unset: true, before: true });
  return out;
});

parityTest('readSyncAdmissionEffects: a pass whose matching lease has expired is not pinned', {
  methods: ['readSyncAdmissionEffects', 'writeOpCheckpointRecords', 'acquireCycleLock', 'readSourceMembership'],
}, async (engine) => {
  const incarnation = await incarnationOf(engine);
  await pass(engine, incarnation, TOKEN, new Date(Date.now() - 3_600_000).toISOString());
  // A negative TTL writes a lease that expired a minute ago, with no wait.
  await engine.acquireCycleLock(syncLockId('default'), { holderPid: 4242, holderHost: 'host-example', acquisitionToken: TOKEN, ttlMinutes: -1, stealGraceSeconds: 0 });
  const result = await effects(engine, incarnation, null);
  expect(result).toEqual({ pinned: false, destructive: false });
  return result;
});

parityTest('readSyncAdmissionEffects: destructive only for an unpublished destructive request of the incarnation admitted before set_at', {
  methods: ['readSyncAdmissionEffects', 'writeSyncAdmissionStamp', 'insertWriteRequest', 'lockPersistenceCounters', 'readSourceMembership'],
}, async (engine) => {
  const incarnation = await incarnationOf(engine);
  await request(engine, 1, 'put_page', incarnation);
  const notDestructive = await effects(engine, incarnation, null);
  await request(engine, 2, 'canonical_reconcile', incarnation);
  // PGLite's clock can read the same millisecond twice, and the probe's `created_at < set_at` is strict: stamp later.
  await Bun.sleep(5);
  const setAt = await stamp(engine, 'classify_only');
  const admittedBefore = { unset: await effects(engine, incarnation, null), before: await effects(engine, incarnation, setAt),
    otherKinds: await effects(engine, incarnation, setAt, ['managed_sync_delete']), noKinds: await effects(engine, incarnation, setAt, []) };
  const later = await stamp(engine, 'classify_only');
  await Bun.sleep(5);
  await request(engine, 3, 'managed_sync_delete', incarnation);
  const admittedAfterOnly = await effects(engine, incarnation, setAt, ['managed_sync_delete']);
  const out = {
    notDestructive, admittedBefore, admittedAfterOnly, laterSetAt: Date.parse(later) >= Date.parse(setAt),
    upperIncarnation: await effects(engine, incarnation.toUpperCase(), setAt),
    otherIncarnation: await effects(engine, 'f0000000-0000-4000-8000-000000000000', null),
  };
  expect([notDestructive.destructive, admittedBefore.unset.destructive, admittedBefore.before.destructive, admittedBefore.otherKinds.destructive,
    admittedBefore.noKinds.destructive, admittedAfterOnly.destructive, out.upperIncarnation.destructive, out.otherIncarnation.destructive])
    .toEqual([false, true, true, false, false, false, true, false]);
  return out;
});

parityTest('readSyncAdmissionEffects: a destructive request blocks its own source while queued, running or recovering, and not once it ends', {
  methods: ['readSyncAdmissionEffects', 'insertWriteRequest', 'lockPersistenceCounters', 'readSourceMembership'],
}, async (engine) => {
  const incarnation = await incarnationOf(engine);
  const states = ['queued', 'running', 'recovering', 'committed', 'conflict', 'failed', 'cancelled'];
  // One request per state, each under its own kind, so asking for that kind sees that request alone.
  for (const [i, state] of states.entries()) await request(engine, 10 + i, `delete-${state}`, incarnation, state);
  const out: Record<string, boolean> = {};
  for (const state of states) out[state] = (await effects(engine, incarnation, null, [`delete-${state}`])).destructive;
  // The queued request of `default` does not block another source that reports the same incarnation.
  out.otherSource = (await engine.readSyncAdmissionEffects({ lockId: syncLockId('default'), passOp: MANAGED_SYNC_PASS_OP,
    passKey: passFingerprint('default', incarnation), setAt: null, sourceId: 'other-example', incarnation, kinds: ['delete-queued'] })).destructive;
  expect(out).toEqual({ queued: true, running: true, recovering: true, committed: false, conflict: false, failed: false, cancelled: false, otherSource: false });
  return out;
});

parityTest('readSyncAdmissionEffects: a stamp written later in the transaction that queued a destructive request still dates after it', {
  methods: ['transaction', 'readSyncAdmissionEffects', 'writeSyncAdmissionStamp', 'insertWriteRequest', 'lockPersistenceCounters', 'readSourceMembership'],
}, async (engine) => {
  const incarnation = await incarnationOf(engine);
  // A request's created_at is the transaction's start (`now()`); set_at is the moment of the stamp (`clock_timestamp()`).
  const setAt = await engine.transaction(async (tx) => {
    await request(tx, 40, 'managed_sync_delete', incarnation);
    await Bun.sleep(5);
    return stamp(tx, 'classify_only');
  });
  const out = { destructive: (await effects(engine, incarnation, setAt, ['managed_sync_delete'])).destructive };
  expect(out).toEqual({ destructive: true });
  return out;
});

parityTest('readSyncAdmissionEffects refuses a malformed incarnation or set_at, and a malformed stamp value writes nothing', {
  methods: ['readSyncAdmissionEffects', 'writeSyncAdmissionStamp', 'readOpCheckpointRecords', 'readSourceMembership'],
}, async (engine) => {
  const incarnation = await incarnationOf(engine);
  const refuses = refusesInput;
  const badIncarnation = await refuses(effects(engine, 'not-a-uuid', null));
  const badSetAt = await refuses(effects(engine, incarnation, 'not-a-time'));
  // Control: the same probe with valid inputs answers.
  const valid = await effects(engine, incarnation, null);
  // A stamp value holding NUL is refused, and the stamp written before it stays.
  await stamp(engine, 'imports_only');
  const nulStamp = await refuses(stamp(engine, 'bad\u0000value'));
  const [kept] = await engine.readOpCheckpointRecords(SYNC_ADMISSION_SET_OP, ['brain']) as Array<{ value: string }>;
  return { badIncarnation, badSetAt, valid, nulStamp, kept: kept?.value };
});
