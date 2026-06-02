/**
 * SkillOpt reflect: ask the optimizer model to propose edits to SKILL.md
 * based on a batch of scored rollouts.
 *
 * D7: TWO reflect calls per step — one for failures, one for successes.
 * Paper-faithful: each call uses its own rubric prompt so attention isn't
 * conflated between "what went wrong" and "what went right" analyses.
 *
 * D11: optimizer system prompt is cached via cacheSystem=true (stable
 * across all reflect calls in a run; ~$0.30/run savings).
 *
 * The reflect call also receives the rejected-edit buffer as anti-bias
 * context so the optimizer doesn't re-propose previously-failing edits.
 */

import { chat as gatewayChat } from '../ai/gateway.ts';
import type { EditOp, ScoredRollout } from './types.ts';
import type { RejectedEntry } from './rejected-buffer.ts';

const FAILURE_REFLECT_SYSTEM = `You are SkillOpt's optimizer. You analyze AGENT FAILURE TRAJECTORIES and propose specific edits to a SKILL document so the agent does better next time.

Output ONLY a single JSON object on one or more lines:
{"edits": [{"op": "add|replace|delete", ...}, ...]}

Edit ops:
  add:      {"op": "add", "anchor": "<exact heading text>", "content": "<new markdown>", "reason": "<one sentence>"}
  replace:  {"op": "replace", "target": "<exact text to find>", "replacement": "<new text>", "reason": "<one sentence>"}
  delete:   {"op": "delete", "target": "<exact text to remove>", "reason": "<one sentence>"}

Rules:
- Each edit MUST address a SPECIFIC failure pattern you observed.
- anchor / target MUST be uniquely identifiable in the skill body (exact match).
- Do NOT propose edits already in the rejected-edit history — those were tried and didn't help.
- Be SURGICAL. Small targeted edits outperform large rewrites.
- Do NOT modify the YAML frontmatter (triggers, brain_first, etc.) — that's out of scope.
- Output at MOST 8 edits. The orchestrator's LR budget will rank-and-clip further.`;

const SUCCESS_REFLECT_SYSTEM = `You are SkillOpt's optimizer. You analyze AGENT SUCCESS TRAJECTORIES and propose specific edits to a SKILL document so the agent CONSISTENTLY does what worked here.

Output format and rules are identical to the failure-reflect mode — same {edits: [...]} shape.

When successes are present, look for: which rules were FOLLOWED to produce success, which rules could be MADE EXPLICIT (not yet stated, but exemplified), which anti-patterns the agent successfully AVOIDED that should be stated.

Be SURGICAL. Don't restate things that are already in the skill. Don't modify frontmatter.`;

export interface ReflectOpts {
  skillBodyText: string;
  /** Successful rollouts (score >= 0.5). */
  successes: ScoredRollout[];
  /** Failed rollouts (score < 0.5). */
  failures: ScoredRollout[];
  /** Rejected-edit buffer for anti-bias context. */
  rejected: readonly RejectedEntry[];
  optimizerModel: string;
  /** Test seam — substitute for gateway.chat. */
  chatFn?: typeof gatewayChat;
  abortSignal?: AbortSignal;
}

export interface ReflectResult {
  /** Edits proposed from FAILURE analysis. */
  failureEdits: EditOp[];
  /** Edits proposed from SUCCESS analysis. */
  successEdits: EditOp[];
  /** Token usage across both calls (for cost tracking). */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
  /** Any per-call errors (for audit). */
  errors: string[];
}

/**
 * D7: fire two reflect calls (failures + successes). Empty batches skip
 * their reflect call (no point asking for edits without data).
 */
export async function runReflect(opts: ReflectOpts): Promise<ReflectResult> {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const errors: string[] = [];

  const failureEdits = opts.failures.length > 0
    ? await callReflect('failure', opts, FAILURE_REFLECT_SYSTEM, opts.failures, usage, errors)
    : [];
  const successEdits = opts.successes.length > 0
    ? await callReflect('success', opts, SUCCESS_REFLECT_SYSTEM, opts.successes, usage, errors)
    : [];

  return { failureEdits, successEdits, usage, errors };
}

async function callReflect(
  mode: 'failure' | 'success',
  opts: ReflectOpts,
  system: string,
  scoredRollouts: ScoredRollout[],
  cumUsage: ReflectResult['usage'],
  errors: string[],
): Promise<EditOp[]> {
  const chat = opts.chatFn ?? gatewayChat;
  const userMsg = buildReflectUserMessage(opts.skillBodyText, scoredRollouts, opts.rejected);
  try {
    const result = await chat({
      model: opts.optimizerModel,
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 2048,
      cacheSystem: true, // D11
      abortSignal: opts.abortSignal,
    });
    cumUsage.input_tokens += result.usage.input_tokens;
    cumUsage.output_tokens += result.usage.output_tokens;
    cumUsage.cache_read_tokens += result.usage.cache_read_tokens;
    cumUsage.cache_creation_tokens += result.usage.cache_creation_tokens;
    return parseEditsResponse(result.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`reflect_${mode}_failed: ${msg}`);
    return [];
  }
}

function buildReflectUserMessage(
  skillBody: string,
  rollouts: ScoredRollout[],
  rejected: readonly RejectedEntry[],
): string {
  const trajectoryBlocks = rollouts.map((r, i) => {
    const tcSummary = r.trajectory.tool_calls
      .map((tc) => `  - ${tc.name}${tc.failed ? ' [FAILED]' : ''}`)
      .join('\n');
    return `--- ROLLOUT ${i + 1} (score=${r.score.toFixed(2)}) ---
TASK: ${r.trajectory.task}
TOOL CALLS:
${tcSummary || '  (none)'}
OUTPUT:
${truncate(r.trajectory.final_text, 2000)}
${r.rationale ? `JUDGE RATIONALE: ${r.rationale}` : ''}`;
  }).join('\n\n');

  const rejectedSummary = rejected.length > 0
    ? `\n\n--- PREVIOUSLY REJECTED EDITS (do not re-propose) ---\n${rejected.slice(0, 20).map((r) => `- ${r.reason}: ${JSON.stringify(r.edits)}`).join('\n')}`
    : '';

  return `CURRENT SKILL BODY:
${truncate(skillBody, 5000)}

OBSERVED ROLLOUTS:
${trajectoryBlocks}${rejectedSummary}

Propose edits to improve the skill. Output the {edits: [...]} JSON only.`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n...(truncated, ${s.length - max} more chars)` : s;
}

/**
 * Parse `{edits: [...]}` from optimizer output. Tolerates ```fenced blocks```,
 * trailing commas, prose-wrapped JSON. Returns [] when no recoverable edits
 * are found (caller treats as "this reflect call produced no usable edits"
 * — same effect as the optimizer returning {edits: []}).
 *
 * EXPORTED so reflect.test.ts can pin the parser independently of the chat
 * transport. Pre-v0.42.0.1 this lived behind a `parseJudgeJson` early-return
 * guard that always failed (judge-JSON checks for a `score` key, not `edits`),
 * making every optimizer call silently produce zero edits. The bug survived
 * v0.42.0.0 because no unit test exercised this parser; the orchestrator's
 * `successes/failures: []` hardcoding masked it end-to-end too.
 */
export function parseEditsResponse(raw: string): EditOp[] {
  return tryExtractEdits(raw);
}

function tryExtractEdits(raw: string): EditOp[] {
  try {
    // Strip fences first.
    const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
    const cleaned = (fenced ? fenced[1]! : raw).trim();
    // Try direct parse.
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === 'object' && Array.isArray((direct as { edits?: unknown }).edits)) {
      return validateEdits((direct as { edits: unknown[] }).edits);
    }
  } catch { /* try next strategy */ }
  // Fallback: extract first {...} substring.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { edits?: unknown }).edits)) {
      return validateEdits((parsed as { edits: unknown[] }).edits);
    }
  } catch { /* fall through */ }
  return [];
}

function validateEdits(raw: unknown[]): EditOp[] {
  const out: EditOp[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (o.op === 'add' && typeof o.anchor === 'string' && typeof o.content === 'string') {
      out.push({ op: 'add', anchor: o.anchor, content: o.content, reason: typeof o.reason === 'string' ? o.reason : undefined });
    } else if (o.op === 'replace' && typeof o.target === 'string' && typeof o.replacement === 'string') {
      out.push({ op: 'replace', target: o.target, replacement: o.replacement, reason: typeof o.reason === 'string' ? o.reason : undefined });
    } else if (o.op === 'delete' && typeof o.target === 'string') {
      out.push({ op: 'delete', target: o.target, reason: typeof o.reason === 'string' ? o.reason : undefined });
    }
  }
  return out;
}
