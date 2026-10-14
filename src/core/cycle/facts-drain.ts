/**
 * `facts_drain` cycle phase (Lane D): one bounded run of the automatic facts
 * drain (src/core/facts/drain.ts) inside the cycle, so a PGLite brain run by
 * autopilot or `gbrain dream` extracts queued `facts-absorb` jobs without
 * `gbrain jobs work`. Postgres brains have a job worker and skip the phase.
 * The phase never fails the cycle: deferrals (no key, budget) report `warn`
 * with the fix; an internal error reports `warn` with the doctor command.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { FACTS_DRAIN_DEFERRALS, FACTS_DRAIN_WALL_MS, runFactsDrain } from '../facts/drain.ts';
import { CYCLE_DEADLINE_RESERVE_MS } from './base-phase.ts';

export async function runPhaseFactsDrain(engine: BrainEngine | null, opts: { dryRun: boolean; signal?: AbortSignal; deadlineAtMs?: number | null }): Promise<PhaseResult> {
  const base = { phase: 'facts_drain' as const, duration_ms: 0 };
  if (!engine) return { ...base, status: 'skipped', summary: 'no database connected', details: { reason: 'no_database' } };
  if (engine.kind !== 'pglite') {
    return { ...base, status: 'skipped', summary: 'Postgres brains run facts-absorb jobs on the job worker', details: { reason: 'not_applicable' } };
  }
  if (opts.dryRun) return { ...base, status: 'skipped', summary: 'dry run: no facts extracted', details: { reason: 'dry_run' } };
  const remaining = opts.deadlineAtMs != null ? opts.deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - Date.now() : FACTS_DRAIN_WALL_MS;
  if (remaining <= 0) return { ...base, status: 'skipped', summary: 'no cycle time left for the facts drain', details: { reason: 'deadline' } };
  const r = await runFactsDrain(engine, { owner: 'cycle', signal: opts.signal, wallClockMs: Math.min(FACTS_DRAIN_WALL_MS, remaining) });
  const details: Record<string, unknown> = {
    outcome: r.outcome, completed: r.completed, failed: r.failed, deferred: r.deferred, facts_inserted: r.facts_inserted,
    spent_usd: r.spent_usd, unpriced_calls: r.unpriced_calls, backlog_before: r.backlog_before, backlog_after: r.backlog_after,
    waiting_after: r.waiting_after, delayed_after: r.delayed_after, active_after: r.active_after,
    waiting_children_after: r.waiting_children_after, paused_after: r.paused_after, remaining_after: r.remaining_after, model: r.model,
    ...(r.error ? { code: r.error.code, reason: r.error.reason, fix: r.error.fix } : {}),
  };
  if (r.outcome === 'disabled') return { ...base, status: 'skipped', summary: 'facts extraction is off (facts.extraction_enabled false)', details };
  if (r.outcome === 'not_applicable') return { ...base, status: 'skipped', summary: 'facts drain unavailable; queue completion not verified', details };
  const remainingJobs = r.remaining_after ?? r.backlog_after;
  const hasRemaining = remainingJobs !== null && remainingJobs > 0;
  if (r.outcome === 'idle' && remainingJobs === 0) return { ...base, status: 'ok', summary: 'no queued facts-absorb jobs', details };
  const summary = `${r.completed} page(s) extracted (${r.facts_inserted} facts, $${r.spent_usd.toFixed(3)}), ${remainingJobs ?? '?'} facts-absorb job(s) remain` +
    (hasRemaining ? ` (${r.waiting_after ?? 0} waiting, ${r.delayed_after ?? 0} delayed, ${r.active_after ?? 0} active, ${r.waiting_children_after ?? 0} waiting-children, ${r.paused_after ?? 0} paused)` : '') +
    (r.error ? `: ${r.error.message}` : '');
  return { ...base, status: hasRemaining || FACTS_DRAIN_DEFERRALS.has(r.outcome) || r.failed > 0 ? 'warn' : 'ok', summary, details };
}
