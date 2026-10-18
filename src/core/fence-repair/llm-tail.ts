/**
 * Tier 3 tail classification (#6377): one question to the configured chat
 * model about an unclosed fence whose trailing lines contain a pipe, so the
 * structural rules cannot tell table rows from prose.
 *
 * What the model sees: the fence kind and section, the begin marker line,
 * the header, every row as written, and the trailing lines from the last
 * row to the end of the section. Never the rest of the page, never tools.
 *
 * What it must return: one JSON object `{"tail": "prose" | "rows" |
 * "unsure"}` and nothing else (a single wrapping code fence is tolerated).
 * `prose`: the trailing lines are ordinary page text, so the fence ends
 * after its last row; `rows`: some trailing line is a table row written
 * without pipes or with a broken shape, so closing after the last row would
 * leave rows outside the fence; `unsure` or the single word HOLD: a person
 * decides. Failure classes are the row prompt's (`llm_unavailable`,
 * `llm_empty`, `llm_refused`, `llm_malformed`, `llm_truncated`,
 * `llm_declined`).
 *
 * What the answer does is decided by the caller (`repair-tiers.ts`): a
 * `prose` tail on a private page lets Tier 1 close the fence; on a
 * world-visible page it records `tail_exposure_approval`, because the close
 * would show those lines to readers of the page and only a hash-bound apply
 * may do that. `rows` and `unsure` record `unclosed_ambiguous_tail`. Pure
 * helpers do no I/O; `callTailClassifier` is the one gateway call.
 */
import { chat, isThinkingModel, THINKING_MODEL_MAX_OUTPUT_TOKENS, type ChatMessage, type ChatResult } from '../ai/gateway.ts';
import { thinkingOffControl, thinkingOffMaxOutputTokens } from '../ai/thinking-off.ts';
import { extractRawRows, primaryFence } from './raw-rows.ts';
import { sectionsOf } from './page-checks.ts';
import { tailAmbiguous, trailingLines } from './structure.ts';

export { tailAmbiguous };
import { TIER3_DECLINE, TIER3_REASONING_TOKENS, type Tier3Failure } from './llm.ts';
import type { FenceIssue, FenceKind, FencePage, FenceSection } from './types.ts';

/** Bump when the prompt text changes: it is part of the attempt-memo key, so a new prompt retries rejected tails. */
export const TAIL_PROMPT_VERSION = 1;

export type TailVerdict = 'prose' | 'rows' | 'unsure';

/** One unclosed fence the model is asked about. */
export interface TailRequest {
  kind: FenceKind;
  section: FenceSection;
  pageVisibility: 'private' | 'world';
  /** The begin marker line as written. */
  begin: string;
  header: string | null;
  /** Every row as written, in fence order. */
  rows: string[];
  /** The trailing lines (non-blank, as written) from the last row to the section end. */
  tail: string[];
  /** 1-based section line of the last table row (where the end marker would go). */
  lastRowLine: number | null;
}

/** The tail request for an `unclosed_trailing_content` issue, or null when the fence is not in that state any more. */
export function tailRequest(page: FencePage, issue: Pick<FenceIssue, 'fence' | 'section'>, pageVisibility: 'private' | 'world'): TailRequest | null {
  const text = new Map(sectionsOf(page)).get(issue.section) ?? '';
  const fence = primaryFence(extractRawRows(text, issue.section), issue.fence);
  if (!fence || fence.end) return null;
  const lines = [fence.header, ...fence.separators, ...fence.rows].filter((r): r is NonNullable<typeof r> => r !== null).sort((a, b) => a.line - b.line);
  const last = lines[lines.length - 1];
  const after = last ? last.end : fence.begin.end;
  const tail = trailingLines(text.slice(after, fence.regionEnd));
  if (!tail.length) return null;
  return { kind: fence.kind, section: fence.section, pageVisibility, begin: text.slice(fence.begin.start, fence.begin.end),
    header: fence.header ? text.slice(fence.header.start, fence.header.end) : null,
    rows: fence.rows.map(row => text.slice(row.start, row.end)), tail, lastRowLine: last?.line ?? null };
}

/** The system and first user message: the fence region and its tail; no other page text. */
export function buildTailPrompt(req: TailRequest): { system: string; user: string } {
  const system = [
    `You read one gbrain ${req.kind} fence whose end marker is missing. After its last table row come more lines. Decide whether those trailing lines are part of the table or ordinary page text.`,
    '',
    'Return exactly one JSON object and nothing else (no prose, no explanation, no code fence):',
    '{"tail": "prose"} when every trailing line is ordinary page text (a paragraph, a list item, a heading, a link) and none of them is a table row, even a broken one.',
    '{"tail": "rows"} when any trailing line is a table row: it carries cells of the same shape as the rows above (a claim, a kind word, a confidence, a date), with or without pipes.',
    `{"tail": "unsure"} (or the single word ${TIER3_DECLINE}) when you cannot tell.`,
    '',
    'Rules:',
    '1. Judge only the trailing lines. Do not repair, rewrite or quote anything.',
    '2. A line that merely mentions a table, a fact or a take in prose is prose.',
    '3. A line with pipes that has fewer or more cells than the header can still be a row; a line with one pipe inside a sentence is prose.',
    '4. When in doubt, answer unsure.',
  ].join('\n');
  const user = [
    `Fence: ${req.kind} (${req.section} section). Page visibility: ${req.pageVisibility}.`,
    'Begin marker as written:',
    req.begin,
    'Header as written:',
    req.header ?? '(none)',
    `Rows as written (${req.rows.length}):`,
    ...req.rows,
    '',
    `Trailing lines after the last row (${req.tail.length}):`,
    ...req.tail,
  ].join('\n');
  return { system, user };
}

const REFUSAL = /\b(cannot|can['’]t|unable to|won['’]t|will not|refuse|not able to)\b/i;

/** The verdict in a model answer, or why there is none. */
export function parseTailAnswer(text: string): { ok: true; tail: TailVerdict } | { ok: false; reason: 'llm_empty' | 'llm_refused' | 'llm_malformed' | 'llm_declined' } {
  let body = text.trim();
  if (!body) return { ok: false, reason: 'llm_empty' };
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  if (body.replace(/[.*_`]/g, '').trim() === TIER3_DECLINE) return { ok: false, reason: 'llm_declined' };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { ok: false, reason: REFUSAL.test(body) ? 'llm_refused' : 'llm_malformed' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'llm_malformed' };
  const tail = (parsed as Record<string, unknown>).tail;
  if (tail !== 'prose' && tail !== 'rows' && tail !== 'unsure') return { ok: false, reason: 'llm_malformed' };
  return { ok: true, tail };
}

function mayReason(model: string): boolean {
  return isThinkingModel(model) || !thinkingOffControl(model)?.disables;
}

/** Token bounds for one call: the prompt's size and a small JSON answer, plus a reasoning allowance for a model that may reason. */
export function tailTokenBudget(req: TailRequest, model: string): { inputTokens: number; maxOutputTokens: number } {
  const prompt = buildTailPrompt(req);
  const requested = 64 + (mayReason(model) ? TIER3_REASONING_TOKENS : 0);
  return { inputTokens: Math.ceil((prompt.system.length + prompt.user.length) / 3) + 64,
    maxOutputTokens: thinkingOffMaxOutputTokens(model, requested, isThinkingModel(model), THINKING_MODEL_MAX_OUTPUT_TOKENS) };
}

export type TailAnswer =
  | { ok: true; tail: TailVerdict; text: string; result: ChatResult }
  | { ok: false; reason: Tier3Failure; text?: string; result?: ChatResult; error?: string };

/** One gateway call (no tools, no fallback model, thinking off where the route allows), classified. */
export async function callTailClassifier(req: TailRequest, opts: { model: string; timeoutMs?: number; signal?: AbortSignal }): Promise<TailAnswer> {
  const prompt = buildTailPrompt(req);
  const messages: ChatMessage[] = [{ role: 'user', content: prompt.user }];
  const budget = tailTokenBudget(req, opts.model);
  let result: ChatResult;
  try {
    result = await chat({ model: opts.model, system: prompt.system, messages, maxTokens: budget.maxOutputTokens, allowFallback: false,
      thinking: 'off', purpose: 'fence_repair', ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.signal ? { abortSignal: opts.signal } : {}) });
  } catch (error) {
    return { ok: false, reason: 'llm_unavailable', error: error instanceof Error ? error.name : 'Error' };
  }
  if (result.stopReason === 'refusal' || result.stopReason === 'content_filter') return { ok: false, reason: 'llm_refused', text: result.text, result };
  if (result.stopReason !== 'end') return { ok: false, reason: result.text.trim() ? 'llm_truncated' : 'llm_empty', text: result.text, result };
  const parsed = parseTailAnswer(result.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, text: result.text, result };
  return { ok: true, tail: parsed.tail, text: result.text, result };
}
