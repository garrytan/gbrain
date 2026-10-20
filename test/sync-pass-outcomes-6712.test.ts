/**
 * #6712 PR 4b lane A, probe 52: the outcome golden for each row of design v3.2 §9, direct and delegated through a job.
 *
 * Protects: each live-pass stop (not_converged below and at the 3-pass streak, the selection-scoped synced pass, grant_scope,
 * reconcile_host_required, reconcile_read_incomplete, admission_paused) drains to its §9 outcome, exit (1 only when
 * blocked), job disposition and follow-up, and its exact JSON (outcome, drain, next with its rendered fix) on the CLI and in
 * a durable sync job's result. A change to any row's wire shape fails the golden
 * (test/fixtures/goldens/sync/pass-outcomes.json, GBRAIN_TEST_UPDATE_GOLDENS=1 regenerates it deliberately).
 *
 * Fails on capy/6712-pr4b (8cda2764b): there every one of these stops drains as resumable / deadline (or blocked /
 * blocked_by_failures) with the deadline's or the failed page's next step.
 */
import { describe, expect, test } from 'bun:test';
import type { SyncResult } from '../src/commands/sync.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { drainJsonFields, jobDisposition, runDrain, syncOutcome, type JobDisposition } from '../src/core/persistence/sync-drain.ts';
import { settleJobDrain } from '../src/core/minions/handlers/sync-job-drain.ts';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';

const RESUME = 'gbrain sync --source default --no-pull';
const passResult = (status: SyncResult['status'], reason: SyncResult['reason'] | undefined, streak = 0): SyncResult => ({ status, fromCommit: 'a', toCommit: 'b',
  added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], filesImported: 0, bankedFiles: 0, ...(reason ? { reason } : {}),
  pass: { pass_id: '00000000-0000-4000-8000-000000006712', kind: 'full', round: 4, outcome: status === 'synced' ? 'synced' : 'resumable', stop_reason: reason ?? null,
    candidates: 2, settled: 1, remaining: 1, not_converged_streak: streak } });

/** The §9 table: result, then the outcome, exit, next.fix.next, safe_to_loop, job disposition and follow-up it must drain to. */
const ROWS: Array<{ row: string; result: SyncResult; outcome: string; exit: 0 | 1; next: string | null; loop: boolean | null; job: JobDisposition; followUp: string }> = [
  { row: 'not_converged (stop)', result: passResult('partial', 'not_converged', 1), outcome: 'resumable', exit: 0, next: 'run', loop: true, job: 'continue', followUp: 'the next tick' },
  { row: 'not_converged after a 3-pass streak', result: passResult('partial', 'not_converged', 3), outcome: 'resumable', exit: 0, next: 'report', loop: false, job: 'needs_operator', followUp: 'none' },
  { row: 'scoped pass converged (selection_scoped)', result: passResult('synced', 'selection_scoped'), outcome: 'synced', exit: 0, next: null, loop: null, job: 'synced', followUp: 'none' },
  { row: 'grant_scope (stop)', result: passResult('blocked_by_failures', 'grant_scope'), outcome: 'blocked', exit: 1, next: 'tell_user_to_run', loop: false, job: 'needs_operator', followUp: 'none' },
  { row: 'reconcile_host_required (stop)', result: passResult('blocked_by_failures', 'reconcile_host_required'), outcome: 'blocked', exit: 1, next: 'tell_user_to_run', loop: false, job: 'needs_operator', followUp: 'none' },
  { row: 'reconcile_read_incomplete (stop)', result: passResult('blocked_by_failures', 'reconcile_read_incomplete'), outcome: 'blocked', exit: 1, next: 'report', loop: false, job: 'needs_operator', followUp: 'none' },
  { row: 'admission_paused (stop)', result: passResult('partial', 'admission_paused'), outcome: 'resumable', exit: 0, next: 'tell_user_to_run', loop: false, job: 'needs_operator', followUp: 'none' },
];

const job = { id: 6712, data: { sourceId: 'default' }, signal: new AbortController().signal, updateProgress: async () => undefined } as unknown as MinionJobContext;
const plan = { opts: { drain: true }, row: null, trusted: true } as never;
const normalizer = defineNormalizer<unknown>('sync-pass-outcomes-v1', value => value);

describe('#6712 PR 4b probe 52: the §9 outcome golden', () => {
  test('each row drains to its outcome, exit, next, loop, job disposition and follow-up, direct and delegated', async () => {
    const golden: Record<string, unknown> = {};
    for (const spec of ROWS) {
      const drained = await runDrain({ pass: async () => spec.result });
      const direct = drainJsonFields(drained, RESUME, 'default') as { outcome: string; next?: { safe_to_loop: boolean; fix?: { next: string } } };
      const delegated = await settleJobDrain({} as BrainEngine, job, drained, 'default', plan) as { outcome?: string; incomplete?: boolean; continuation_job_id?: number | null; next?: unknown };
      const exit = syncOutcome(drained) === 'blocked' ? 1 : 0;
      expect({ row: spec.row, outcome: direct.outcome, exit, next: direct.next ? direct.next.fix?.next ?? null : null, loop: direct.next ? direct.next.safe_to_loop : null,
        job: jobDisposition(drained, 'default'), followUp: delegated.continuation_job_id ? 'continuation job' : spec.job === 'continue' ? 'the next tick' : 'none' })
        .toEqual({ row: spec.row, outcome: spec.outcome, exit: spec.exit, next: spec.next, loop: spec.loop, job: spec.job, followUp: spec.followUp });
      expect(delegated.outcome).toBe(spec.outcome);
      expect(delegated.incomplete).toBe(spec.job !== 'synced');
      golden[spec.row] = { direct, delegated, exit, job: jobDisposition(drained, 'default') };
    }
    expectGolden('sync/pass-outcomes', golden, normalizer);
  });
});
