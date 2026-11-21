/**
 * BrainEngine parity — the minion job counts and last-run reads of the status surfaces (engine-sql/jobs-status.ts):
 * `gbrain status` and its snapshot, `gbrain jobs stats`, the facts drain backlog and its cost estimate, and the source
 * health and sync status per-source counts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with no job, each of the eleven reads answers the same value on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): no last run, no count, no
 *    queue, no completion time, a scope with nothing waiting and no live job, no average, and no source.
 *  - Regression: an engine that answers an empty queue with a different shape (null for a list, a zero-row for a count,
 *    a string for a number, a missing field) breaks the status, jobs stats, drain and source health callers, which read
 *    these answers as typed values.
 *  - Why existing coverage misses it: these reads ran as raw SQL at their call sites (status.ts, jobs/stats.ts,
 *    facts/drain.ts, source-health.ts, sync-status-report.ts), which the Rust engine refuses, and their unit tests run
 *    on PGLite only.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). This base has no typed job writer (the queue's
 *    admit, claim and complete members belong to a later cut), so a seeded queue cannot be built on the Rust arm. The
 *    populated cases run on the SQL arms in test/n5-sql-move-parity.test.ts, which compares each member with the
 *    statement it replaced; the Rust store answers them in rust/crates/gbrain-store/tests/jobs_status.rs.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('engine parity: minion status reads', () => {
  parityTest('every status read answers an empty queue the same way',
    {
      methods: ['readLastAutopilotCycles', 'countJobsByStatus', 'readWaitingQueueDepths', 'readLastCompletedJobAt', 'countTtlCancelledByName',
        'readWaitingScopeState', 'countRecentCompletedJobs', 'listRecentFailedJobErrors', 'readQueuedPageChars', 'readSourceJobCounts',
        'readEmbedBackfillBySource'],
    }, async (engine) => {
      const out = {
        cycles: await engine.readLastAutopilotCycles(),
        byStatus: await engine.countJobsByStatus(),
        byFilter: await engine.countJobsByStatus({ name: 'facts-absorb', queue: 'default', statuses: ['waiting', 'delayed', 'active'] }),
        noStatuses: await engine.countJobsByStatus({ statuses: [] }),
        depths: await engine.readWaitingQueueDepths(),
        lastCompleted: await engine.readLastCompletedJobAt(),
        ttl: await engine.countTtlCancelledByName('waiting_ttl_expired%', 86_400),
        scope: await engine.readWaitingScopeState({ name: 'embed-backfill', queue: 'default', jobId: 1 }),
        recent: await engine.countRecentCompletedJobs('subagent', 3_600),
        failed: await engine.listRecentFailedJobErrors(86_400),
        chars: await engine.readQueuedPageChars({ name: 'facts-absorb', queue: 'default', maxChars: 4_000 }),
        sources: await engine.readSourceJobCounts(86_400),
        backfill: await engine.readEmbedBackfillBySource(['default', 'other']),
        backfillNone: await engine.readEmbedBackfillBySource([]),
      };
      expect(out.cycles).toEqual({ full: null, targeted: null });
      expect(out.byStatus).toEqual([]);
      expect(out.byFilter).toEqual([]);
      expect(out.noStatuses).toEqual([]);
      expect(out.depths).toEqual([]);
      expect(out.lastCompleted).toBeNull();
      expect(out.ttl).toEqual([]);
      expect(out.scope).toEqual({ waiting: 0, live_id: null, age_min: null });
      expect(out.recent).toBe(0);
      expect(out.failed).toEqual([]);
      expect(out.chars).toBeNull();
      expect(out.sources).toEqual([]);
      expect(out.backfill).toEqual([]);
      expect(out.backfillNone).toEqual([]);
      return out;
    });
});
