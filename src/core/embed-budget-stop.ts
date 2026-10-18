/**
 * The loud stop for `gbrain embed --stale` at its wall-clock budget
 * (`GBRAIN_EMBED_TIME_BUDGET_MS`, default 30 min). A budget stop that leaves
 * stale chunks behind is a partial run: the result records the reason, the
 * remaining count and the exact command that finishes the backlog, and the
 * CLI prints that verdict on stdout and exits with BUDGET_STOP_EXIT_CODE
 * instead of reading as a clean finish.
 */
import type { BrainEngine } from './engine.ts';

export interface EmbedBudgetStopFields {
  embedded: number;
  reason?: 'stall_timeout' | 'time_budget' | 'cost_cap';
  remaining_stale?: number;
  resume_command?: string;
}

/**
 * Record a budget stop on `result` when stale chunks remain; a drained run
 * records nothing. `skip` covers dry runs, catch-up (no budget) and caller
 * aborts, which are not budget stops.
 */
export async function noteEmbedBudgetStop(
  engine: BrainEngine,
  result: EmbedBudgetStopFields,
  opts: { sourceId?: string; signature?: string; includeNullSignature: boolean; skip: boolean },
): Promise<void> {
  if (opts.skip) return;
  const sourceOpt = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  const remaining = await engine.countStaleChunks(opts.signature
    ? { signature: opts.signature, ...sourceOpt, ...(opts.includeNullSignature && { includeNullSignature: true }) }
    : sourceOpt);
  if (remaining === 0) return;
  result.reason = 'time_budget';
  result.remaining_stale = remaining;
  result.resume_command = ['gbrain embed --stale --catch-up', opts.sourceId && `--source ${opts.sourceId}`,
    opts.includeNullSignature && '--include-null-signature'].filter(Boolean).join(' ');
}

/** The stdout verdict line for a budget stop. */
export function embedBudgetStopVerdict(result: EmbedBudgetStopFields): string {
  return `[embed] stopped (reason: time_budget): the --stale run reached its time budget (GBRAIN_EMBED_TIME_BUDGET_MS, default 30 min) ` +
    `with ${result.remaining_stale} stale chunk(s) left after embedding ${result.embedded} this run. ` +
    `Finish without a time cap: ${result.resume_command} (paid embedding calls for the remaining chunks), ` +
    'or rerun gbrain embed --stale for another budget window; either resumes where this run stopped.';
}
