/**
 * SkillOpt scoring: three judge modes (rule, llm, qrels).
 *
 * Each scorer returns a 0..1 score (1 = best). Sub-1 scores are partial
 * credit; 0 means total failure. The validation gate's median-of-3 (D12)
 * is implemented in validate-gate.ts; this module is just the
 * per-trajectory scoring primitives.
 *
 * `judge: llm` uses gateway.chat with the v0.40+ 4-strategy JSON repair
 * (parseModelJSON from cross-modal-eval). On parse failure the scorer
 * returns score=0 (pessimistic fallback) AND records the error string on
 * `ScoredRollout.judge_error` so the audit trail can surface it.
 *
 * `judge: qrels` reuses src/core/search/eval.ts IR metrics. Score is
 * nDCG@k (more discriminating than P@k for the optimization signal).
 */

import { chat as gatewayChat } from '../ai/gateway.ts';
import { ndcgAtK } from '../search/eval.ts';
import type { Judge, RuleCheck, ScoredRollout, Trajectory } from './types.ts';

/** Score a trajectory against a judge. Returns a ScoredRollout. */
export async function scoreTrajectory(
  trajectory: Trajectory,
  judge: Judge,
  opts: {
    judgeModel?: string;
    /** Test seam — substitute for gateway.chat. */
    chatFn?: typeof gatewayChat;
    /** Test seam — substitute clock for cache invalidation. */
    now?: () => Date;
  } = {},
): Promise<ScoredRollout> {
  switch (judge.kind) {
    case 'rule':
      return { trajectory, score: scoreRule(trajectory, judge.checks) };
    case 'llm':
      return scoreLlm(trajectory, judge.rubric, judge.model ?? opts.judgeModel, opts);
    case 'qrels':
      return { trajectory, score: scoreQrels(trajectory, judge.expected_slugs, judge.k) };
  }
}

// ─── Rule judge ──────────────────────────────────────────────────────────

/**
 * Score a trajectory against a list of rule checks. Returns the FRACTION
 * of checks that pass. 0 = all fail, 1 = all pass.
 */
export function scoreRule(trajectory: Trajectory, checks: RuleCheck[]): number {
  if (checks.length === 0) return 0;
  let passing = 0;
  for (const c of checks) {
    if (applyCheck(trajectory, c)) passing += 1;
  }
  return passing / checks.length;
}

function applyCheck(trajectory: Trajectory, check: RuleCheck): boolean {
  const text = trajectory.final_text;
  switch (check.op) {
    case 'contains':
      return typeof check.arg === 'string' && text.includes(check.arg);
    case 'regex': {
      if (typeof check.arg !== 'string') return false;
      try {
        return new RegExp(check.arg, 'm').test(text);
      } catch {
        return false;
      }
    }
    case 'section_present': {
      if (typeof check.arg !== 'string') return false;
      // Match the heading (any depth, plus the literal text). Trim args
      // and allow leading-# variants.
      const heading = check.arg.replace(/^#+\s*/, '').trim();
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'mi');
      return re.test(text);
    }
    case 'max_chars':
      return typeof check.arg === 'number' && text.length <= check.arg;
    case 'min_citations':
      return typeof check.arg === 'number' && countCitations(text) >= check.arg;
    case 'tool_called':
      return typeof check.arg === 'string' &&
        trajectory.tool_calls.some((tc) => tc.name === check.arg && !tc.failed);
    case 'tool_not_called':
      return typeof check.arg === 'string' &&
        !trajectory.tool_calls.some((tc) => tc.name === check.arg);
  }
}

/**
 * Count citation-like spans in the output. Recognized shapes:
 *  - Markdown links: `[text](url-or-slug)`
 *  - Brain-page references: `wiki/...`, `people/...`, `companies/...`
 *  - Footnote-style: `[N]` where N is digits.
 */
export function countCitations(text: string): number {
  const mdLinks = (text.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  const brainRefs = (text.match(/\b(?:wiki|people|companies|deals|topics|concepts|projects|writing|originals)\/[a-z0-9][a-z0-9-\/]*\b/gi) ?? []).length;
  const footnotes = (text.match(/\[\d+\]/g) ?? []).length;
  return mdLinks + brainRefs + footnotes;
}

// ─── LLM judge ───────────────────────────────────────────────────────────

const LLM_JUDGE_SYSTEM = `You are a strict, fair judge scoring an agent's output against a rubric.

Output ONLY a single JSON object on a single line:
{"score": <number 0..1>, "rationale": "<one-sentence reason>"}

No prose before or after. No code fences. No extra fields. The score MUST be a number between 0.0 and 1.0 inclusive.`;

/**
 * Parse a `{score, rationale}` JSON object from raw LLM text. Tolerates:
 *  - Leading/trailing whitespace.
 *  - Markdown code fences (```json ... ```).
 *  - Prose before or after the JSON (extracts first {...} object).
 *  - Trailing commas inside the object.
 *
 * Returns null when no recoverable object is found (caller treats as judge
 * error + pessimistic fallback score=0).
 */
export function parseJudgeJson(raw: string): { score: number | string; rationale?: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // Strip markdown fences if present.
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  const cleaned = (fenced ? fenced[1]! : raw).trim();
  // Try direct parse first.
  const direct = tryJsonParse(cleaned);
  if (direct && typeof direct === 'object' && 'score' in (direct as object)) {
    return direct as { score: number | string; rationale?: string };
  }
  // Extract first {...} substring.
  const match = cleaned.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  const obj = match[0];
  const second = tryJsonParse(obj);
  if (second && typeof second === 'object' && 'score' in (second as object)) {
    return second as { score: number | string; rationale?: string };
  }
  // Last attempt: strip trailing commas.
  const repaired = obj.replace(/,(\s*[}\]])/g, '$1');
  const third = tryJsonParse(repaired);
  if (third && typeof third === 'object' && 'score' in (third as object)) {
    return third as { score: number | string; rationale?: string };
  }
  return null;
}

function tryJsonParse(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}

async function scoreLlm(
  trajectory: Trajectory,
  rubric: string,
  judgeModel: string | undefined,
  opts: { chatFn?: typeof gatewayChat },
): Promise<ScoredRollout> {
  const chat = opts.chatFn ?? gatewayChat;
  const userMsg = `RUBRIC: ${rubric}\n\nAGENT OUTPUT:\n${trajectory.final_text}\n\nScore the output against the rubric. Reply with the JSON object only.`;
  try {
    const result = await chat({
      model: judgeModel,
      system: LLM_JUDGE_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 200,
      cacheSystem: true, // D11: judge system prompt is stable across calls.
    });
    const parsed = parseJudgeJson(result.text);
    if (!parsed) {
      return { trajectory, score: 0, judge_error: 'llm_parse_failed' };
    }
    if (!('score' in parsed)) {
      return { trajectory, score: 0, judge_error: 'llm_parse_no_score_field' };
    }
    const raw = parsed.score;
    let score = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(score)) {
      return { trajectory, score: 0, judge_error: 'llm_parse_score_not_number' };
    }
    if (score < 0) score = 0;
    if (score > 1) score = 1;
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : undefined;
    return rationale !== undefined
      ? { trajectory, score, rationale }
      : { trajectory, score };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Pessimistic fallback (D12 paper-faithful: judge failure = score 0,
    // not throw; the median-of-3 + epsilon gate handles a single error
    // gracefully, only consistent judge failure breaks the run).
    return { trajectory, score: 0, judge_error: `llm_call_failed: ${msg}` };
  }
}

// ─── Qrels judge (retrieval flavor) ───────────────────────────────────────

/**
 * Score a trajectory against expected retrieval slugs.
 *
 * Extracts the candidate slugs from the trajectory's tool calls (any
 * `search` / `query` / `get_page` / `list_pages` op output that returns
 * page rows), then computes nDCG@k against expected_slugs.
 *
 * Returns 0 when no retrieval tool was called (the skill didn't even try).
 */
export function scoreQrels(
  trajectory: Trajectory,
  expectedSlugs: string[],
  k: number,
): number {
  const candidateSlugs = extractRetrievedSlugs(trajectory);
  if (candidateSlugs.length === 0) return 0;
  // ndcgAtK expects (hits, grades:Map<slug,number>, k). All expected slugs
  // get grade 1 (binary relevance) — qrels mode is "did the skill retrieve
  // what we expected?", not "did it rank them in our preferred order."
  const grades = new Map<string, number>();
  for (const s of expectedSlugs) grades.set(s, 1);
  return ndcgAtK(candidateSlugs, grades, k);
}

/**
 * Walk the trajectory's tool calls and collect slugs from any search/query/
 * list_pages/get_page output that returns row arrays with `slug` fields.
 * Tolerant of shape variation.
 */
export function extractRetrievedSlugs(trajectory: Trajectory): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const call of trajectory.tool_calls) {
    if (!call.output || call.failed) continue;
    const slugs = pickSlugs(call.output);
    for (const slug of slugs) {
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(slug);
      }
    }
  }
  return out;
}

function pickSlugs(output: unknown): string[] {
  if (!output) return [];
  if (typeof output === 'string') {
    // Some ops return a single slug string.
    return output.includes('/') ? [output] : [];
  }
  if (Array.isArray(output)) {
    return output.flatMap(pickSlugs);
  }
  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    const out: string[] = [];
    if (typeof obj.slug === 'string') out.push(obj.slug);
    if (Array.isArray(obj.results)) out.push(...pickSlugs(obj.results));
    if (Array.isArray(obj.pages)) out.push(...pickSlugs(obj.pages));
    if (Array.isArray(obj.matches)) out.push(...pickSlugs(obj.matches));
    return out;
  }
  return [];
}
