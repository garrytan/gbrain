/**
 * `facts_drain` cycle phase (Lane D): one bounded run of the automatic facts
 * drain (src/core/facts/drain.ts) inside the cycle, so a PGLite brain run by
 * autopilot or `gbrain dream` extracts queued `facts-absorb` jobs without
 * `gbrain jobs work`. Postgres brains have a job worker and skip the phase.
 * The phase never fails the cycle: deferrals (no key, budget) report `warn`
 * with the fix; an internal error reports `warn` with the doctor command.
 *
 * C-9: on every engine the phase first re-submits dead page-write facts-absorb jobs whose provider or config cause
 * has cleared (src/core/facts/dead-absorb-retry.ts), so on PGLite the drain below runs them in the same pass.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { FACTS_DRAIN_DEFERRALS, FACTS_DRAIN_WALL_MS, runFactsDrain } from '../facts/drain.ts';
import { CYCLE_DEADLINE_RESERVE_MS } from './base-phase.ts';
import { retryDeadFactsAbsorb, type DeadAbsorbRetryResult } from '../facts/dead-absorb-retry.ts';

export async function runPhaseFactsDrain(engine: BrainEngine | null, opts: { dryRun: boolean; signal?: AbortSignal; deadlineAtMs?: number | null }): Promise<PhaseResult> {
  const base = { phase: 'facts_drain' as const, duration_ms: 0 };
  if (!engine) return { ...base, status: 'skipped', summary: 'no database connected', details: { reason: 'no_database' } };
  const deadRetry = await retryDeadFactsAbsorb(engine, { dryRun: opts.dryRun }).catch((e: unknown): DeadAbsorbRetryResult & { error: string } => ({
    max_resubmits: 0, pending: 0, resubmitted: 0, exhausted: [], cleared: 0, not_retryable: [], error: e instanceof Error ? e.message : String(e) }));
  const retryNote = deadRetrySummary(deadRetry);
  const dead_retry = { resubmitted: deadRetry.resubmitted, pending: deadRetry.pending, exhausted: deadRetry.exhausted.length, not_retryable: deadRetry.not_retryable.length,
    ...(deadRetry.waiting_on ? { waiting_on: deadRetry.waiting_on } : {}), ...('error' in deadRetry ? { error: deadRetry.error } : {}) };
  const retryWarn = deadRetry.exhausted.length > 0 || 'error' in deadRetry;
  if (engine.kind !== 'pglite') {
    return { ...base, status: retryWarn ? 'warn' : 'skipped', summary: `Postgres brains run facts-absorb jobs on the job worker${retryNote}`, details: { reason: 'not_applicable', dead_retry } };
  }
  if (opts.dryRun) return { ...base, status: 'skipped', summary: `dry run: no facts extracted${retryNote}`, details: { reason: 'dry_run', dead_retry } };
  const remaining = opts.deadlineAtMs != null ? opts.deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - Date.now() : FACTS_DRAIN_WALL_MS;
  if (remaining <= 0) return { ...base, status: 'skipped', summary: 'no cycle time left for the facts drain', details: { reason: 'deadline' } };
  const r = await runFactsDrain(engine, { owner: 'cycle', signal: opts.signal, wallClockMs: Math.min(FACTS_DRAIN_WALL_MS, remaining) });
  const details: Record<string, unknown> = {
    outcome: r.outcome, completed: r.completed, failed: r.failed, deferred: r.deferred, facts_inserted: r.facts_inserted,
    spent_usd: r.spent_usd, unpriced_calls: r.unpriced_calls, backlog_before: r.backlog_before, backlog_after: r.backlog_after, model: r.model,
    ...(r.error ? { code: r.error.code, reason: r.error.reason, fix: r.error.fix } : {}),
    dead_retry,
  };
  if (r.outcome === 'disabled') return { ...base, status: 'skipped', summary: 'facts extraction is off (facts.extraction_enabled false)', details };
  if (r.outcome === 'idle' || r.outcome === 'not_applicable') return { ...base, status: retryWarn ? 'warn' : 'ok', summary: `no queued facts-absorb jobs${retryNote}`, details };
  const summary = `${r.completed} page(s) extracted (${r.facts_inserted} facts, $${r.spent_usd.toFixed(3)}), ${r.backlog_after ?? '?'} still queued` +
    (r.error ? `: ${r.error.message}` : '') + retryNote;
  return { ...base, status: FACTS_DRAIN_DEFERRALS.has(r.outcome) || r.failed > 0 || retryWarn ? 'warn' : 'ok', summary, details };
}

function deadRetrySummary(r: DeadAbsorbRetryResult & { error?: string }): string {
  const parts = [
    r.resubmitted ? `re-submitted ${r.resubmitted} dead facts-absorb job(s)` : '',
    r.exhausted.length ? `${r.exhausted.length} dead facts-absorb job(s) reached the re-submit limit (${r.max_resubmits}); see gbrain facts retry-dead --list` : '',
    r.error ? `dead facts-absorb retry failed: ${r.error}` : '',
  ].filter(Boolean);
  return parts.length ? `; ${parts.join('; ')}` : '';
}
