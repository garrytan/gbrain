/**
 * #8155 for the typed decide reads the doctor bounds (src/core/statement-deadline.ts `BOUNDED_TYPED_READS`).  This case also covers the timeline, notifier and writer-binding reads.
 * On master the doctor read these tables through `executeRaw` on the deadline-bound engine, which passed an
 * `AbortSignal.timeout(left)`: a socket or pooler that stopped answering after the connection was reserved had the
 * connection discarded at the deadline, so the call ended and no pool slot leaked. The moved members run through
 * `runDeadlineRead` (postgres-engine/bounded-statement.ts), which only takes that path when it is handed a signal.
 *
 * Protects: each bounded decide member, called under the doctor's deadline on a connection that never answers, rejects
 * with a deadline failure by the deadline, marks the scope expired, discards (does not release) its reserved
 * connection, and returns its gauge slot.
 * Fails when `deadlineBoundEngine` runs a bounded typed read without the deadline's abort signal.
 * No database: the engine runs on the recording fake, as test/typed-preparation-read-abort.test.ts does.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { BOUNDED_TYPED_READS, deadlineBoundEngine, deadlineFailure, withStatementDeadline, type StatementDeadline } from '../src/core/statement-deadline.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const never = () => new Promise<never>(() => {});
const DEADLINE_MS = 150;
/** Well under any wait the stalled read could end on its own, well over the timer's slack. */
const SETTLE_MS = 1_000;

/** The decide, queue-health, belief-coverage and source-resolution members a doctor check calls, as test/doctor-typed-reads-deadline.test.ts lists them. */
const CALLS: Record<string, (engine: BrainEngine) => Promise<unknown>> = {
  readDecideState: (e) => e.readDecideState('doctor_deadline_probe'),
  decideSlotUsage: (e) => e.decideSlotUsage(24),
  dailyDecideSpend: (e) => e.dailyDecideSpend(new Date(Date.now() - 86_400_000)),
  listDecideResolvedModels: (e) => e.listDecideResolvedModels(24),
  listDecideMixedModelDecisions: (e) => e.listDecideMixedModelDecisions(24),
  listDecideReceiptStats: (e) => e.listDecideReceiptStats({ sinceHours: 24 }),
  listDecideCalibrations: (e) => e.listDecideCalibrations({ includeRetired: true }),
  readQueueHealthSignals: (e) => e.readQueueHealthSignals({ waitingThreshold: 1, oldWaitingHours: 1, windowHours: 24, stalledAfterHours: 1 }),
  listWaitingByQueue: (e) => e.listWaitingByQueue(),
  readQueueDivergence: (e) => e.readQueueDivergence({ windowHours: 24, ttlReasonPrefix: 'ttl:' }),
  listQueueWedgeCounts: (e) => e.listQueueWedgeCounts(),
  listPrivateQueueHealth: (e) => e.listPrivateQueueHealth(),
  readWedgeSignals: (e) => e.readWedgeSignals('default', ['sync']),
  readOldestWaitingAge: (e) => e.readOldestWaitingAge('default'),
  listStuckActiveJobsByName: (e) => e.listStuckActiveJobsByName(),
  listCoveredSources: (e) => e.listCoveredSources('doctor_deadline_probe'),
  listExportWithdrawals: (e) => e.listExportWithdrawals('default'),
  readExportWithdrawalLedgerBytes: (e) => e.readExportWithdrawalLedgerBytes('default'),
  // The timeline-history, notifier-coverage and writer-binding reads (S2b-ns).
  readMaxTimelineEntryId: (e) => e.readMaxTimelineEntryId(),
  storedTimelineRowsByPageIds: (e) => e.storedTimelineRowsByPageIds([1, 2]),
  countSegmentedTimelinePages: (e) => e.countSegmentedTimelinePages(['default'], 10),
  hasNotifierCoverage: (e) => e.hasNotifierCoverage(),
  getWorktreeBinding: (e) => e.getWorktreeBinding('default', null),
  // The source reads source resolution makes inside a doctor check (part A).
  listLocalPathSources: (e) => e.listLocalPathSources(),
  listSourceRoutingRows: (e) => e.listSourceRoutingRows(),
  countDefaultSourceSplit: (e) => e.countDefaultSourceSplit(),
  readSourceRow: (e) => e.readSourceRow('default'),
  listActiveSourceConfigs: (e) => e.listActiveSourceConfigs(),
  listSourceRecords: (e) => e.listSourceRecords(),
};

test('every bounded typed read has a stall case', () => {
  expect(Object.keys(CALLS).sort()).toEqual([...BOUNDED_TYPED_READS].sort());
});

for (const [member, call] of Object.entries(CALLS)) {
  test(`${member} stalled on its connection under the doctor deadline ends by the deadline and gives back its connection and gauge slot`, async () => {
    const counts = { discards: 0, releases: 0 };
    const fake = makeFakeSql(stmt => (/decide_|decision_receipts|minion_jobs|belief_events|fact_withdrawals|timeline_entries|worktree|notifier|FROM sources|FROM pages/i.test(stmt.text) ? never() : undefined));
    const reserve = fake.sql.reserve;
    fake.sql.reserve = async () => {
      const r = await reserve();
      r.discard = () => { counts.discards++; };
      const release = r.release;
      r.release = () => { counts.releases++; release(); };
      return r;
    };
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = fake.sql;
    const scope: StatementDeadline = { startedAt: Date.now(), deadlineAt: Date.now() + DEADLINE_MS, expired: false };
    const bound = deadlineBoundEngine(engine as unknown as BrainEngine);
    const outcome = await Promise.race([
      withStatementDeadline(scope, async () => call(bound)).then(() => 'resolved', (error: unknown) => error),
      Bun.sleep(DEADLINE_MS + SETTLE_MS).then(() => 'still pending'),
    ]);
    expect(outcome, `${member} did not end by the deadline`).not.toBe('still pending');
    expect(outcome).not.toBe('resolved');
    expect(deadlineFailure(outcome), String(outcome)).toBe(true);
    expect(scope.expired).toBe(true);
    expect(counts).toEqual({ discards: 1, releases: 0 });
    expect((engine as unknown as { checkoutGauge: { snapshot(): Record<string, number> } }).checkoutGauge.snapshot().reserved).toBe(0);
  }, 10_000);
}
