/**
 * The ONE canonical vocabulary for decide: receipt outcomes per slot, skip and
 * error reasons, the refusal-reason catalog (problem, cause, recovery command,
 * docs anchor) and the plain-word slot names user-facing surfaces print.
 *
 * Enforced in TypeScript (receipt writers validate against it) and pinned by a
 * sync test against docs/architecture/decide.md; the database has no CHECK
 * constraint on purpose, so adding a value never needs a migration.
 */
import type { DecideSlot } from './types.ts';

/** Per-slot receipt outcomes. `error` and `skipped` are valid for every slot. */
export const SLOT_OUTCOMES: Readonly<Record<DecideSlot, readonly string[]>> = {
  rerank: ['kept'],
  intent: ['override', 'fallback_regex'],
  evidence: ['kept', 'pruned', 'margin_hold'],
  answerable: ['pass', 'abstain', 'margin_hold', 'incomplete'],
  injection: ['demoted', 'kept'],
  recall_needed: ['fire', 'no_fire', 'suppress', 'margin_hold'],
  triage: ['pass', 'reject', 'margin_hold'],
  grounding: ['pass', 'quarantine', 'insufficient_context', 'margin_hold'],
  conflict: ['duplicate', 'proposal', 'independent'],
};

export const COMMON_OUTCOMES = ['error', 'skipped'] as const;

export type ReceiptOutcome = string;

export function isValidOutcome(slot: DecideSlot, outcome: string): boolean {
  return (COMMON_OUTCOMES as readonly string[]).includes(outcome) || SLOT_OUTCOMES[slot].includes(outcome);
}

/** Every value `error_reason` may carry on a receipt (skips, errors, inactive causes). */
export const SKIP_REASONS = [
  'egress', 'no_key', 'no_provider', 'no_embedding', 'no_entity', 'late', 'budget_exhausted', 'timeout',
  'rate_limited', 'provider_error', 'malformed_response', 'mixed_model', 'model_drift', 'policy_changed',
  'no_calibration', 'pack_shape_mismatch', 'action_precision_low', 'no_qualification', 'pinned_model_unavailable',
  'payload_too_large', 'llm_capability', 'egress_private_denied', 'egress_class_denied', 'missing_provenance',
  'denied_source', 'shadow_queue_full', 'reranker_not_jev', 'cache_hit', 'no_candidates', 'egress_denied',
] as const;
export type SkipReason = typeof SKIP_REASONS[number];

export interface RefusalEntry {
  problem: string;
  cause: string;
  /** Exact recovery command, `<slot>` substituted by the caller. */
  fix: string;
  /** Anchor in docs/guides/system-one.md's troubleshooting table. */
  anchor: string;
}

/** Refusal and inactive-cause catalog. Every refusal path must emit one of these keys. */
export const REFUSAL_CATALOG: Readonly<Record<string, RefusalEntry>> = {
  no_provider: { problem: 'No decide provider is configured.', cause: 'decide.provider is none', fix: 'gbrain decide enable <slot> --provider typesafe:jev-1.13.0', anchor: '#no_provider' },
  no_key: { problem: 'The TypeSafe key is missing.', cause: 'neither TYPESAFE_API_KEY nor JEV_TYPESAFE_API_KEY is set', fix: 'export TYPESAFE_API_KEY=... && gbrain decide probe', anchor: '#no_key' },
  no_calibration: { problem: 'No calibration exists for the resolved model.', cause: 'no local or reference calibration row for (slot, call site, provider, model)', fix: 'gbrain decide calibrate --slot <slot> --dataset <jsonl>', anchor: '#no_calibration' },
  no_qualification: { problem: 'The calibration has not been qualified.', cause: 'no action_precision_lb on the calibration row', fix: 'gbrain decide qualify --slot <slot> --dataset <jsonl>', anchor: '#no_qualification' },
  pack_shape_mismatch: { problem: 'The calibration was measured with a different packing shape.', cause: 'calibration pack_shape differs from the production request', fix: 'gbrain decide calibrate --slot <slot> --dataset <jsonl>', anchor: '#pack_shape_mismatch' },
  action_precision_low: { problem: 'The slot is not precise enough to act on.', cause: 'action_precision_lb is below decide.slots.<slot>.min_action_precision', fix: 'gbrain config set decide.slots.<slot>.force_on true   # explicit bypass, listed by doctor', anchor: '#action_precision_low' },
  insufficient_n: { problem: 'Too few harmful actions to qualify.', cause: 'the dataset cannot reach min_action_precision even if every action is correct', fix: 'gbrain decide dataset --slot <slot> --from <source> <path>   # build a larger dataset', anchor: '#insufficient_n' },
  policy_changed: { problem: 'The action policy changed since qualification.', cause: 'the policy fingerprint (threshold, margin, floors, question version, pack shape) differs', fix: 'gbrain decide qualify --slot <slot> --dataset <jsonl>', anchor: '#policy_changed' },
  model_drift: { problem: 'The provider answered with a different model than the calibration.', cause: 'resolved model id differs from the calibration row', fix: 'gbrain decide calibrations list --slot <slot>   # adopt a calibration for the new model', anchor: '#model_drift' },
  egress_private_denied: { problem: 'Private content cannot be sent to the provider.', cause: 'decide.egress.private is deny', fix: 'gbrain config set decide.egress.private allow   # or route the slot to an llm: provider', anchor: '#egress_private_denied' },
  egress_class_denied: { problem: 'The data class has no consent for this provider.', cause: 'decide.egress.typesafe.<class> is not allow', fix: 'gbrain decide enable <slot>   # shows what leaves the machine, then writes consent', anchor: '#egress_class_denied' },
  egress_fallback_missing: { problem: 'Refused items have no fallback provider.', cause: 'decide.egress_fallback is none', fix: 'gbrain config set decide.egress_fallback llm:<provider:model>', anchor: '#egress_fallback_missing' },
  split_mismatch: { problem: 'The calibration was built from a different dataset split.', cause: 'split_hash differs from the eval split or calibrate_only is false', fix: 'gbrain decide calibrate --slot <slot> --dataset <jsonl>', anchor: '#split_mismatch' },
  pinned_model_unavailable: { problem: 'The pinned model is no longer served.', cause: 'the provider returned unknown or unavailable model', fix: 'gbrain config set decide.provider typesafe:<new-id> && gbrain decide calibrations list', anchor: '#pinned_model_unavailable' },
  budget_exhausted: { problem: 'The daily decide budget is spent.', cause: 'decide_spend for the current UTC day reached decide.budget.daily_usd', fix: 'gbrain config set decide.budget.daily_usd <usd>', anchor: '#budget_exhausted' },
  thin_client: { problem: 'gbrain decide runs on the brain host.', cause: 'this install is a thin client', fix: 'run gbrain decide on the brain host', anchor: '#thin_client' },
  malformed_response: { problem: 'The provider response failed validation.', cause: 'a requested id was missing or a value was non-numeric or out of range', fix: 'gbrain decide probe', anchor: '#malformed_response' },
  reranker_not_jev: { problem: 'Rerank is on but the reranker is not Jev.', cause: 'search.reranker.model is not typesafe:*', fix: 'gbrain decide enable rerank', anchor: '#reranker_not_jev' },
  slot_unavailable: { problem: 'This slot is not available in this build.', cause: 'the slot is not wired at its call site yet', fix: 'gbrain decide status', anchor: '#slot_unavailable' },
  llm_capability: { problem: 'The llm: provider cannot enforce structured output or report its model.', cause: 'the chat route ignores response schemas or reports no model identity', fix: 'gbrain config set decide.slots.<slot>.provider llm:<provider:model>   # a structured-output route', anchor: '#llm_capability' },
  no_recorded_win: { problem: 'No slot has a recorded win for this model.', cause: 'no slot verdict is a win with a passing reference calibration', fix: 'see docs/eval/system-one/', anchor: '#no_recorded_win' },
};

export type RefusalReason = keyof typeof REFUSAL_CATALOG;

/** Plain words for every slot (user-facing surfaces say these, not the key). */
export const SLOT_PLAIN_NAMES: Readonly<Record<DecideSlot, string>> = {
  rerank: 'search reranking',
  intent: 'query routing',
  evidence: 'evidence gate',
  answerable: 'abstention',
  injection: 'injection signal',
  recall_needed: 'know-to-ask',
  triage: 'dream triage',
  grounding: 'claim support',
  conflict: 'contradiction',
};

export function refusalLine(reason: string, slot?: DecideSlot): string {
  const entry = REFUSAL_CATALOG[reason];
  if (!entry) return reason;
  const fix = slot ? entry.fix.replaceAll('<slot>', slot) : entry.fix;
  return `${entry.problem} (${reason}: ${entry.cause}) fix: ${fix} docs: docs/guides/system-one.md${entry.anchor}`;
}
