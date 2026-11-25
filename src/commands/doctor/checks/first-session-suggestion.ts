/**
 * first_session_suggestion (onboarding roadmap PR 2): whether the first-session suggestion is armed on this brain and
 * why not when it is off (not_new_install, not_personal, window_expired, sessions_exhausted, stopped), plus the newest
 * startup session's outcome from the local hook record (delivered, not_due, serve_not_ready, no_ipc, deadline,
 * trimmed, ...). A report, never a failure.
 */
import type { Check } from '../../doctor.ts';
import { rethrowCapabilityRefusal } from '../../../core/engine-capability-refusal.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runFirstSessionSuggestion(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('first_session_suggestion');
  try {
    const { firstSessionStatus } = await import('../../../core/onboard/first-session.ts');
    const { readFirstSessionOutcomes } = await import('../../../core/context/session-start-sections.ts');
    const s = await firstSessionStatus(engine);
    const last = readFirstSessionOutcomes().at(-1) ?? null;
    const lastLine = last ? ` Newest startup session (${last.harness}, ${last.ts}): ${last.outcome}${last.reason ? ` (${last.reason})` : ''}.` : '';
    checks.push({
      name: 'first_session_suggestion',
      status: 'ok',
      message: `${s.why}${lastLine} Details: gbrain onboarding status.`,
      details: { state: s.state, ...(s.reason ? { reason: s.reason } : {}), delivered_sessions: s.delivered_sessions, max_sessions: s.max_sessions, window_ends_at: s.window_ends_at, last_session: last },
    });
  } catch (err) {
    rethrowCapabilityRefusal(err);
    checks.push(checkError('first_session_suggestion', 'read the first-session suggestion state', err));
  }
  return checks;
}

export const firstSessionSuggestionEntry: DoctorEntry = { name: 'first_session_suggestion', emits: ['first_session_suggestion'], run: runFirstSessionSuggestion };
