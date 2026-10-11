/**
 * Pinned-question receipts: the agent operator envelope for every pin, list,
 * status and refresh. Each carries the freshness state, the evidence
 * watermark, the last successful refresh, the blocked reason with its next
 * action (an `Action`, rendered by the transport) and a read-only verify
 * step. Answer text appears only for owner-capable readers (access.ts).
 */
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { Action, McpCall } from '../agent-output.ts';
import { autopilotInstallIdPath, autopilotPaused } from '../autopilot-paths.ts';
import { chatKeyFix } from '../interop-notices.ts';
import { evaluateAnswer, newEvidenceSinceWatermark, type EvaluatedSentence } from './freshness.ts';
import { chatKeyAvailable, resolveQuestionModel, type BlockedReason, type RefreshOutcome } from './refresh.ts';
import { pinId, pinScope, type PinRow } from './store.ts';
import type { QuestionScope } from './identity.ts';

export type Freshness = 'fresh' | 'stale' | 'awaiting_refresh' | 'refreshing' | 'archived';

export const LAST_PHASE_RUN_KEY = 'cycle.standing_questions.last_run_at';
const WORKER_WINDOW_MS = 2 * 86_400_000;

export interface QuestionReceipt {
  id: string;
  source_id: string;
  slug: string;
  question: string;
  scope: QuestionScope;
  state: PinRow['state'];
  inactive_reason: PinRow['inactive_reason'];
  publish_mode: PinRow['publish_mode'];
  origin: string;
  page_materialized: boolean;
  freshness: Freshness;
  answer_revision: number;
  sentences: { total: number; fresh: number; stale: number; withheld: number };
  answer?: Array<Pick<EvaluatedSentence, 'id' | 'text' | 'origin' | 'stale' | 'reasons'>>;
  evidence_watermark: { page_generation: number; fact_id: number | null; at: string } | null;
  new_evidence_since_watermark: boolean;
  last_refresh_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  blocked_reason: BlockedReason | null;
  fix: Action | null;
  verify: { argv: string[]; mcp: McpCall };
  spend_usd: number;
  refresh_attempts: number;
  refresh?: RefreshOutcome;
}

/** Is anything going to run the standing_questions phase on its own: a recent phase run, or installed, unpaused autopilot. */
export async function scheduledRefreshAvailable(engine: BrainEngine): Promise<boolean> {
  const last = await engine.getConfig(LAST_PHASE_RUN_KEY).catch(() => null);
  const at = last ? Date.parse(last) : NaN;
  if (Number.isFinite(at) && Date.now() - at < WORKER_WINDOW_MS) return true;
  try { return existsSync(autopilotInstallIdPath()) && !autopilotPaused(); } catch { return false; }
}

export function statusArgv(id: string): string[] { return ['gbrain', 'questions', 'status', id, '--json']; }

function verifyStep(id: string): { argv: string[]; mcp: McpCall } {
  return { argv: statusArgv(id), mcp: { tool: 'questions_status', arguments: { id } } };
}

function refreshAction(id: string, why: string, full = false): Action {
  return {
    argv: ['gbrain', 'questions', 'refresh', id, ...(full ? ['--full'] : [])],
    mcp: { tool: 'questions_refresh', arguments: { id, ...(full ? { full: true } : {}) } },
    consent: [], actor: 'agent', why, verify: verifyStep(id), requires_exclusive: false,
  };
}

function lastAttemptFailed(pin: PinRow, prefix: string): boolean {
  if (!pin.last_error?.startsWith(prefix) || !pin.last_attempt_at) return false;
  return !pin.last_refresh_at || pin.last_attempt_at.getTime() >= pin.last_refresh_at.getTime();
}

export function fixFor(pin: PinRow, blocked: BlockedReason | null, freshness: Freshness, remote: boolean): Action | null {
  const id = pinId(pin);
  switch (blocked) {
    case 'awaiting_consent':
      return {
        argv: ['gbrain', 'questions', 'pin', '--id', id], consent: ['paid'], actor: remote ? 'user' : 'agent',
        why: pin.inactive_reason?.startsWith('migrated_')
          ? 'This pin was imported from dream.auto_think, which never ran in the dream cycle, so it stays inactive until the owner turns it on. Activating it allows paid model refreshes under cycle.standing_questions.budget_usd.'
          : 'A pin created over MCP stays inactive until the owner activates paid refresh on the brain host (or has set consent.preapprove.paid.max_usd_per_run). Activating it allows paid model refreshes under cycle.standing_questions.budget_usd.',
        user_message: `The pinned question "${pin.question.slice(0, 120)}" needs a paid model call to answer and to keep its answer current. Activate it with: gbrain questions pin --id ${id}`,
        verify: verifyStep(id), requires_exclusive: false,
      };
    case 'no_model_key':
      return { ...chatKeyFix(), verify: verifyStep(id) };
    case 'budget_exhausted':
      return {
        argv: ['gbrain', 'config', 'set', 'cycle.standing_questions.budget_usd', '<usd>'], consent: ['paid'], actor: 'user',
        inputs: [{ name: 'usd', how: 'Ask the user for the per-run cap in USD they want for pinned-question refreshes.' }],
        why: 'The pinned-question refresh budget for this run is spent, so the refresh was not attempted. The answer keeps its stale flags until the next run with budget; raising the cap is the owner\'s call.',
        user_message: 'Pinned-question refreshes hit their spending cap. Raise cycle.standing_questions.budget_usd, or wait for the next run?',
        verify: verifyStep(id), requires_exclusive: false,
      };
    case 'refresh_failed':
      return refreshAction(id, `The last refresh failed (${pin.last_error}); the previous answer is kept with its stale flags. A full refresh recomputes it from current evidence.`, true);
    case 'no_worker':
      return refreshAction(id, 'Nothing runs scheduled refreshes on this brain (no standing_questions cycle phase in the last 2 days and no autopilot), so the answer stays as it is until something refreshes it. Refresh it now; a recurring cycle needs the owner to install autopilot (gbrain autopilot --install), which a pin never does.');
    default:
      if (freshness === 'stale' || freshness === 'awaiting_refresh') {
        return refreshAction(id, 'The answer needs a refresh; the next standing_questions cycle phase does it, or refresh it now.');
      }
      return null;
  }
}

export async function buildReceipt(engine: BrainEngine, pin: PinRow, view: {
  readableSources: string[] | null; includeAnswer: boolean; remote: boolean; refresh?: RefreshOutcome;
}): Promise<QuestionReceipt> {
  const evaluation = await evaluateAnswer(engine, pin, { readableSources: view.readableSources });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [pin.source_id, pin.slug]);
  const leaseLive = pin.lease_token !== null && pin.lease_expires_at !== null && pin.lease_expires_at.getTime() > Date.now();
  const freshness: Freshness = pin.state === 'archived' ? 'archived'
    : leaseLive ? 'refreshing'
    : pin.answer_revision === 0 ? 'awaiting_refresh'
    : evaluation.stale > 0 || evaluation.hidden > 0 ? 'stale' : 'fresh';
  const newEvidence = pin.state === 'active' ? await newEvidenceSinceWatermark(engine, pin) : false;
  let blocked: BlockedReason | null = null;
  if (pin.state === 'inactive') blocked = 'awaiting_consent';
  else if (pin.state === 'active' && freshness !== 'refreshing') {
    const needsRefresh = freshness === 'stale' || freshness === 'awaiting_refresh';
    if (!chatKeyAvailable(await resolveQuestionModel(engine, pin))) blocked = needsRefresh || lastAttemptFailed(pin, 'no_model_key') ? 'no_model_key' : null;
    else if (lastAttemptFailed(pin, 'budget_exhausted')) blocked = 'budget_exhausted';
    else if (lastAttemptFailed(pin, 'refresh_failed')) blocked = 'refresh_failed';
    else if ((needsRefresh || newEvidence) && !(await scheduledRefreshAvailable(engine))) blocked = 'no_worker';
  }
  const id = pinId(pin);
  return {
    id, source_id: pin.source_id, slug: pin.slug, question: pin.question, scope: pinScope(pin), state: pin.state,
    inactive_reason: pin.inactive_reason, publish_mode: pin.publish_mode, origin: pin.origin, page_materialized: !!page,
    freshness, answer_revision: pin.answer_revision,
    sentences: { total: pin.answer.length, fresh: evaluation.fresh, stale: evaluation.stale, withheld: evaluation.hidden },
    ...(view.includeAnswer ? { answer: evaluation.sentences.filter(s => !s.hidden).map(s => ({ id: s.id, text: s.text, origin: s.origin, stale: s.stale, reasons: s.reasons })) } : {}),
    evidence_watermark: pin.watermark_generation === null ? null
      : { page_generation: pin.watermark_generation, fact_id: pin.watermark_fact_id, at: pin.watermark_at?.toISOString() ?? '' },
    new_evidence_since_watermark: newEvidence,
    last_refresh_at: pin.last_refresh_at?.toISOString() ?? null,
    last_attempt_at: pin.last_attempt_at?.toISOString() ?? null,
    last_error: pin.last_error,
    blocked_reason: blocked,
    fix: fixFor(pin, blocked, freshness, view.remote),
    verify: verifyStep(id),
    spend_usd: Number(pin.spend_usd.toFixed(6)),
    refresh_attempts: pin.refresh_attempts,
    ...(view.refresh ? { refresh: view.refresh } : {}),
  };
}
