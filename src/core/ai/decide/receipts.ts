/**
 * Receipt construction for slot code: one row per question, hashes only.
 * `subject_ref`, `state_hash` and `question_hash` are HMAC-SHA256 under the
 * per-brain salt (store.ts receiptSalt), so rows are joinable for calibration
 * but not dictionary-reversible. Writes are buffered and fire-and-forget.
 */
import type { BrainEngine } from '../../engine.ts';
import { hmacRef, receiptSalt, recordReceipts, type ReceiptRow } from './store.ts';
import type { SlotPolicy } from './policy.ts';
import { thresholdValue, type DecideLane, type DecideQuestion, type DecideResult, type DecideSlot, type EvidenceItem } from './types.ts';

export interface ReceiptInput {
  slot: DecideSlot;
  mode: 'on' | 'shadow';
  callSite: string;
  lane: DecideLane;
  policy?: Pick<SlotPolicy, 'threshold' | 'fingerprint' | 'calibration' | 'minKeep' | 'provider'>;
  provider: string;
  result?: DecideResult;
  questions: readonly DecideQuestion[];
  state: Record<string, EvidenceItem>;
  /** Outcome per question id; questions without one get `fallbackOutcome`. */
  outcomes: Record<string, string>;
  fallbackOutcome?: string;
  /** error_reason per question id, or one for all. */
  reasons?: Record<string, string>;
  reason?: string;
  /** Plain subject identity per question id (hashed before storage), e.g. `page:<source>:<slug>`. */
  subjects?: Record<string, string>;
  sourceId?: string | null;
  remote?: boolean;
  kUsed?: number;
  latencyMs?: number;
  runMeta?: string;
}

export async function buildReceiptRows(engine: BrainEngine, input: ReceiptInput): Promise<ReceiptRow[]> {
  const salt = await receiptSalt(engine);
  const stateHash = hmacRef(salt, JSON.stringify(Object.entries(input.state).map(([k, v]) => [k, v.text])));
  const r = input.result;
  const perQuestionTokens = r && input.questions.length > 0 ? Math.round(r.usage.input_tokens / input.questions.length) : null;
  return input.questions.map((q) => {
    const answer = r?.answers[q.id] ?? r?.fallback?.answers[q.id];
    const subject = input.subjects?.[q.id];
    return {
      decision_id: r?.decision_id ?? `none:${stateHash}`,
      source_id: input.sourceId ?? null,
      slot: q.slot ?? input.slot,
      mode: input.mode,
      provider: r?.fallback?.answers[q.id] ? r.fallback.provider : input.provider,
      model_alias: r?.model_alias ?? null,
      model_resolved: r?.fallback?.answers[q.id] ? r.fallback.model_resolved : r?.model_resolved || null,
      question_kind: q.kind,
      state_hash: stateHash,
      question_hash: hmacRef(salt, `${q.kind}|${q.instructions}|${JSON.stringify(Object.entries(q.inputs ?? {}).map(([k, v]) => [k, v.text]))}`),
      answer_value: answer ? thresholdValue(answer) : null,
      answer_choice: answer?.kind === 'choice' ? answer.choice : null,
      confidence: answer && answer.kind !== 'noul' ? answer.confidence : null,
      threshold: input.policy?.threshold ?? null,
      outcome: input.outcomes[q.id] ?? input.fallbackOutcome ?? 'skipped',
      subject_ref: subject ? hmacRef(salt, subject) : null,
      call_site: input.callSite,
      lane: input.lane,
      policy_fingerprint: input.policy?.fingerprint ?? null,
      calibration_ref: input.policy?.calibration?.ref ?? null,
      latency_ms: input.latencyMs ?? r?.latency_ms ?? null,
      input_tokens: perQuestionTokens,
      error_reason: input.reasons?.[q.id] ?? r?.refused[q.id] ?? input.reason ?? null,
      protected: q.protected === true,
      min_keep: input.policy?.minKeep ?? null,
      rank: q.rank ?? null,
      k_used: input.kUsed ?? null,
      remote: input.remote === true,
      run_meta: input.runMeta ?? (process.env.GBRAIN_DECIDE_SLOTS ? `GBRAIN_DECIDE_SLOTS=${process.env.GBRAIN_DECIDE_SLOTS}` : null),
    };
  });
}

/** Fire-and-forget receipt write; never throws into the caller. */
export function writeReceipts(engine: BrainEngine | null | undefined, input: ReceiptInput): Promise<void> {
  if (!engine) return Promise.resolve();
  return buildReceiptRows(engine, input).then((rows) => recordReceipts(engine, rows)).catch(() => {
    // Receipts never break the caller (a vocabulary violation is pinned by unit tests on recordReceipts).
  });
}
