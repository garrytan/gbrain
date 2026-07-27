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
import type { EditOp, ScoredRollout, Judge, RuleCheck } from './types.ts';
import type { RejectedEntry } from './rejected-buffer.ts';

/**
 * Render ONE rule check as a plain-English requirement the optimizer can target.
 */
function describeCheck(c: RuleCheck): string {
  switch (c.op) {
    case 'contains': return `the output must contain the exact text \`${c.arg}\``;
    case 'regex': return `the output must match the regular expression \`/${c.arg}/\``;
    case 'section_present': return `the output must include a markdown heading titled "${c.arg}" (any heading level, case-insensitive)`;
    case 'max_chars': return `the output must be at most ${c.arg} characters long`;
    case 'min_citations': return `the output must include at least ${c.arg} citation(s)`;
    case 'tool_called': return `the agent must call the \`${c.arg}\` tool at least once`;
    case 'tool_not_called': return `the agent must NOT call the \`${c.arg}\` tool`;
  }
}

/**
 * Render a Judge into the plain-English criteria the scorer rewards, so the
 * optimizer knows WHAT it is optimizing toward. Without this the optimizer only
 * sees a pass/fail score and has to reverse-engineer the target from behavior
 * alone — which fails for rule judges that require a specific structure (e.g. a
 * literal "Confidence:" line): it proposes plausible-but-off edits that never
 * satisfy the rule, the candidate scores 0, the gate rejects it, and the skill
 * never changes. Reward-hacking is defended separately by the held-out gate.
 */
export function describeJudge(judge: Judge): string {
  switch (judge.kind) {
    case 'rule': return judge.checks.map((c) => `- ${describeCheck(c)}`).join('\n');
    case 'llm': return `- the output is graded 0..1 by an LLM judge against this rubric:\n  "${judge.rubric}"`;
    case 'qrels': return `- the agent must retrieve the expected pages (scored recall@${judge.k})`;
  }
}

/**
 * Describe the DISTINCT success criteria across a set of benchmark tasks. Most
 * benchmarks use one judge shape for every task, so this collapses to a single
 * block; heterogeneous benchmarks list each distinct shape once.
 */
export function describeJudges(tasks: ReadonlyArray<{ judge: Judge }>): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const t of tasks) {
    const desc = describeJudge(t.judge);
    if (!seen.has(desc)) { seen.add(desc); blocks.push(desc); }
  }
  return blocks.join('\n');
}

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
- Output at MOST 8 edits. The orchestrator's LR budget will rank-and-clip further.
- You may be given SUCCESS CRITERIA describing exactly how the agent's output is scored. Make your edits cause the agent to SATISFY those criteria, through genuine, high-quality content (a real section with real substance, a justified confidence level) — never by inserting empty keywords. An independent held-out check rejects edits that game the score while hurting real quality.`;

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
  /**
   * Plain-English description of how the agent's output is scored (from
   * `describeJudges(benchmarkTasks)`). Threaded into the reflect prompt so the
   * optimizer targets the actual criteria instead of guessing from score alone.
   */
  criteria?: string;
  optimizerModel: string;
  /**
   * Ablation (cat31 config B): 'failure-only' skips the D7 success-reflect call
   * entirely (even when successes are present). Default 'both' (paper-faithful).
   */
  reflectMode?: 'both' | 'failure-only';
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
  // Ablation: 'failure-only' skips the success-reflect call regardless of data.
  const successEdits = opts.reflectMode !== 'failure-only' && opts.successes.length > 0
    ? await callReflect('success', opts, SUCCESS_REFLECT_SYSTEM, opts.successes, usage, errors)
    : [];

  return { failureEdits, successEdits, usage, errors };
}

const ONE_SHOT_REWRITE_SYSTEM = `You are SkillOpt's optimizer in ONE-SHOT REWRITE mode. Given a SKILL document body and a batch of agent rollouts (some failing, some succeeding), rewrite the ENTIRE body ONCE to make the agent succeed more often.

Output ONLY the rewritten skill body as markdown — no JSON, no code fence, no preamble, no commentary. Do NOT include or modify the YAML frontmatter (it is not shown to you and is out of scope). Keep the same general structure and headings unless a change clearly helps; be surgical, not verbose.`;

export interface OneShotRewriteResult {
  /** The rewritten skill body (frontmatter NOT included — caller re-attaches). */
  newBody: string;
  usage: ReflectResult['usage'];
  /** Set when the rewrite call errored (caller treats as "no change"). */
  error?: string;
}

/**
 * Ablation baseline (cat31 config C): a single LLM rewrite of the whole skill
 * body, no optimization loop and no validation gate. A real method (one-shot
 * prompt rewrite) — the honest "do you even need the loop?" comparison. Runs
 * through the SAME apply/score path as the loop (the orchestrator feeds the
 * returned body to the gate), so the comparison is apples-to-apples.
 */
export async function runOneShotRewrite(opts: ReflectOpts): Promise<OneShotRewriteResult> {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const chat = opts.chatFn ?? gatewayChat;
  const userMsg = buildReflectUserMessage(opts.skillBodyText, [...opts.failures, ...opts.successes], opts.rejected, opts.criteria);
  try {
    const result = await chat({
      model: opts.optimizerModel,
      system: ONE_SHOT_REWRITE_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 4096,
      cacheSystem: true,
      abortSignal: opts.abortSignal,
    });
    usage.input_tokens += result.usage.input_tokens;
    usage.output_tokens += result.usage.output_tokens;
    usage.cache_read_tokens += result.usage.cache_read_tokens;
    usage.cache_creation_tokens += result.usage.cache_creation_tokens;
    // Unwrap a fence ONLY when the model wrapped the ENTIRE response in one
    // (anchored ^```...```$). A non-anchored match would truncate a legitimate
    // body that contains a code sample down to just that first fenced block.
    const trimmed = result.text.trim();
    const wholeFence = trimmed.match(/^```(?:markdown)?\s*\n([\s\S]*)\n```$/i);
    const newBody = (wholeFence ? wholeFence[1]! : trimmed).trim();
    return { newBody, usage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { newBody: '', usage, error: `one_shot_rewrite_failed: ${msg}` };
  }
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
  const userMsg = buildReflectUserMessage(opts.skillBodyText, scoredRollouts, opts.rejected, opts.criteria);
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
  criteria?: string,
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

  const criteriaBlock = criteria
    ? `\n\nSUCCESS CRITERIA (exactly how the agent's output is scored — make the agent satisfy these through genuine, high-quality content, never empty keywords):\n${criteria}`
    : '';

  return `CURRENT SKILL BODY:
${truncate(skillBody, 5000)}${criteriaBlock}

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
