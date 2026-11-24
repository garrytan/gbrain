/**
 * BrainEngine parity: the doctor persistence reads of engine-sql/doctor-persistence.ts, which the persistence doctor
 * checks and the helpers under src/core/persistence/ used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so each persistence doctor check reads the same finding on each.
 *    The members the Rust store has no writer for answer the empty state, which is what the other arms answer on a brain
 *    with no such row.
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

async function admitRow(engine: BrainEngine, requestId: string, slug: string, operation: string, intent: Record<string, unknown> = {}): Promise<{ id: string; sequence: string | number }> {
  const source = await engine.readSourceMembership('default');
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: PRINCIPAL[0], principalId: PRINCIPAL[1], requestId, operation, sourceId: 'default',
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
