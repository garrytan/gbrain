/**
 * #7188: what a handler's returned result says about its job, read by the worker before it records the job's end.
 *
 * `failed`: the result reports a failure: a top-level (or nested cycle `report`) status of `blocked_by_failures`
 * or `failed`, or a phase of that report with status `fail` (the first such phase names the reason, with its code,
 * and is returned as `phase`). `partial`: unfinished work and no failure (`partial: true` or `status: 'partial'`:
 * phases deferred to the next pass, a drain that stopped at its deadline with a follow-up queued, a source another
 * drainer holds). `clean`: everything else, a deliberate skip included.
 *
 * The worker ends a `failed` result as a terminal `failed` job whose error names the reason and stores
 * `jobOutcomeResult`: `job_outcome: 'phase_failed'` with `failed_phase` when a phase failed (the autopilot source
 * cooldown skips those, so one failing phase does not back off a source's sync), `job_outcome: 'failed'` otherwise. A
 * `partial` one completes with `job_outcome: 'partial'`, since the queue has no partial status.
 */
export interface JobOutcome { outcome: 'clean' | 'partial' | 'failed'; reason?: string; phase?: string }

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const statusReason = (status: string, report: Rec) => `result status ${status}${typeof report.reason === 'string' ? ` (${report.reason})` : ''}`;

export function jobResultOutcome(result: unknown): JobOutcome {
  const top = rec(result);
  if (!top || top.skipped === true) return { outcome: 'clean' };
  const report = rec(top.report) ?? top;
  if (top.status === 'blocked_by_failures' || report.status === 'blocked_by_failures') return { outcome: 'failed', reason: statusReason('blocked_by_failures', report) };
  const phases = Array.isArray(report.phases) ? report.phases.map(rec).filter((p): p is Rec => p !== null) : [];
  const failedPhase = phases.find(p => p.status === 'fail');
  if (failedPhase) {
    const error = rec(failedPhase.error);
    const code = failedPhase.code ?? error?.code;
    const detail = error?.message ?? failedPhase.summary;
    const phase = String(failedPhase.phase);
    return { outcome: 'failed', phase, reason: `phase ${phase} failed${code ? ` (${String(code)})` : ''}${detail ? `: ${String(detail)}` : ''}` };
  }
  if (top.status === 'failed' || report.status === 'failed') return { outcome: 'failed', reason: statusReason('failed', report) };
  if (top.partial === true || top.status === 'partial' || report.status === 'partial') return { outcome: 'partial' };
  return { outcome: 'clean' };
}

/** The result the worker stores for an outcome: the handler's result with the `job_outcome` markers above. */
export function jobOutcomeResult(result: Rec | undefined, verdict: JobOutcome): Rec | undefined {
  if (verdict.outcome === 'clean') return result;
  if (verdict.outcome === 'partial') return { ...result, job_outcome: 'partial' };
  return { ...result, job_outcome: verdict.phase ? 'phase_failed' : 'failed', ...(verdict.phase ? { failed_phase: verdict.phase } : {}) };
}
