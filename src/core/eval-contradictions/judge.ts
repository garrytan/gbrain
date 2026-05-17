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
import { parseSeverity, defaultSeverityForVerdict } from './severity-classify.ts';
import type { JudgeVerdict, ResolutionKind, Verdict } from './types.ts';

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
  /**
   * Statement A: slug + text + optional source-tier + holder (if take) +
   * optional effective_date (Lane A1). When effective_date is null/undefined
   * the prompt shows `(date unknown)` for that side; the judge classifies
   * based on chunk text alone, same as the v1 prompt did.
   */
  a: {
    slug: string;
    text: string;
    source_tier?: string;
    holder?: string | null;
    effective_date?: string | null;
  };
  b: {
    slug: string;
    text: string;
    source_tier?: string;
    holder?: string | null;
    effective_date?: string | null;
  };
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
 * 'manual_review' (the safe, no-action option for contradictions; new verdicts
 * route through auto-supersession.ts when resolution_kind is null on input).
 *
 * v0.34 / Lane A2: added temporal_supersede, flag_for_review, log_timeline_change.
 */
function parseResolutionKind(value: unknown): ResolutionKind | null {
  if (
    value === 'takes_supersede' ||
    value === 'dream_synthesize' ||
    value === 'takes_mark_debate' ||
    value === 'manual_review' ||
    value === 'temporal_supersede' ||
    value === 'flag_for_review' ||
    value === 'log_timeline_change'
  ) {
    return value;
  }
  return null;
}

const VALID_VERDICTS: ReadonlySet<Verdict> = new Set([
  'no_contradiction',
  'contradiction',
  'temporal_supersession',
  'temporal_regression',
  'temporal_evolution',
  'negation_artifact',
]);

/** Validate a verdict string from JSON; throws on missing/invalid so caller maps to parse_fail. */
export function parseVerdict(value: unknown): Verdict {
  if (typeof value !== 'string' || !VALID_VERDICTS.has(value as Verdict)) {
    throw new Error(`judge JSON missing or invalid verdict: ${JSON.stringify(value)}`);
  }
  return value as Verdict;
}

/**
 * Validate the raw parsed JSON against the JudgeVerdict shape. Throws on
 * fundamentally-broken shape (missing verdict/confidence) so the caller
 * counts it under judge_errors.parse_fail rather than fabricating a verdict.
 *
 * v0.34 / Lane A2: parses the new `verdict: Verdict` enum field instead of
 * the v1 `contradicts: boolean`. PROMPT_VERSION = '2' (bumped in A1) means
 * the persistent cache won't return v1-shaped rows for these calls.
 *
 * C1 enforcement: `verdict === 'contradiction'` with confidence < 0.7 is
 * downgraded to `'no_contradiction'` (belt-and-suspenders against models
 * ignoring the prompt rule). The 5 non-contradiction verdicts do NOT have a
 * confidence floor — they're informational classifications, not error flags.
 */
export function normalizeVerdict(raw: unknown): JudgeVerdict {
  if (!raw || typeof raw !== 'object') {
    throw new Error('judge JSON missing or not an object');
  }
  const v = raw as Record<string, unknown>;
  // Parse verdict first so we can throw a useful error before checking other
  // fields. Old v1-shaped responses (`contradicts: true/false` without
  // `verdict`) will throw here and the caller maps it to parse_fail — correct
  // semantics because the prompt now asks for verdict explicitly.
  let verdict = parseVerdict(v.verdict);
  const rawConfidence = v.confidence;
  if (typeof rawConfidence !== 'number' || !Number.isFinite(rawConfidence)) {
    throw new Error('judge JSON missing or invalid confidence');
  }
  const clampedConfidence = Math.min(1, Math.max(0, rawConfidence));
  const axisRaw = typeof v.axis === 'string' ? v.axis : '';
  const resolutionKind = parseResolutionKind(v.resolution_kind);

  // C1 double-enforce: only `verdict === 'contradiction'` carries the
  // confidence floor. Downgrade to no_contradiction below the threshold.
  if (verdict === 'contradiction' && clampedConfidence < 0.7) {
    verdict = 'no_contradiction';
  }

  // Severity: judge can set it; if invalid, fall back to the default for the
  // verdict (D7 map: temporal_supersession→info, temporal_regression→high, ...).
  // parseSeverity coerces unknown strings to 'low' historically, but now we
  // route through defaultSeverityForVerdict instead so each verdict gets a
  // meaningful default.
  const severity = parseSeverity(v.severity, defaultSeverityForVerdict(verdict));
  const isFinding = verdict !== 'no_contradiction';

  // Only `contradiction` keeps the v1 fallback to 'manual_review' when the
  // judge omits a resolution_kind. The new verdicts pass through whatever the
  // judge said (or null) and auto-supersession.ts picks the kind based on
  // verdict semantics.
  let normalizedResolutionKind: ResolutionKind | null;
  if (verdict === 'contradiction') {
    normalizedResolutionKind = resolutionKind ?? 'manual_review';
  } else if (isFinding) {
    normalizedResolutionKind = resolutionKind ?? null;
  } else {
    normalizedResolutionKind = null;
  }

  return {
    verdict,
    severity,
    axis: isFinding ? axisRaw : '',
    confidence: clampedConfidence,
    resolution_kind: normalizedResolutionKind,
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
  a: {
    slug: string;
    text: string;
    source_tier?: string;
    holder?: string | null;
    effective_date?: string | null;
  };
  b: {
    slug: string;
    text: string;
    source_tier?: string;
    holder?: string | null;
    effective_date?: string | null;
  };
  maxPairChars: number;
}): string {
  const a = truncateUtf8(opts.a.text, opts.maxPairChars);
  const b = truncateUtf8(opts.b.text, opts.maxPairChars);
  const aMeta = [opts.a.slug, opts.a.source_tier && `source-tier ${opts.a.source_tier}`, opts.a.holder && `holder ${opts.a.holder}`].filter(Boolean).join(', ');
  const bMeta = [opts.b.slug, opts.b.source_tier && `source-tier ${opts.b.source_tier}`, opts.b.holder && `holder ${opts.b.holder}`].filter(Boolean).join(', ');
  // Lane A1: emit the page-level effective_date on its own line so the judge
  // can reason temporally. `(date unknown)` keeps the v1 fallback behavior
  // when the page has no effective_date — judge classifies on text alone.
  const aDateTag = opts.a.effective_date ? `(from: ${opts.a.effective_date})` : '(date unknown)';
  const bDateTag = opts.b.effective_date ? `(from: ${opts.b.effective_date})` : '(date unknown)';
  return [
    'You are a contradiction judge for a personal knowledge brain. The user',
    'ran a search and got two results back. Decide whether the two statements',
    "contradict each other in a way that would mislead someone trying to",
    "answer the user's query.",
    '',
    `User's query: ${opts.query}`,
    '',
    `Statement A ${aDateTag} (${aMeta}):`,
    a,
    '',
    `Statement B ${bDateTag} (${bMeta}):`,
    b,
    '',
    'Rules:',
    '- The (from: YYYY-MM-DD) tag is the page-level effective date. Use it to',
    '  classify what kind of difference this is, not just whether it exists.',
    '  (date unknown) means the page has no temporal anchor — judge on text',
    '  alone for that side.',
    '- Pick exactly one verdict from the six values below.',
    '- Use temporal_supersession when the newer-dated claim updates or replaces',
    '  the older one (role change, status change). Not an error.',
    '- Use temporal_regression when a metric or status went BACKWARDS over time',
    '  (e.g., MRR dropped from $200K to $150K). This is a signal worth flagging.',
    '- Use temporal_evolution for legitimate change over time that is neither',
    '  supersession nor regression (e.g., evolving narrative, multi-step decision).',
    '- Use negation_artifact when one side contains an explicit negation that',
    '  the surface tokens make look like a positive claim (e.g., "NOT X" parsed',
    '  as "X"). The data is correct; the apparent conflict is a parsing artifact.',
    '- Use contradiction ONLY for genuinely conflicting claims at the same point',
    '  in time, where the dates do not explain the difference.',
    '- Use no_contradiction when the statements are compatible.',
    '',
    '- Subjective opinions held at different times by the SAME holder may be',
    '  a contradiction (a flip). Opinions held by DIFFERENT holders are not.',
    '- Different aspects of the same entity are not contradictions.',
    "- Incidental disagreements unrelated to the user's query do not count.",
    '  Judge only on claims relevant to what the user asked.',
    '',
    'Reply with JSON ONLY:',
    '{',
    '  "verdict": "no_contradiction" | "contradiction" | "temporal_supersession" | "temporal_regression" | "temporal_evolution" | "negation_artifact",',
    '  "severity": "info" | "low" | "medium" | "high",',
    '  "axis": "<one-line: what they disagree about, or empty>",',
    '  "confidence": 0.0..1.0,',
    '  "resolution_kind": "takes_supersede" | "dream_synthesize" | "takes_mark_debate" | "manual_review" | "temporal_supersede" | "flag_for_review" | "log_timeline_change" | null',
    '}',
    '',
    'Severity rubric:',
    '- info: temporal_supersession and temporal_evolution (not errors; informational).',
    '- low: naming/format differences (Alice Smith vs A. Smith); negation artifacts.',
    '- medium: factual values that may be stale (revenue, headcount).',
    '- high: identity / structural claims (founder/CEO/CFO role); temporal_regression.',
    '',
    'Reply verdict:contradiction only when confidence >= 0.7. Other verdicts have',
    'no confidence floor.',
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
  // input.a/b carry effective_date through PairMember (Lane A1); buildJudgePrompt
  // emits it on the Statement line or falls through to `(date unknown)`.
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
