/**
 * BrainEngine parity: the doctor persistence reads of engine-sql/doctor-persistence.ts, which the persistence doctor
 * checks and the helpers under src/core/persistence/ used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so each persistence doctor check reads the same finding on each.
 *    The members the Rust store has no writer for answer the empty state, which is what the other arms answer on a brain
 *    with no such row. The stalled catch-up, parked group and source movement reads are checked on seeded rows too (a
 *    claimed checkout, busy and parked Git effects through the effect worker's members), since the Rust store keeps them.
 *  - Regression: an engine whose read drifts (or does not serve it) gives a different doctor status, message or count
 *    per backend: a capacity or stall finding the brain does not have, or one it does have that goes unreported.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw). The admission and completion are real writes
 *    (`insertWriteRequest`, `completeWriteRow`); generated values (ids, sequences, time stamps) are compared by shape.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import { createSource } from './harness.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const KEY = 'principal:local_cli:parity-writer';
const KEYS = [KEY, 'brain'];
const REQ_1 = 'b0000000-0000-4000-8000-0000000000b1';
const REQ_2 = 'b0000000-0000-4000-8000-0000000000b2';
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const PRINCIPAL = ['local_cli', 'parity-writer'] as const;
const DRIFT_MESSAGE = 'the file changed under the write';

async function admit(engine: BrainEngine, requestId: string, slug: string, operation: string, intent: Record<string, unknown> = {}): Promise<string> {
  return (await admitRow(engine, requestId, slug, operation, intent)).id;
}

async function admitRow(engine: BrainEngine, requestId: string, slug: string, operation: string, intent: Record<string, unknown> = {}, sourceId = 'default'): Promise<{ id: string; sequence: string | number }> {
  const source = await engine.readSourceMembership(sourceId);
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: PRINCIPAL[0], principalId: PRINCIPAL[1], requestId, operation, sourceId,
    sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent, authority: {}, intentBytes: 10, terminalReservation: 4096, targetKind: 'page',
    protocolVersion: 1, admitterVersion: 'v-test', admitterHostId: null, counterKeys: KEYS, clientRequestId: null,
    state: 'queued', deferredRefreshId: null,
  });
  return row;
}

async function settle(engine: BrainEngine, id: string, state: 'committed' | 'conflict' | 'failed', fields: { code?: string; message?: string; detail?: unknown; outcome?: unknown } = {}): Promise<void> {
  await engine.completeWriteRow({
    id, state, outcome: fields.outcome ?? null, errorCode: fields.code ?? null, errorMessage: fields.message ?? null,
    consumerVersion: 'v-consumer', consumerHostId: null, errorDetail: fields.detail ?? null, resultBytes: 100,
    counterKeys: KEYS, intentBytes: 10, retainedBytes: 512, terminalReservation: 4096, probePurges: true,
  });
}

/** Counter rows as numbers, keyed by key. */
const counted = (rows: Array<{ key: string; outstanding_count?: string; lifetime_ids: string }>) =>
  Object.fromEntries(rows.map(r => [r.key, { outstanding: r.outstanding_count === undefined ? null : Number(r.outstanding_count), lifetime: Number(r.lifetime_ids) }]));

const nulls = ['default'];
const OPS = ['put_page', 'remember'];

describe('doctor persistence reads', () => {
  parityTest(
    'the writer status reads list seeded writer_busy catch-ups, parked Git targets by former binding and a claimed source binding, in byte order',
    { methods: ['listStalledCatchupRows', 'listParkedGroupRows', 'listSourceBindingsForMovement', 'insertPublicationEffects',
      'selectClaimableEffect', 'stampEffectClaim', 'retryBusyEffectRow', 'parkEffectRow', 'transactionDirect', 'declarePersistence',
      'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'] },
    async (engine, backend) => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-doctor-seeded-')));
      try {
        return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const root = join(home, 'checkout');
          await Bun.write(join(root, 'example.md'), 'generic example');
          await createSource(engine, backend, 'work', {}, root);
          let binding: Awaited<ReturnType<typeof claimWorktree>>;
          try { binding = await claimWorktree(engine, 'work', root); } finally { await disposePersistenceConsumer(engine); }
          // Five Git effects, each under its own request: on the claimed checkout (one busy, one parked), on `default`
          // under the claimed worktree it is not bound to (parked: its binding changed), and on `ab` and `a-c` with no
          // worktree (busy). `ab` and `a-c` sort `a-c` first in byte order and `ab` first in en_US.
          for (const id of ['ab', 'a-c']) await createSource(engine, backend, id, { kind: 'notes' });
          const SEEDS = [
            { request: REQ_1, source: 'work', path: 'notes/busy.md', worktree: true },
            { request: REQ_2, source: 'work', path: 'notes/parked.md', worktree: true },
            { request: 'b0000000-0000-4000-8000-0000000000b3', source: 'default', path: 'notes/moved.md', worktree: true },
            { request: 'b0000000-0000-4000-8000-0000000000b4', source: 'ab', path: 'notes/later.md', worktree: false },
            { request: 'b0000000-0000-4000-8000-0000000000b5', source: 'a-c', path: 'notes/older.md', worktree: false },
          ] as const;
          for (const seed of SEEDS) {
            const incarnation = (await engine.readSourceMembership(seed.source))!.incarnation;
            const id = (await admitRow(engine, seed.request, seed.path.replace(/\.md$/, ''), 'put_page', {}, seed.source)).id;
            await engine.transactionDirect(async tx => {
              await tx.declarePersistence();
              await tx.insertPublicationEffects({ requestId: id, revision: null, sourceId: seed.source, sourceIncarnation: incarnation,
                worktreeId: seed.worktree ? binding.worktree_id : null, effects: [{ kind: 'git', data: { relative_path: seed.path } }] });
            });
          }
          const busy: Record<string, Record<string, unknown>> = {
            'notes/busy.md': { busy_since: '2026-01-01T00:00:00.000Z', busy_retries: 3 },
            'notes/later.md': { busy_since: '2999-01-01T00:00:00.000Z' },
            'notes/older.md': { busy_since: '2026-02-01T00:00:00.000Z', busy_retries: 1 },
          };
          const parked: Record<string, unknown[]> = {
            'notes/parked.md': [{ slug: 'notes/a', error_code: 'held_by_rule', rule: 'r-1' }, { slug: 'notes/b', error_code: 'held_by_rule', rule: 'r-0' }],
            'notes/moved.md': [{ slug: 'notes/c', error_code: 'held_by_rule', rule: 'r-5' }, { slug: 'notes/d' }],
          };
          type Claimed = { id: string | number; execution_token: string; data: { relative_path?: string } };
          for (let n = 1; n <= SEEDS.length; n++) {
            const row = await engine.transactionDirect(async tx => {
              await tx.declarePersistence();
              const candidate = await tx.selectClaimableEffect<Claimed>(binding.owner_host_id!, []);
              const token = `f0000000-0000-4000-8000-00000000000${n}`;
              return tx.stampEffectClaim<Claimed>({ id: candidate!.id, token, ownerJson: JSON.stringify({ token }) });
            });
            const ref = { id: row!.id, token: row!.execution_token };
            const path = row!.data.relative_path!;
            if (busy[path]) await engine.retryBusyEffectRow({ ...ref, dataJson: JSON.stringify(busy[path]), delayMs: 3_600_000 });
            else await engine.parkEffectRow({ ...ref, dataJson: JSON.stringify({ relative_path: path, parked: parked[path] }) });
          }
          const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
          const catchups = (await engine.listStalledCatchupRows(null, 60_000))
            .map(r => ({ ...r, since: new Date(r.since as string | Date).toISOString() }));
          const groups = (await engine.listParkedGroupRows(null)).map(r => ({ ...r, worktree_ids: r.worktree_ids.map(w => w === binding.worktree_id ? '<claimed>' : w),
            current_worktree_id: r.current_worktree_id === binding.worktree_id ? '<claimed>' : r.current_worktree_id }));
          const movement = (await engine.listSourceBindingsForMovement(null)).map(r => ({ source_id: r.source_id,
            worktree: UUIDISH.test(r.worktree_id), incarnation: UUIDISH.test(r.source_incarnation), owner: UUIDISH.test(String(r.owner_host_id)) }));
          const answers = { catchups, scoped: await engine.listStalledCatchupRows(['ab', 'work'], 60_000), groups,
            scopedGroups: (await engine.listParkedGroupRows(['default'])).map(r => r.source_id), movement };
          const busyRow = (source_id: string, stalled: number, since: string, retries: number) => ({ source_id, stalled, busy: 1, since, retries });
          expect(answers.catchups).toEqual([busyRow('a-c', 1, '2026-02-01T00:00:00.000Z', 1), busyRow('ab', 0, '2999-01-01T00:00:00.000Z', 0),
            busyRow('work', 1, '2026-01-01T00:00:00.000Z', 3)]);
          expect(answers.scoped.map(r => r.source_id)).toEqual(['ab', 'work']);
          const moved = { source_id: 'default', former: 'binding_changed' as const, effects: 1, targets: 1, worktree_ids: ['<claimed>'], current_worktree_id: null,
            requests: ['b0000000-0000-4000-8000-0000000000b3'] };
          expect(answers.groups).toEqual([{ ...moved, code: 'held_by_rule', rule: 'r-5' }, { ...moved, code: null as unknown as string, rule: null },
            { source_id: 'work', code: 'held_by_rule', former: null, effects: 1, targets: 2, rule: 'r-0', worktree_ids: ['<claimed>'],
              current_worktree_id: '<claimed>', requests: [REQ_2] }]);
          expect(answers.scopedGroups).toEqual(['default', 'default']);
          expect(answers.movement).toEqual([{ source_id: 'work', worktree: true, incarnation: true, owner: true }]);
          return answers;
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    },
  );

  parityTest(
    'the parked-effects reads count and list seeded parked effects and group held Git pushes per source and worktree, in byte order',
    { methods: ['countParkedEffects', 'listParkedEffects', 'listGitPushHoldRows', 'insertPublicationEffects', 'selectClaimableEffect',
      'stampEffectClaim', 'parkEffectRow', 'failEffectRow', 'retryEffectRow', 'transactionDirect', 'declarePersistence', 'readSourceMembership',
      'lockPersistenceCounters', 'insertWriteRequest'] },
    async (engine, backend) => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-doctor-parked-')));
      try {
        return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const root = join(home, 'checkout');
          await Bun.write(join(root, 'example.md'), 'generic example');
          await createSource(engine, backend, 'work', {}, root);
          for (const id of ['ab', 'a-c']) await createSource(engine, backend, id, { kind: 'notes' });
          let binding: Awaited<ReturnType<typeof claimWorktree>>;
          try { binding = await claimWorktree(engine, 'work', root); } finally { await disposePersistenceConsumer(engine); }
          // One Git effect per request. `how` is what the effect worker does with its claim.
          const SEEDS = [
            { n: 1, source: 'work', path: 'notes/pushed.md', worktree: true, how: 'park', data: { parked: [{ slug: 'notes/pushed', error_code: 'push_unconfirmed' }, { slug: 'notes/q', error_code: 'git_target_ignored', rule: 'r-1' }] } },
            { n: 2, source: 'work', path: 'notes/failed.md', worktree: true, how: 'fail', reason: 'git_push_unavailable' },
            { n: 3, source: 'work', path: 'notes/retry.md', worktree: true, how: 'retry', reason: 'integrate_conflict' },
            { n: 4, source: 'work', path: 'notes/settled.md', worktree: true, how: 'park', data: { settled: { at: '2026-01-01' }, parked: [{ slug: 'notes/s', error_code: 'push_unconfirmed' }] } },
            { n: 5, source: 'default', path: 'notes/moved.md', worktree: true, how: 'park', data: { parked: [{ slug: 'notes/m', error_code: 'held_by_rule' }] } },
            { n: 6, source: 'ab', path: 'notes/ab.md', worktree: false, how: 'fail', reason: 'push_credential_refused' },
            { n: 7, source: 'a-c', path: 'notes/ac.md', worktree: false, how: 'fail', reason: 'not_a_push_code' },
          ] as const;
          const requestOf = (n: number) => `b0000000-0000-4000-8000-0000000000d${n}`;
          for (const seed of SEEDS) {
            const incarnation = (await engine.readSourceMembership(seed.source))!.incarnation;
            const id = (await admitRow(engine, requestOf(seed.n), seed.path.replace(/\.md$/, ''), 'put_page', {}, seed.source)).id;
            await engine.transactionDirect(async tx => {
              await tx.declarePersistence();
              await tx.insertPublicationEffects({ requestId: id, revision: null, sourceId: seed.source, sourceIncarnation: incarnation,
                worktreeId: seed.worktree ? binding.worktree_id : null, effects: [{ kind: 'git', data: { relative_path: seed.path } }] });
            });
          }
          type Claimed = { id: string | number; execution_token: string; data: { relative_path?: string } };
          for (let n = 1; n <= SEEDS.length; n++) {
            const row = await engine.transactionDirect(async tx => {
              await tx.declarePersistence();
              const candidate = await tx.selectClaimableEffect<Claimed>(binding.owner_host_id!, []);
              const token = `f0000000-0000-4000-8000-00000000001${n}`;
              return tx.stampEffectClaim<Claimed>({ id: candidate!.id, token, ownerJson: JSON.stringify({ token }) });
            });
            const ref = { id: row!.id, token: row!.execution_token };
            const seed = SEEDS.find(s => s.path === row!.data.relative_path)!;
            if (seed.how === 'park') await engine.parkEffectRow({ ...ref, dataJson: JSON.stringify({ relative_path: seed.path, ...seed.data }) });
            else if (seed.how === 'fail') await engine.failEffectRow({ ...ref, reason: seed.reason });
            else await engine.retryEffectRow({ ...ref, reason: seed.reason, delayMs: 3_600_000 });
          }
          const codes = ['git_push_unavailable', 'push_unconfirmed', 'integrate_conflict', 'publish_secret_found', 'publish_scan_unreadable', 'push_credential_refused'];
          const parked = (await engine.listParkedEffects(null)).map(({ request, ...row }) => ({ request: request.request_id, slug: request.slug, ...row }));
          const holds = (await engine.listGitPushHoldRows(codes, null)).map(row => ({ ...row, root: row.root === null ? null : row.root.split(home).join('$HOME'),
            oldest_at: new Date(row.oldest_at).getTime() > 0 }));
          const answers = {
            count: await engine.countParkedEffects(null), countScoped: await engine.countParkedEffects(['default', 'ab']),
            parked, parkedScoped: (await engine.listParkedEffects(['default'])).map(r => r.request.request_id),
            holds, holdsScoped: (await engine.listGitPushHoldRows(codes, ['ab'])).map(r => r.source_id),
          };
          expect(answers.count).toBe(2);
          expect(answers.countScoped).toBe(1);
          expect(answers.parked).toEqual([
            { request: requestOf(1), slug: 'notes/pushed', source_id: 'work', kind: 'git', state: 'failed', former_binding: false,
              parked: [{ slug: 'notes/pushed', error_code: 'push_unconfirmed' }, { slug: 'notes/q', error_code: 'git_target_ignored', rule: 'r-1' }] },
            { request: requestOf(5), slug: 'notes/moved', source_id: 'default', kind: 'git', state: 'failed', former_binding: true,
              parked: [{ slug: 'notes/m', error_code: 'held_by_rule' }] }]);
          expect(answers.parkedScoped).toEqual([requestOf(5)]);
          expect(answers.holds).toEqual([
            { source_id: 'ab', root: null, former_worktree: true, retrying: 0, parked: 1, codes: ['push_credential_refused'], oldest_at: true },
            { source_id: 'work', root: '$HOME/checkout', former_worktree: false, retrying: 1, parked: 2,
              codes: ['git_push_unavailable', 'integrate_conflict', 'push_unconfirmed'], oldest_at: true }]);
          expect(answers.holdsScoped).toEqual(['ab']);
          return answers;
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    },
  );

  parityTest(
    'every read answers its empty state on a brain with no request',
    { methods: [
      'listCapacityCounters', 'listLifetimeCounters', 'countPersistenceRequestRows', 'readAdmissionSample', 'listOutstandingHolders',
      'listRunningRequestStalls', 'readMaxRequestSequence', 'listRecentDriftReceiptSlugs', 'listOlderDriftReceiptSlugs',
      'listRefusalBreakerRows', 'readCounterDrift', 'readPublicationRefusals', 'listRunningClaimOwners', 'listLocalEditAdoptions',
      'listCallerRefusalRows', 'countCompactedCallerRefusals', 'listRecentWriterVersions', 'readLiveConsumerSummary',
      'countParkedEffects', 'listParkedEffects', 'listGitPushHoldRows', 'listStalledCatchupRows', 'listParkedGroupRows',
      'readStaleEmbeddingCounts', 'listStaleEmbeddingEffects', 'listOrphanBindingRows', 'listWorktreeIds',
      'listSourceBindingsForMovement', 'listOwnerBindings', 'listConsumerOwners', 'listStuckWorktreeRefreshes',
      'listRecentPurgeRequests', 'listDerivationPurgeSweeps', 'listUnboundSourcePages', 'listOverwriteCandidates',
      'readPersistenceBrainIdText', 'listManagedRoots'] },
    async (engine) => {
      const answers = {
        capacity: await engine.listCapacityCounters(),
        lifetime: await engine.listLifetimeCounters(),
        rows: await engine.countPersistenceRequestRows(false),
        sample: await engine.readAdmissionSample(null),
        sampleOf: await engine.readAdmissionSample([...PRINCIPAL]),
        holders: await engine.listOutstandingHolders(null),
        stalls: await engine.listRunningRequestStalls(600_000),
        max: await engine.readMaxRequestSequence(),
        recent: await engine.listRecentDriftReceiptSlugs('default', '0', DRIFT_MESSAGE),
        older: await engine.listOlderDriftReceiptSlugs('default', '0', DRIFT_MESSAGE, 5000),
        breaker: await engine.listRefusalBreakerRows('default', 24, 1, 20),
        drift: await engine.readCounterDrift('persistence.true_up.clamped'),
        publication: await engine.readPublicationRefusals(),
        owners: await engine.listRunningClaimOwners('e0000000-0000-4000-8000-0000000000e1'),
        adoptions: await engine.listLocalEditAdoptions(),
        refusals: await engine.listCallerRefusalRows(nulls, OPS),
        compacted: await engine.countCompactedCallerRefusals(nulls, OPS),
        versions: await engine.listRecentWriterVersions(7),
        consumers: await engine.readLiveConsumerSummary(),
        parked: await engine.countParkedEffects(null),
        parkedRows: await engine.listParkedEffects(null),
        orphans: await engine.listOrphanBindingRows(1001),
        worktrees: await engine.listWorktreeIds(),
        gitHolds: await engine.listGitPushHoldRows(['git_push_held'], null),
        catchup: await engine.listStalledCatchupRows(null, 600_000),
        groups: await engine.listParkedGroupRows(null),
        staleCounts: await engine.readStaleEmbeddingCounts(null),
        staleEffects: await engine.listStaleEmbeddingEffects(['default']),
        movement: await engine.listSourceBindingsForMovement(null),
        ownerBindings: await engine.listOwnerBindings('e0000000-0000-4000-8000-0000000000e1'),
        consumerOwners: await engine.listConsumerOwners(['e0000000-0000-4000-8000-0000000000e1']),
        stuck: await engine.listStuckWorktreeRefreshes(30),
        purges: await engine.listRecentPurgeRequests(7, 20),
        sweeps: await engine.listDerivationPurgeSweeps(),
        unbound: await engine.listUnboundSourcePages(),
        candidates: await engine.listOverwriteCandidates('default', null, 20),
        roots: await engine.listManagedRoots('e0000000-0000-4000-8000-0000000000e1'),
        brainIdIsText: typeof (await engine.readPersistenceBrainIdText()) !== 'number',
      };
      expect(answers.capacity).toEqual([]);
      expect(answers.rows).toEqual({ rows: '0' });
      expect(answers.sample).toEqual({ admissions: 0, oldest: null });
      expect(answers.max).toBeNull();
      expect(answers.consumers).toEqual({ live: '0', oldest_hours: null });
      expect(answers.parked).toBe(0);
      expect(answers.staleCounts).toEqual({ count: 0, failed: 0, requeued: 0 });
      return answers;
    },
  );

  parityTest(
    'the request journal reads count the admissions, the outstanding slots and the running claims',
    { methods: ['lockPersistenceCounters', 'readSourceMembership', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow',
      'listCapacityCounters', 'listLifetimeCounters', 'countPersistenceRequestRows', 'readAdmissionSample', 'listOutstandingHolders',
      'listRunningRequestStalls', 'readMaxRequestSequence', 'listRunningClaimOwners'] },
    async (engine) => {
      const first = await admit(engine, REQ_1, 'notes/a', 'put_page');
      const second = await admit(engine, REQ_2, 'notes/b', 'put_page');
      const queued = {
        rows: await engine.countPersistenceRequestRows(false),
        counters: counted(await engine.listCapacityCounters()),
        lifetime: counted(await engine.listLifetimeCounters()),
        holders: (await engine.listOutstandingHolders(null)).map(h => ({ source: h.source_id, n: Number(h.n), stalled: Number(h.stalled) })),
        holdersOther: await engine.listOutstandingHolders(['local_cli', 'other']),
        admissions: (await engine.readAdmissionSample([...PRINCIPAL]))?.admissions,
        admissionsOther: (await engine.readAdmissionSample(['local_cli', 'other']))?.admissions,
        oldestIsStamp: typeof (await engine.readAdmissionSample(null))?.oldest === 'string',
        maxIsText: typeof await engine.readMaxRequestSequence() === 'string',
      };
      expect(queued.rows).toEqual({ rows: '2' });
      expect(queued.holders).toEqual([{ source: 'default', n: 2, stalled: 0 }]);

      await engine.stampWriteClaim(first, TOKEN, 60_000, JSON.stringify({ phase: 'claimed', owner: { pid: 7 } }));
      const running = (await engine.listRunningRequestStalls(600_000)).map(r => ({
        request: r.request_id, source: r.source_id, worktree: r.worktree_id, operation: r.operation, intent: r.intent_kind, state: r.state,
        lapsed: r.claim_lapsed, started: r.publication_started, noProgress: r.no_root_progress, waiting: Number(r.waiting),
        ageIsNumber: Number.isFinite(Number(r.request_age_ms)),
      }));
      const owners = (await engine.listRunningClaimOwners('e0000000-0000-4000-8000-0000000000e1')).length;
      await settle(engine, second, 'committed', { outcome: { slug: 'notes/b' } });
      const afterProgress = (await engine.listRunningRequestStalls(600_000)).map(r => r.no_root_progress);
      const held = (await engine.listOutstandingHolders(null)).map(h => Number(h.n));
      expect(running.length).toBe(1);
      return { queued, running, owners, afterProgress, held };
    },
  );

  parityTest(
    'the refusal reads separate the database guard, drift receipts and refused caller writes',
    { methods: ['lockPersistenceCounters', 'readSourceMembership', 'insertWriteRequest', 'completeWriteRow', 'readPublicationRefusals',
      'listCallerRefusalRows', 'countCompactedCallerRefusals', 'listRecentDriftReceiptSlugs', 'listOlderDriftReceiptSlugs',
      'listRefusalBreakerRows', 'listLocalEditAdoptions', 'listRecentWriterVersions', 'readMaxRequestSequence'] },
    async (engine) => {
      // Sequences run on across cases on a shared database: read them from the first row this case admits.
      const first = await admitRow(engine, REQ_1, 'notes/a', 'put_page', { expected_revision: 'r1' });
      const guarded = first.id;
      const base = Number(first.sequence) - 1;
      await settle(engine, guarded, 'failed', { code: 'writer_coordinator_required', message: 'the writer guard refused it', detail: { origin: 'database_guard' } });
      const drift = await admit(engine, REQ_2, 'notes/b', 'remember');
      await settle(engine, drift, 'conflict', { code: 'source_changed', message: DRIFT_MESSAGE });
      const adopted = await admit(engine, 'b0000000-0000-4000-8000-0000000000b3', 'notes/c', 'put_page');
      await settle(engine, adopted, 'committed', { outcome: { slug: 'notes/c', adopted_local_edit: { path: 'c.md' } } });

      const refusals = (await engine.listCallerRefusalRows(nulls, OPS)).map(r => ({
        operation: r.operation, slug: r.slug, reason: r.reason, unpinned: r.unpinned, stale: r.stale_revision, sequence: Number(r.sequence) - base,
      }));
      const answers = {
        publication: await engine.readPublicationRefusals(),
        refusals,
        refusalsOfOne: (await engine.listCallerRefusalRows(nulls, ['remember'])).length,
        elsewhere: await engine.listCallerRefusalRows(['other'], OPS),
        compacted: await engine.countCompactedCallerRefusals(nulls, OPS),
        floor: Number(await engine.readMaxRequestSequence()) - base,
        recent: await engine.listRecentDriftReceiptSlugs('default', String(base), DRIFT_MESSAGE),
        recentAfter: await engine.listRecentDriftReceiptSlugs('default', String(base + 3), DRIFT_MESSAGE),
        older: await engine.listOlderDriftReceiptSlugs('default', String(base + 3), DRIFT_MESSAGE, 5000),
        otherMessage: await engine.listRecentDriftReceiptSlugs('default', String(base), 'another message'),
        breaker: (await engine.listRefusalBreakerRows('default', 24, 1, 20)).map(r => ({ slug: r.slug, refusals: Number(r.refusals) })),
        adoptions: await engine.listLocalEditAdoptions(),
        // Sorted by role: the read orders by last_seen DESC, and the admitter and consumer rows of one request can share
        // a timestamp, so their order is a tie the engines may break either way.
        versions: (await engine.listRecentWriterVersions(7)).map(v => ({ role: v.role, version: v.version, requests: Number(v.requests) }))
          .sort((a, b) => a.role.localeCompare(b.role)),
      };
      expect(answers.recent).toEqual([{ slug: 'notes/b', total: 1 }]);
      return answers;
    },
  );

  parityTest(
    'readCounterDrift counts the receipts of each counter',
    { methods: ['lockPersistenceCounters', 'readSourceMembership', 'insertWriteRequest', 'completeWriteRow', 'readCounterDrift'] },
    async (engine) => {
      const id = await admit(engine, REQ_1, 'notes/a', 'put_page');
      await settle(engine, id, 'committed', { outcome: { slug: 'notes/a' } });
      const rows = (await engine.readCounterDrift('persistence.true_up.clamped')).map(r => ({
        key: r.key, requests: Number(r.req_rows), bytes: Number(r.req_bytes), topology: Number(r.topo_rows), topologyBytes: Number(r.topo_bytes),
      }));
      expect(rows.map(r => r.key).sort()).toEqual(['brain', KEY]);
      return rows;
    },
  );
});
