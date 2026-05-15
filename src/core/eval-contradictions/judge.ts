/**
 * eval-contradictions/judge — the LLM contradiction judge wrapper.
 *
 * One-call, one-pair: send Statement A + Statement B + the user's query to
 * the chat gateway and parse the verdict JSON. The prompt is the canonical
 * text bumped via PROMPT_VERSION when edits land.
 *
 * Codex fixes incorporated:
 *   - Query-conditioned: the judge sees the user's query so it can decide
 *     "contradiction relevant to what was asked" instead of free-form pair
 *     disagreement (Codex outside-voice finding).
 *   - Confidence floor double-enforcement (C1): if the model says
 *     contradicts: true with confidence < 0.7, the orchestrator downgrades
 *     to false. Belt-and-suspenders against models that ignore the prompt.
 *   - judge_errors as first-class: throws are typed and counted in the
 *     denominator — see judge-errors.ts for the collector shape.
 *
 * Provider-neutral via the gateway. Hermetically testable via
 * gateway.__setChatTransportForTests.
 */

import { chat, type ChatResult } from '../ai/gateway.ts';
import { parseSeverity } from './severity-classify.ts';
import type { JudgeVerdict, ResolutionKind } from './types.ts';

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/i;

/**
 * Generic 3-strategy LLM JSON parser. Throws when no strategy works rather
 * than fabricating an empty object — caller maps to judge_errors.parse_fail.
 *
 * (We don't reuse parseModelJSON from cross-modal-eval because that one is
 * shape-specific to {scores, overall, improvements} and rejects our verdict
 * payload. Same 4-strategy spirit, narrower contract.)
 */
export function parseJudgeJSON(text: string): unknown {
  if (!text) throw new Error('parseJudgeJSON: empty response');
  // Strategy 1: direct parse (strict JSON).
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  // Strategy 2: strip ```json fences.
  const fenceMatch = text.match(FENCE_RE);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }
  // Strategy 3: common-repairs pass — trailing commas, single→double quotes.
  const cleaned = text
    .replace(FENCE_RE, (_, inner) => inner)
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/(['"])?([\w-]+)\1?\s*:/g, '"$2":')
    .trim();
  // Extract the first {...} block if there's surrounding prose.
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      // fall through
    }
  }
  throw new Error('parseJudgeJSON: all strategies failed');
}

/** Default per-pair text budget (UTF-8-safe truncation). C4 default. */
export const DEFAULT_MAX_PAIR_CHARS = 1500;

/**
 * UTF-8-safe truncation: cap at maxChars but never split a multi-byte
 * character. Returns the text unchanged if already under the limit.
 *
 * Pattern reused from src/core/minions/handlers/subagent-audit.ts which
 * faces the same multi-byte concern.
 */
export function truncateUtf8(text: string, maxChars: number): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  // Walk back from maxChars to land at a complete code-point boundary.
  // UTF-16 surrogate pairs occupy two code units; if maxChars lands inside
  // one, drop both halves so we don't keep half an emoji.
  let end = maxChars;
  if (end > 0 && end < text.length) {
    const unitAtEnd = text.charCodeAt(end);
    const unitBefore = text.charCodeAt(end - 1);
    const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
    const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
    // Case 1: about to split between high(end-1) and low(end) — drop both.
    if (isHighSurrogate(unitBefore) && isLowSurrogate(unitAtEnd)) {
      end -= 1;
    } else if (isHighSurrogate(unitBefore)) {
      // Stray high surrogate at end — drop it.
      end -= 1;
    } else if (isLowSurrogate(unitBefore)) {
      // We're inside an emoji and end-1 is the low surrogate; back up to
      // BEFORE the high surrogate (drop both halves).
      end -= 2;
    }
  }
  return text.slice(0, Math.max(0, end));
}

export interface JudgeInput {
  /** The user's query for the search that retrieved both members. */
  query: string;
  /** Statement A: slug + text + optional source-tier + holder (if take). */
  a: { slug: string; text: string; source_tier?: string; holder?: string | null };
  b: { slug: string; text: string; source_tier?: string; holder?: string | null };
  /** Provider:model id; routed through gateway.chat. */
  model: string;
  /** UTF-8-safe truncation limit per pair member. C4 flag. */
  maxPairChars?: number;
  /** Test hook: pass a stubbed chat for hermetic tests. Production passes undefined → real gateway. */
  chatFn?: typeof chat;
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
}

export interface JudgeOutput {
  verdict: JudgeVerdict;
  /** Token usage from the gateway. Forwarded to the cost tracker. */
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Validated resolution_kind values. Anything outside this set defaults to
 * 'manual_review' (the safe, no-action option).
 */
function parseResolutionKind(value: unknown): ResolutionKind | null {
  if (
    value === 'takes_supersede' ||
    value === 'dream_synthesize' ||
    value === 'takes_mark_debate' ||
    value === 'manual_review'
  ) {
    return value;
  }
  return null;
}

/**
 * Validate the raw parsed JSON against the JudgeVerdict shape. Throws on
 * fundamentally-broken shape (missing contradicts/confidence) so the caller
 * counts it under judge_errors.parse_fail rather than fabricating a verdict.
 *
 * C1 enforcement: contradicts:true with confidence < 0.7 is downgraded to
 * false (belt-and-suspenders against models ignoring the prompt rule).
 */
export function normalizeVerdict(raw: unknown): JudgeVerdict {
  if (!raw || typeof raw !== 'object') {
    throw new Error('judge JSON missing or not an object');
  }
  const v = raw as Record<string, unknown>;
  const rawContradicts = v.contradicts;
  if (typeof rawContradicts !== 'boolean') {
    throw new Error('judge JSON missing required field: contradicts');
  }
  const rawConfidence = v.confidence;
  if (typeof rawConfidence !== 'number' || !Number.isFinite(rawConfidence)) {
    throw new Error('judge JSON missing or invalid confidence');
  }
  const clampedConfidence = Math.min(1, Math.max(0, rawConfidence));
  const severity = parseSeverity(v.severity);
  const axisRaw = typeof v.axis === 'string' ? v.axis : '';
  const resolutionKind = parseResolutionKind(v.resolution_kind);

  // C1 double-enforce: contradicts:true requires confidence >= 0.7.
  let contradicts = rawContradicts;
  if (contradicts && clampedConfidence < 0.7) {
    contradicts = false;
  }

  return {
    contradicts,
    severity,
    axis: contradicts ? axisRaw : '',
    confidence: clampedConfidence,
    resolution_kind: contradicts ? (resolutionKind ?? 'manual_review') : null,
  };
}

/**
 * Build the judge prompt. Query-conditioned (Codex fix) — the model sees
 * what the user actually asked so it can decide whether the disagreement is
 * relevant to the query.
 *
 * Holder is shown when present (take pairs): "Garry holds X" vs "Garry
 * holds not-X" is a flip; "Alice holds X" vs "Bob holds not-X" is not.
 */
export function buildJudgePrompt(opts: {
  query: string;
  a: { slug: string; text: string; source_tier?: string; holder?: string | null };
  b: { slug: string; text: string; source_tier?: string; holder?: string | null };
  maxPairChars: number;
}): string {
  const a = truncateUtf8(opts.a.text, opts.maxPairChars);
  const b = truncateUtf8(opts.b.text, opts.maxPairChars);
  const aMeta = [opts.a.slug, opts.a.source_tier && `source-tier ${opts.a.source_tier}`, opts.a.holder && `holder ${opts.a.holder}`].filter(Boolean).join(', ');
  const bMeta = [opts.b.slug, opts.b.source_tier && `source-tier ${opts.b.source_tier}`, opts.b.holder && `holder ${opts.b.holder}`].filter(Boolean).join(', ');
  return [
    'You are a contradiction judge for a personal knowledge brain. The user',
    'ran a search and got two results back. Decide whether the two statements',
    "contradict each other in a way that would mislead someone trying to",
    "answer the user's query.",
    '',
    `User's query: ${opts.query}`,
    '',
    `Statement A (${aMeta}):`,
    a,
    '',
    `Statement B (${bMeta}):`,
    b,
    '',
    'Rules:',
    '- Different timeframes for the same dynamic property are NOT contradictions',
    '  (e.g., MRR was $50K in 2024 vs $2M in 2026 — both true at their time).',
    '- Different timeframes for a static identity claim MAY BE a contradiction',
    '  (e.g., "Alice is CFO of Acme" vs "Alice left Acme" if dates suggest one',
    '  supersedes the other).',
    '- Subjective opinions held at different times by the SAME holder may be',
    '  a contradiction (a flip). Opinions held by DIFFERENT holders are not.',
    '- Different aspects of the same entity are NOT contradictions.',
    "- Incidental disagreements unrelated to the user's query do NOT count.",
    '  Judge only on claims relevant to what the user asked.',
    '',
    'Reply with JSON ONLY:',
    '{',
    '  "contradicts": true | false,',
    '  "severity": "low" | "medium" | "high",',
    '  "axis": "<one-line: what they disagree about, or empty>",',
    '  "confidence": 0.0..1.0,',
    '  "resolution_kind": "takes_supersede" | "dream_synthesize" | "takes_mark_debate" | "manual_review" | null',
    '}',
    '',
    'Severity rubric:',
    '- low: naming/format differences (Alice Smith vs A. Smith).',
    '- medium: factual values that may be stale (revenue, headcount).',
    '- high: identity / structural claims (founder/CEO/CFO role, status).',
    '',
    'Reply contradicts:true only when confidence >= 0.7.',
  ].join('\n');
}

/** Detect refusal-shaped responses. Caller maps to judge_errors.refusal. */
function isRefusalResponse(result: ChatResult): boolean {
  if (result.stopReason === 'refusal') return true;
  const txt = result.text?.toLowerCase?.() ?? '';
  return (
    txt.includes("i can't help") ||
    txt.includes('i cannot help') ||
    txt.includes('refuse to answer')
  );
}

/**
 * Main entry. Calls the gateway, parses JSON, normalizes the verdict with
 * C1 confidence enforcement. Throws on parse / refusal / transport errors;
 * caller wraps in try/catch and records via JudgeErrorCollector.
 */
export async function judgeContradiction(input: JudgeInput): Promise<JudgeOutput> {
  const maxPairChars = input.maxPairChars ?? DEFAULT_MAX_PAIR_CHARS;
  const prompt = buildJudgePrompt({
    query: input.query,
    a: input.a,
    b: input.b,
    maxPairChars,
  });
  const callFn = input.chatFn ?? chat;
  const result = await callFn({
    model: input.model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 200,
    abortSignal: input.abortSignal,
  });
  if (isRefusalResponse(result)) {
    throw new Error('judge refused to answer');
  }
  const raw = parseJudgeJSON(result.text);
  const verdict = normalizeVerdict(raw);
  return {
    verdict,
    usage: {
      inputTokens: result.usage.input_tokens ?? 0,
      outputTokens: result.usage.output_tokens ?? 0,
    },
  };
}
