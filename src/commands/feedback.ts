/**
 * foresights feedback — inspect and reset use-attributed retrieval feedback.
 *
 * Usage:
 *   foresights feedback status [--json]
 *   foresights feedback reset [--source ID] [--page SLUG]
 *
 * Zero LLM calls. Ratings come from `foresights rate` / the rate_answer op.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { loadFeedbackSettings } from '../core/feedback/settings.ts';
import { droppedFeedbackEvents } from '../core/feedback/record.ts';
import { feedbackStatus, resetRetrievalWeights } from '../core/feedback/store.ts';
import { feedbackStageErrors } from '../core/search/feedback-boost.ts';

const HELP = `Usage: foresights feedback <status|reset> [options]

Inspect and reset the brain's use-attributed retrieval feedback (ratings from
\`foresights rate\` / rate_answer and think/synthesize citations).

  status [--json]                    counts, weight spread, lowest-weighted pages with a next step
  reset [--source ID] [--page SLUG]  return learned weights to neutral (all, one source, or one page)

Guide: docs/guides/retrieval-feedback.md
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runFeedback(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || args.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  if (sub === 'reset') {
    const sourceId = flag(args, '--source');
    const slug = flag(args, '--page');
    const removed = await resetRetrievalWeights(engine, { sourceId, slug });
    const scope = slug ? `page ${slug}` : sourceId ? `source ${sourceId}` : 'the whole brain';
    process.stdout.write(`Reset ${removed} learned weight${removed === 1 ? '' : 's'} to neutral for ${scope}.\n`);
    return;
  }
  if (sub !== 'status') {
    process.stderr.write(`Unknown subcommand: ${sub}\n\n${HELP}`);
    setCliExitVerdict(2);
    return;
  }
  const [settings, status] = await Promise.all([loadFeedbackSettings(engine), feedbackStatus(engine)]);
  const report = {
    settings,
    ...status,
    dropped_events_this_process: droppedFeedbackEvents(),
    stage_errors_this_process: feedbackStageErrors(),
  };
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const lines = [
    `Retrieval feedback: ${settings.enabled ? 'on' : 'off'}${settings.enabled && !settings.learn ? ' (not learning)' : ''}, influence λ=${settings.influence}, implicit=${settings.implicit ? 'on' : 'off'}`,
    `Answers recorded (last ${settings.eventRetentionDays} days): ${status.events}`,
    `Ratings: ${status.ratings_explicit} explicit, ${status.ratings_cited} from citations${status.last_rating_at ? ` (last ${status.last_rating_at.toISOString()})` : ''}`,
    `Learned weights: ${status.weights_total} (${status.weights_off_neutral} away from neutral)`,
  ];
  if (status.top_client_share_7d !== null && status.top_client_share_7d > 0.8 && status.ratings_explicit > 10) {
    lines.push(`Warning: one client made ${Math.round(status.top_client_share_7d * 100)}% of ratings in the last 7 days. If that is not expected, run \`foresights feedback reset\` and review that client's write grant.`);
  }
  if (status.highest.length > 0) {
    lines.push('', 'Most trusted pages:');
    for (const h of status.highest) lines.push(`  ${h.weight.toFixed(3)}  ${h.source_id}:${h.slug}`);
  }
  if (status.lowest.length > 0) {
    lines.push('', 'Least trusted pages (open each and check whether it is wrong, stale or simply off-topic for those questions):');
    for (const l of status.lowest) {
      lines.push(`  ${l.weight.toFixed(3)}  ${l.source_id}:${l.slug}  rated low on ${l.low_ratings} answer${l.low_ratings === 1 ? '' : 's'}`);
    }
  }
  if (status.events === 0) {
    lines.push('', 'No answers recorded yet. Answers from query/search/think/synthesize/recall carry an answer_id; rate one with `foresights rate <answer_id> 1-5`.');
  }
  process.stdout.write(lines.join('\n') + '\n');
}
