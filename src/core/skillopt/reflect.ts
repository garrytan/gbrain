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
 *
 * Fail loud (#5584): every reflect call yields edits, a deliberate empty
 * `{"edits": []}`, or EXACTLY ONE error, by precedence:
 *   1. stopReason 'length'          -> reflect_<mode>_truncated (edits dropped)
 *   2. empty / whitespace reply     -> reflect_<mode>_empty_reply
 *   3. no parseable edits array     -> reflect_<mode>_no_parseable_edits
 *   4. every proposed edit invalid  -> reflect_<mode>_invalid_edits
 * Partial drops push nothing and are counted in `invalidEditsDropped`.
 *
 * Context budgeting: the full skill body is sent when it fits the optimizer's
 * window (3 chars/token after the output cap and the bounded non-body
 * sections); otherwise it is truncated WITH an explicit disclosure in the
 * prompt and `skillBodyTruncated` on the result. Unknown window -> 120k chars.
 */

import { chat as gatewayChat, defaultMaxOutputTokens, type ChatResult } from '../ai/gateway.ts';
import { resolveChatContextTokens } from '../ai/model-resolver.ts';
import { isSkilloptMustAbort } from './must-abort.ts';
import { SKILLOPT_PURPOSE, type EditOp, type ScoredRollout, type Judge, type RuleCheck } from './types.ts';
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
  /** Output cap for every optimizer call. Default `defaultMaxOutputTokens(optimizerModel)`. */
  maxTokens?: number;
  /**
   * Ablation (cat31 config B): 'failure-only' skips the D7 success-reflect call
   * entirely (even when successes are present). Default 'both' (paper-faithful).
   */
  reflectMode?: 'both' | 'failure-only';
  /** Test seam — substitute for gateway.chat. */
  chatFn?: typeof gatewayChat;
  abortSignal?: AbortSignal;
}

export interface SkillBodyTruncation {
  sent_chars: number;
  total_chars: number;
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
  /** At most one error per reflect call (for audit + receipt). */
  errors: string[];
  /** Reflect calls attempted (a context_too_small refusal counts; it is a call that could not be made). */
  calls: number;
  /** Calls whose reply was usable: edits or a deliberate empty. */
  usableReplies: number;
  /** Malformed edits dropped from otherwise-usable replies. */
  invalidEditsDropped: number;
  /** Set when the skill body had to be truncated to fit the optimizer window. */
  skillBodyTruncated?: SkillBodyTruncation;
}

type ReflectAccumulator = Omit<ReflectResult, 'failureEdits' | 'successEdits'>;

const emptyUsage = (): ReflectResult['usage'] =>
  ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 });

function addUsage(into: ReflectResult['usage'], from: ChatResult['usage']): void {
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  into.cache_read_tokens += from.cache_read_tokens;
  into.cache_creation_tokens += from.cache_creation_tokens;
}

/**
 * D7: fire two reflect calls (failures + successes). Empty batches skip
 * their reflect call (no point asking for edits without data).
 */
export async function runReflect(opts: ReflectOpts): Promise<ReflectResult> {
  const acc: ReflectAccumulator = { usage: emptyUsage(), errors: [], calls: 0, usableReplies: 0, invalidEditsDropped: 0 };

  const failureEdits = opts.failures.length > 0
    ? await callReflect('failure', opts, FAILURE_REFLECT_SYSTEM, opts.failures, acc)
    : [];
  // Ablation: 'failure-only' skips the success-reflect call regardless of data.
  const successEdits = opts.reflectMode !== 'failure-only' && opts.successes.length > 0
    ? await callReflect('success', opts, SUCCESS_REFLECT_SYSTEM, opts.successes, acc)
    : [];

  return { failureEdits, successEdits, ...acc };
}

const ONE_SHOT_REWRITE_SYSTEM = `You are SkillOpt's optimizer in ONE-SHOT REWRITE mode. Given a SKILL document body and a batch of agent rollouts (some failing, some succeeding), rewrite the ENTIRE body ONCE to make the agent succeed more often.

Output ONLY the rewritten skill body as markdown — no JSON, no code fence, no preamble, no commentary. Do NOT include or modify the YAML frontmatter (it is not shown to you and is out of scope). Keep the same general structure and headings unless a change clearly helps; be surgical, not verbose.`;

export interface OneShotRewriteResult {
  /** The rewritten skill body (frontmatter NOT included — caller re-attaches). */
  newBody: string;
  usage: ReflectResult['usage'];
  /** Set when the rewrite errored or was refused (caller treats as "no change" and surfaces it). */
  error?: string;
}

/** Output headroom one-shot needs beyond the rewritten body itself. */
const ONE_SHOT_OUTPUT_SLACK_TOKENS = 1024;

/**
 * Ablation baseline (cat31 config C): a single LLM rewrite of the whole skill
 * body, no optimization loop and no validation gate. A real method (one-shot
 * prompt rewrite) — the honest "do you even need the loop?" comparison. Runs
 * through the SAME apply/score path as the loop (the orchestrator feeds the
 * returned body to the gate), so the comparison is apples-to-apples.
 *
 * Refuses (no chat call, nothing promoted) when the body cannot be sent whole
 * or its rewrite cannot fit the output cap; a length-stopped reply is never
 * returned as a body — it would be promoted as a shorter skill.
 */
export async function runOneShotRewrite(opts: ReflectOpts): Promise<OneShotRewriteResult> {
  const usage = emptyUsage();
  const chat = opts.chatFn ?? gatewayChat;
  const maxTokens = opts.maxTokens ?? defaultMaxOutputTokens(opts.optimizerModel);
  const total = opts.skillBodyText.length;
  const plan = planReflectPrompt(opts, ONE_SHOT_REWRITE_SYSTEM, [...opts.failures, ...opts.successes], maxTokens);
  if (plan.kind !== 'ok' || plan.truncated) {
    const sent = plan.kind === 'ok' && plan.truncated ? plan.truncated.sent_chars : 0;
    return { newBody: '', usage, error: `one_shot_rewrite_body_truncated: sent ${sent} of ${total} chars` };
  }
  const need = Math.ceil(total / CHARS_PER_TOKEN) + ONE_SHOT_OUTPUT_SLACK_TOKENS;
  if (need > maxTokens) {
    return { newBody: '', usage, error: `one_shot_rewrite_output_cap_too_small: need ~${need} tokens, cap ${maxTokens}; set skillopt.reflect_max_tokens` };
  }
  let result: ChatResult;
  try {
    result = await chat({
      model: opts.optimizerModel,
      system: ONE_SHOT_REWRITE_SYSTEM,
      messages: [{ role: 'user', content: plan.userMsg }],
      maxTokens,
      cacheSystem: true,
      abortSignal: opts.abortSignal,
      purpose: SKILLOPT_PURPOSE.optimizer,
    });
  } catch (err) {
    if (isSkilloptMustAbort(err)) throw err;
    return { newBody: '', usage, error: `one_shot_rewrite_failed: ${errMsg(err)}` };
  }
  addUsage(usage, result.usage);
  if (result.stopReason === 'length') {
    return { newBody: '', usage, error: `one_shot_rewrite_truncated: ${result.usage.output_tokens} output tokens, max_tokens=${maxTokens}` };
  }
  // Unwrap a fence ONLY when the model wrapped the ENTIRE response in one
  // (anchored ^```...```$). A non-anchored match would truncate a legitimate
  // body that contains a code sample down to just that first fenced block.
  const trimmed = result.text.trim();
  const wholeFence = trimmed.match(/^```(?:markdown)?\s*\n([\s\S]*)\n```$/i);
  const newBody = (wholeFence ? wholeFence[1]! : trimmed).trim();
  if (!newBody) return { newBody: '', usage, error: `one_shot_rewrite_empty_reply: stop=${result.stopReason}` };
  return { newBody, usage };
}

async function callReflect(
  mode: 'failure' | 'success',
  opts: ReflectOpts,
  system: string,
  scoredRollouts: ScoredRollout[],
  acc: ReflectAccumulator,
): Promise<EditOp[]> {
  const chat = opts.chatFn ?? gatewayChat;
  const maxTokens = opts.maxTokens ?? defaultMaxOutputTokens(opts.optimizerModel);
  acc.calls += 1;
  const plan = planReflectPrompt(opts, system, scoredRollouts, maxTokens);
  if (plan.kind === 'too_small') {
    acc.errors.push(`reflect_${mode}_context_too_small: need ${plan.need}, window ${plan.window}`);
    return [];
  }
  if (plan.truncated) acc.skillBodyTruncated = plan.truncated;
  let result: ChatResult;
  try {
    result = await chat({
      model: opts.optimizerModel,
      system,
      messages: [{ role: 'user', content: plan.userMsg }],
      maxTokens,
      cacheSystem: true, // D11
      abortSignal: opts.abortSignal,
      purpose: SKILLOPT_PURPOSE.optimizer,
    });
  } catch (err) {
    if (isSkilloptMustAbort(err)) throw err;
    const kind = isContextOverflowError(err) ? 'context_overflow' : 'failed';
    acc.errors.push(`reflect_${mode}_${kind}: ${errMsg(err)}`);
    return [];
  }
  addUsage(acc.usage, result.usage);
  const classified = classifyEditsReply(result, maxTokens);
  if ('error' in classified) {
    acc.errors.push(`reflect_${mode}_${classified.error}`);
    return [];
  }
  acc.usableReplies += 1;
  acc.invalidEditsDropped += classified.dropped;
  return classified.edits;
}

function classifyEditsReply(
  result: Pick<ChatResult, 'text' | 'stopReason' | 'usage'>,
  maxTokens: number,
): { edits: EditOp[]; dropped: number } | { error: string } {
  const outTokens = result.usage.output_tokens;
  if (result.stopReason === 'length') return { error: `truncated: ${outTokens} output tokens, max_tokens=${maxTokens}` };
  if (!result.text.trim()) return { error: `empty_reply: stop=${result.stopReason}` };
  const raw = extractEditsArray(result.text);
  if (raw === null) return { error: `no_parseable_edits: ${outTokens} output tokens, stop=${result.stopReason}` };
  const edits = validateEdits(raw);
  if (raw.length > 0 && edits.length === 0) return { error: `invalid_edits: ${raw.length} proposed, 0 valid` };
  return { edits, dropped: raw.length - edits.length };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Provider context-length rejections (Anthropic "prompt is too long", OpenAI context_length_exceeded), through wrapped causes. */
function isContextOverflowError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && cur != null; depth++) {
    const msgs = [(cur as { message?: unknown }).message, (cur as { error?: { message?: unknown } }).error?.message];
    if (msgs.some((m) => typeof m === 'string' && /prompt is too long|context[_ ]length|maximum context|context window/i.test(m))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Body budget when the optimizer's context window is unknown. */
const UNKNOWN_CONTEXT_BODY_CHARS = 120_000;
/** Conservative chars-per-token for budgeting the prompt against the window. */
const CHARS_PER_TOKEN = 3;
const MAX_ROLLOUT_OUTPUT_CHARS = 2000;
const MAX_REJECTED_CHARS = 8000;
const MAX_CRITERIA_CHARS = 8000;

type PromptPlan =
  | { kind: 'ok'; userMsg: string; truncated?: SkillBodyTruncation }
  | { kind: 'too_small'; need: number; window: number };

function optimizerContextTokens(model: string): number | undefined {
  try {
    return resolveChatContextTokens(model);
  } catch {
    return undefined;
  }
}

function planReflectPrompt(
  opts: ReflectOpts,
  system: string,
  rollouts: ScoredRollout[],
  outputCap: number,
): PromptPlan {
  const body = opts.skillBodyText;
  const build = (b: string) => buildReflectUserMessage(b, rollouts, opts.rejected, opts.criteria);
  const window = optimizerContextTokens(opts.optimizerModel);
  let budgetChars = UNKNOWN_CONTEXT_BODY_CHARS;
  if (window !== undefined) {
    const need = Math.ceil((system.length + build('').length) / CHARS_PER_TOKEN) + outputCap;
    if (need > window) return { kind: 'too_small', need, window };
    budgetChars = (window - need) * CHARS_PER_TOKEN;
  }
  if (body.length <= budgetChars) return { kind: 'ok', userMsg: build(body) };
  const sent = body.slice(0, budgetChars);
  return {
    kind: 'ok',
    userMsg: build(`${sent}\n(skill body truncated: sent ${sent.length} of ${body.length} chars)`),
    truncated: { sent_chars: sent.length, total_chars: body.length },
  };
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
${truncate(r.trajectory.final_text, MAX_ROLLOUT_OUTPUT_CHARS)}
${r.rationale ? `JUDGE RATIONALE: ${r.rationale}` : ''}`;
  }).join('\n\n');

  const rejectedSummary = rejected.length > 0
    ? `\n\n--- PREVIOUSLY REJECTED EDITS (do not re-propose) ---\n${truncate(rejected.slice(0, 20).map((r) => `- ${r.reason}: ${JSON.stringify(r.edits)}`).join('\n'), MAX_REJECTED_CHARS)}`
    : '';

  const criteriaBlock = criteria
    ? `\n\nSUCCESS CRITERIA (exactly how the agent's output is scored — make the agent satisfy these through genuine, high-quality content, never empty keywords):\n${truncate(criteria, MAX_CRITERIA_CHARS)}`
    : '';

  return `CURRENT SKILL BODY:
${skillBody}${criteriaBlock}

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
 * are found. `callReflect` classifies the same extraction (a fenced
 * `{"edits": []}` is a deliberate empty, not a parse failure).
 *
 * EXPORTED so reflect.test.ts can pin the parser independently of the chat
 * transport. Pre-v0.42.0.1 this lived behind a `parseJudgeJson` early-return
 * guard that always failed (judge-JSON checks for a `score` key, not `edits`),
 * making every optimizer call silently produce zero edits. The bug survived
 * v0.42.0.0 because no unit test exercised this parser; the orchestrator's
 * `successes/failures: []` hardcoding masked it end-to-end too.
 */
export function parseEditsResponse(raw: string): EditOp[] {
  return validateEdits(extractEditsArray(raw) ?? []);
}

/** The raw `edits` array from optimizer output, or null when none is recoverable. */
function extractEditsArray(raw: string): unknown[] | null {
  try {
    // Strip fences first.
    const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
    const cleaned = (fenced ? fenced[1]! : raw).trim();
    // Try direct parse.
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === 'object' && Array.isArray((direct as { edits?: unknown }).edits)) {
      return (direct as { edits: unknown[] }).edits;
    }
  } catch { /* try next strategy */ }
  // Fallback: extract first {...} substring.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { edits?: unknown }).edits)) {
      return (parsed as { edits: unknown[] }).edits;
    }
  } catch { /* fall through */ }
  return null;
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
