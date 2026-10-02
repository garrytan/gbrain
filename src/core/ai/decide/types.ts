/**
 * System One decide capability: the shared request/answer contract.
 *
 * Every slot asks typed questions over typed evidence. Evidence items carry
 * provenance (class, source, page/fact/transcript identity, visibility) so the
 * egress gate can decide, before serialization, what may leave the machine.
 * Contract doc: docs/architecture/decide.md.
 */

export const DECIDE_SLOTS = [
  'rerank', 'intent', 'evidence', 'answerable', 'injection', 'recall_needed', 'triage', 'grounding', 'conflict',
] as const;
export type DecideSlot = typeof DECIDE_SLOTS[number];

/** `shadow` is the advanced diagnostics mode; `off`/`on` are the user-facing states. */
export type DecideMode = 'off' | 'on' | 'shadow';
export type DecideLane = 'hot' | 'background';

/** Data classes a provider needs consent for (decide.egress.typesafe.<class>). */
export const EVIDENCE_CLASSES = ['query', 'candidates', 'facts', 'conversation'] as const;
export type EvidenceClass = typeof EVIDENCE_CLASSES[number];

/** One piece of text sent to a provider, with the provenance the egress gate checks. */
export interface EvidenceItem {
  text: string;
  class: EvidenceClass;
  source_id?: string;
  /** Page provenance (class `candidates`). */
  slug?: string;
  /** Fact provenance (class `facts`). */
  fact_id?: number;
  /** Transcript provenance (class `conversation`). */
  transcript_ref?: string;
  /** Caller-known visibility (facts carry their own; pages are resolved by the gate). */
  visibility?: 'private' | 'world';
}

interface QuestionBase {
  /** Stable id, unique within one decision. Code-only; never shown to the model as meaning. */
  id: string;
  /** Plain task text. Named inputs are referenced by backticked name, e.g. `candidate`. */
  instructions: string;
  /** Per-question evidence, keyed by the name the instructions reference. */
  inputs?: Record<string, EvidenceItem>;
  /** Co-packed question from another slot (S5 riding the S3 request). Defaults to the request slot. */
  slot?: DecideSlot;
  /** Candidate rank (packing order and receipts). */
  rank?: number;
  /** Floor-protected item (receipts `protected`, what-if replay). */
  protected?: boolean;
}

export type DecideQuestion =
  | (QuestionBase & { kind: 'noul' })
  | (QuestionBase & { kind: 'choice'; options: Record<string, string> })
  | (QuestionBase & { kind: 'score'; levels: string[] });

export type QuestionKind = DecideQuestion['kind'];

/** Probability that the question's statement holds. */
export interface NoulAnswer { kind: 'noul'; p: number }
export interface ChoiceAnswer { kind: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
/** `score` is the level index (0..levels-1, may be fractional); `normalized` maps it to 0..1. */
export interface ScoreAnswer { kind: 'score'; score: number; normalized: number; confidence: number; probabilities: Record<string, number> }
export type DecideAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecideUsage { input_tokens: number; output_tokens: number }

export interface DecideRequest {
  slot: DecideSlot;
  /** Explicit call site (calibrations and receipts key on it), e.g. `search`, `think`, `query`. */
  callSite: string;
  /** Shared state, sent once per batch. */
  state: Record<string, EvidenceItem>;
  questions: DecideQuestion[];
  /** Budget for the whole logical decision (all batches), in ms. */
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Defaults to the slot's lane. */
  lane?: DecideLane;
  /** Provider override (`typesafe:<model>` or `llm:<provider:model>`); else the slot's configured provider. */
  provider?: string;
  /** Remote-triggered (MCP query/think) spend, counted against decide.budget.remote_share. */
  remote?: boolean;
  /** Other slots whose questions ride this request (pack_shape). */
  coPacked?: DecideSlot[];
  /** Skip the daily-cap check (S1 `on`, governed by reranker spend controls). */
  budgetKind?: 'decide' | 'rerank';
  /** The consent that authorizes the data classes: decide keys, or the reranker selection (S1 on). */
  consent?: 'decide' | 'reranker';
}

export interface DecideResult {
  decision_id: string;
  provider: string;
  model_alias: string;
  model_resolved: string;
  /** Answers by question id. Questions refused by egress are absent here and listed in `refused`. */
  answers: Record<string, DecideAnswer>;
  /** Question ids the egress gate withheld, with the catalogued reason. */
  refused: Record<string, string>;
  /** Egress-refused questions answered by decide.egress_fallback, as their own sub-decision. */
  fallback?: DecideResult;
  usage: DecideUsage;
  cost_usd: number;
  latency_ms: number;
  batches: number;
  lane: DecideLane;
  /** Answers are uncalibrated model statements (llm: provider without calibration). */
  uncalibrated?: boolean;
}

/** Why a logical decision produced no usable answers. Callers take the slot's fail direction. */
export type DecideFailureReason =
  | 'timeout' | 'rate_limited' | 'provider_error' | 'malformed_response' | 'mixed_model'
  | 'budget_exhausted' | 'no_key' | 'no_provider' | 'pinned_model_unavailable' | 'payload_too_large'
  | 'egress' | 'late' | 'llm_capability';

export class DecideError extends Error {
  reason: DecideFailureReason;
  status?: number;
  constructor(reason: DecideFailureReason, message: string, status?: number) {
    super(message);
    this.name = 'DecideError';
    this.reason = reason;
    this.status = status;
  }
}

/** The number a threshold compares against: noul p, choice probability of the chosen label, normalized score. */
export function thresholdValue(answer: DecideAnswer): number {
  if (answer.kind === 'noul') return answer.p;
  if (answer.kind === 'choice') return answer.probabilities[answer.choice] ?? answer.confidence;
  return answer.normalized;
}
