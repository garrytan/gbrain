/**
 * #7108: what to tell the user about a recorded migration timeout
 * (migration-timeout.ts), as one sentence and the fix. apply-migrations
 * (`migrations_pending`, reason `still_behind`) and doctor `schema_version`
 * both use it.
 *
 * A lock wait stops at the schema lock timeout (`schema_lock_blocked`) long
 * before the 10-minute budget, so a timeout means the migration's own work took
 * that long. Three cases:
 * - The run had no prelude for the migration and this release has one: rerun.
 * - Idle-in-transaction sessions were open: they may hold locks the work
 *   waited on row by row. They were sampled once and may be gone or unrelated,
 *   so the user checks them with doctor --locks, and only after agreeing ends
 *   the ones still open, then reruns.
 * - None were seen: a plain rerun fails the same way, so once the user agrees,
 *   one run with a longer budget (its table locks are held that long).
 */
import type { Action } from './agent-output.ts';
import type { MigrationTimeoutRecord } from './migration-timeout.ts';
import { MIGRATION_PRELUDES } from './migration-preludes.ts';

/** The one-run budget offered when a migration times out with no idle session seen. */
const LONG_BUDGET_MINUTES = 120;

export function migrationTimeoutAdvice(record: MigrationTimeoutRecord, verify: { argv: string[] }): { message: string; fix: Action } {
  const which = `Migration v${record.version} (${record.name})`;
  const rerun = ['gbrain', 'apply-migrations', '--yes'];
  if (!record.batched && MIGRATION_PRELUDES.has(record.version)) {
    return {
      message: `${which} ran out of its statement budget in one transaction; this version runs its backfill in committed batches first, so run foresights apply-migrations --yes.`,
      fix: { argv: rerun, consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `This release backfills v${record.version} in committed batches before the migration (#7108), so no statement grows with the table; an interrupted run keeps its batches.` },
    };
  }
  if (record.idle_pids.length > 0) {
    const pids = record.idle_pids.join(', ');
    return {
      message: `${which} ran out of its statement budget while idle-in-transaction session(s) ${pids} were open; they may hold locks on its table. Check them with foresights doctor --locks, end the ones still open once the user agrees, then run foresights apply-migrations --yes.`,
      fix: { ask_user: true, argv: rerun, consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `Session(s) ${pids} were idle in a transaction for over five minutes when v${record.version} timed out; a session holding a lock on its table would make the work wait. They were sampled then and may be gone or unrelated now.`,
        user_message: `Migration v${record.version} timed out while database session(s) ${pids} were idle in an open transaction. Run gbrain doctor --locks to see whether they are still open. With your agreement, end the ones that are on the database host (SELECT pg_terminate_backend(<pid>)), then run gbrain apply-migrations --yes. Go ahead?` },
    };
  }
  return {
    message: `${which} used its whole statement budget on every attempt with no idle session open, so a plain rerun repeats the failure; once the user agrees, rerun it with a longer budget.`,
    fix: { ask_user: true, argv: [...rerun, '--statement-timeout', String(LONG_BUDGET_MINUTES)], consent: [], actor: 'agent', requires_exclusive: true, verify,
      why: `A lock wait would have stopped at the schema lock timeout instead, so v${record.version}'s own work outlasts the default budget on this brain; the same release fails the same way unless the budget is raised for one run.`,
      user_message: `Migration v${record.version} (${record.name}) times out on this brain on every attempt, and no database session was blocking it. A plain rerun fails the same way. It can run once with a ${LONG_BUDGET_MINUTES}-minute budget (foresights apply-migrations --yes --statement-timeout ${LONG_BUDGET_MINUTES}); while it runs, writes to the table it changes wait. Please also report it at https://github.com/aimonk2025/gbrain/issues with the output of foresights doctor --json. Run it now?` },
  };
}
