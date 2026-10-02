/**
 * TypeSafe System One wire adapter (POST /v1/systemone). Pure: builds request
 * bodies and validates responses; transport, auth and budgets live in the
 * decide runner (index.ts) and the gateway.
 *
 * Wire: body {model, state, questions: {id: {type, instructions, criteria}}}.
 * Answers: noul {type:'noul', noul}; choice {type:'choice', choice,
 * confidence, probabilities}; score {type:'score', score, confidence, legend,
 * probabilities}; top level {model, answers, usage:{input_tokens, output_tokens}}.
 * Any missing id or non-numeric / out-of-range value fails the whole batch
 * (malformed_response); partial answers are never used.
 */
import { DecideError, type DecideAnswer, type DecideQuestion } from '../types.ts';

export interface TypeSafeWireQuestion {
  type: 'noul' | 'choice' | 'score';
  instructions: string | Record<string, string>;
  criteria?: Record<string, string> | string[];
}

export interface TypeSafeWireRequest {
  model: string;
  state: Record<string, string>;
  questions: Record<string, TypeSafeWireQuestion>;
}

export interface TypeSafeBatchResult {
  model: string;
  answers: Record<string, DecideAnswer>;
  inputTokens?: number;
  outputTokens?: number;
}

/** Instructions carry the task plus the question's own named inputs; candidates are data, never instructions. */
export function toWireQuestion(q: DecideQuestion): TypeSafeWireQuestion {
  const inputs = Object.fromEntries(Object.entries(q.inputs ?? {}).map(([name, item]) => [name, item.text]));
  const instructions = Object.keys(inputs).length > 0 ? { task: q.instructions, ...inputs } : q.instructions;
  if (q.kind === 'noul') return { type: 'noul', instructions };
  if (q.kind === 'choice') return { type: 'choice', instructions, criteria: q.options };
  return { type: 'score', instructions, criteria: q.levels };
}

export function buildTypeSafeRequest(model: string, state: Record<string, string>, questions: readonly DecideQuestion[]): TypeSafeWireRequest {
  return { model, state, questions: Object.fromEntries(questions.map((q) => [q.id, toWireQuestion(q)])) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isProbability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function probabilities(raw: unknown, labels: readonly string[]): Record<string, number> {
  if (!isRecord(raw)) throw new DecideError('malformed_response', 'decide: probabilities missing');
  const out: Record<string, number> = {};
  for (const label of labels) {
    const v = raw[label];
    if (v === undefined) continue;
    if (!isProbability(v)) throw new DecideError('malformed_response', 'decide: probability out of range');
    out[label] = v;
  }
  return out;
}

export function parseAnswer(q: DecideQuestion, raw: unknown): DecideAnswer {
  if (!isRecord(raw) || raw.type !== q.kind) throw new DecideError('malformed_response', `decide: answer for ${q.id} missing or wrong type`);
  if (q.kind === 'noul') {
    if (!isProbability(raw.noul)) throw new DecideError('malformed_response', `decide: noul for ${q.id} out of range`);
    return { kind: 'noul', p: raw.noul };
  }
  // Confidence is optional on the wire; when present it must be a probability.
  if (raw.confidence !== undefined && !isProbability(raw.confidence)) throw new DecideError('malformed_response', `decide: confidence for ${q.id} out of range`);
  if (q.kind === 'choice') {
    const labels = Object.keys(q.options);
    if (typeof raw.choice !== 'string' || !labels.includes(raw.choice)) throw new DecideError('malformed_response', `decide: choice for ${q.id} is not an option`);
    const probs = probabilities(raw.probabilities, labels);
    return { kind: 'choice', choice: raw.choice, confidence: (raw.confidence as number | undefined) ?? probs[raw.choice] ?? 1, probabilities: probs };
  }
  const max = q.levels.length - 1;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > max) {
    throw new DecideError('malformed_response', `decide: score for ${q.id} out of range`);
  }
  return {
    kind: 'score', score: raw.score, normalized: max > 0 ? raw.score / max : 0, confidence: (raw.confidence as number | undefined) ?? 1,
    probabilities: raw.probabilities === undefined ? {} : probabilities(raw.probabilities, q.levels.map((_, i) => String(i))),
  };
}

/** Validate one batch response against exactly the questions it carried. */
export function parseTypeSafeResponse(value: unknown, questions: readonly DecideQuestion[]): TypeSafeBatchResult {
  if (!isRecord(value) || !isRecord(value.answers)) throw new DecideError('malformed_response', 'decide: malformed answers');
  if (typeof value.model !== 'string' || !value.model) throw new DecideError('malformed_response', 'decide: response carries no resolved model');
  const answers: Record<string, DecideAnswer> = {};
  for (const q of questions) answers[q.id] = parseAnswer(q, (value.answers as Record<string, unknown>)[q.id]);
  const usage = isRecord(value.usage) ? value.usage : {};
  const tokens = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  return { model: value.model, answers, inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens) };
}

/**
 * Classify a non-OK HTTP response without keeping its body (provider errors
 * can echo evidence). 400 "unknown model" becomes pinned_model_unavailable.
 */
export async function classifyTypeSafeHttpError(response: Response): Promise<DecideError> {
  const status = response.status;
  if (status === 401 || status === 403) return new DecideError('provider_error', `decide: provider auth failed (HTTP ${status})`, status);
  if (status === 404) return new DecideError('pinned_model_unavailable', 'decide: model unavailable (HTTP 404)', status);
  if (status === 400 || status === 422) {
    let unknownModel = false;
    try { unknownModel = /unknown model|model (is )?(not )?(available|unavailable|found)/i.test(await response.text()); } catch { /* status only */ }
    if (unknownModel) return new DecideError('pinned_model_unavailable', `decide: pinned model unavailable (HTTP ${status})`, status);
  }
  return new DecideError(status === 429 ? 'rate_limited' : 'provider_error', `decide: provider HTTP ${status}`, status);
}
