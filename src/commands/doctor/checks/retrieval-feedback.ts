/**
 * Retrieval feedback health: whether use-attributed feedback is on, how much
 * it has learned, and whether one client dominates the ratings. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { loadFeedbackSettings } from '../../../core/feedback/settings.ts';
import { feedbackStatus } from '../../../core/feedback/store.ts';
import { agentFix } from '../check-fix.ts';

/** Answers recorded with no rating at all before doctor suspects the host hides the answer id (#6192). */
export const UNRATED_ANSWERS_WARN = 50;

async function runRetrievalFeedback(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  if (engine === null) return checks;
  ctx.progress.heartbeat('retrieval_feedback_health');
  try {
    const settings = await loadFeedbackSettings(engine);
    const status = await feedbackStatus(engine);
    const details = {
      enabled: settings.enabled, learn: settings.learn, influence: settings.influence, implicit: settings.implicit,
      answers_recorded: status.events, ratings_explicit: status.ratings_explicit, ratings_cited: status.ratings_cited,
      weights: status.weights_total, weights_off_neutral: status.weights_off_neutral,
      last_rating_at: status.last_rating_at?.toISOString() ?? null, top_client_share_7d: status.top_client_share_7d,
      docs: 'docs/guides/retrieval-feedback.md',
    };
    if (!settings.enabled) {
      checks.push({ name: 'retrieval_feedback_health', status: 'ok', details,
        message: 'Retrieval feedback is off; rankings do not learn from ratings. Turn it on with: gbrain config set feedback.enabled true' });
    } else if (status.top_client_share_7d !== null && status.top_client_share_7d > 0.8 && status.ratings_explicit > 10) {
      checks.push({ name: 'retrieval_feedback_health', status: 'warn', details,
        message: `One client made ${Math.round(status.top_client_share_7d * 100)}% of ratings in the last 7 days. If that is unexpected, review the learned pages with \`gbrain feedback status\`, reset with \`gbrain feedback reset\`, and check that client's write grant.` });
    } else if (status.events >= UNRATED_ANSWERS_WARN && status.ratings_explicit + status.ratings_cited === 0) {
      checks.push({ name: 'retrieval_feedback_health', status: 'warn', details,
        message: `Retrieval feedback is on and ${status.events} answers were recorded, but none was rated, so ranking learns nothing. An agent can rate only when it sees the answer id: over MCP it rides a "Rate after use: rate_answer { answer_id: … }" line in the tool result text, and a host that hides tool-result text or notice blocks never shows it. Check that the agent's host shows tool result text; the CLI prints the id on stderr (\`gbrain rate <answer_id> 1-5\`).`,
        fix: agentFix(['gbrain', 'feedback', 'status', '--json'], 'Shows answers recorded, ratings by signal and the last rating time; read-only.', 'retrieval_feedback_health', { docs: 'docs/guides/retrieval-feedback.md#rating' }) });
    } else {
      checks.push({ name: 'retrieval_feedback_health', status: 'ok', details,
        message: `Retrieval feedback on (λ=${settings.influence}): ${status.events} answers recorded, ${status.ratings_explicit + status.ratings_cited} ratings, ${status.weights_off_neutral} pages/edges learned. Inspect with \`gbrain feedback status\`.` });
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    checks.push(code === '42P01'
      ? { name: 'retrieval_feedback_health', status: 'ok', message: 'Skipped (retrieval feedback tables unavailable; apply migrations with gbrain apply-migrations --yes).' }
      : { name: 'retrieval_feedback_health', status: 'warn', message: `Retrieval feedback could not be inspected: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const retrievalFeedbackEntry: DoctorEntry = {
  name: 'retrieval_feedback_health',
  emits: ['retrieval_feedback_health'],
  run: runRetrievalFeedback,
};
