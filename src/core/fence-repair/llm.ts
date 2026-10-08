/**
 * Tier 3 fence repair (#6188): the configured chat model realigns the rows a
 * fence's residual issues name, and nothing else.
 *
 * What the model sees: the fence kind and section, the page's visibility,
 * the canonical header, the schema vocabulary, the residual reason codes
 * with row numbers, and the header line plus the residual rows exactly as
 * written. For a fence-level issue (`no_header`, `header_unmapped`, or an
 * issue that names no row) that is every row of that fence; otherwise only
 * the named rows. Never the valid rows of a row-level issue, never the rest
 * of the page, never tools.
 *
 * What it must return: one markdown table (the canonical header, the
 * separator, one row per input row in order) and nothing else. A single
 * wrapping code fence is tolerated; any other text outside the table is
 * `llm_malformed`. Failure classes: `llm_unavailable` (the provider threw:
 * timeout, rate limit, server error; transient, the attempt memo is not
 * consumed), `llm_empty`, `llm_refused` (refusal or content-filter stop, or a
 * prose refusal), `llm_malformed` (no single table, wrong header, prose),
 * `llm_truncated` (any stop other than a normal end, rejected even if the
 * text parses), `llm_declined` (the single word HOLD: a row has more than one
 * reasonable reading, so the model declines instead of guessing). A table
 * with the wrong number of rows is a gate (e) failure.
 *
 * The corrective re-ask (only after a structural failure, gate (a) or (e))
 * repeats the conversation with the model's own answer and names the failed
 * gate letter and row numbers only.
 *
 * The output ceiling is the table's size plus, for a model whose reasoning a
 * call cannot switch off, a reasoning allowance; the cost estimate uses the
 * ceiling the gateway will actually send, so the caps reserve the worst case.
 *
 * Pure helpers (`tier3Requests`, `buildTier3Prompt`, `extractSingleTable`,
 * `spliceTier3`) do no I/O; `callTier3` is the one gateway call, testable
 * through the gateway's chat transport seam (`__setChatTransportForTests`).
 */
import { chat, isThinkingModel, THINKING_MODEL_MAX_OUTPUT_TOKENS, type ChatMessage, type ChatResult } from '../ai/gateway.ts';
import { thinkingOffControl, thinkingOffMaxOutputTokens } from '../ai/thinking-off.ts';
import { isSeparatorRow, parseRowCells } from '../fence-shared.ts';
import { sectionsOf } from './page-checks.ts';
import { extractRawRows, primaryFence, type RawFence, type RawRow } from './raw-rows.ts';
import { ALLOWED, BASE_WIDTH, CANONICAL_HEADER, COLUMNS, COLUMN_DEFAULTS } from './schema.ts';
import { FENCE_REASON_CODES, FENCE_REASONS, GATE_REASONS } from './reasons.ts';
import type { FenceIssue, FenceKind, FencePage, FenceReason, FenceSection, GateLetter } from './types.ts';

/** Bump when the prompt text changes: it is part of the attempt-memo key, so a new prompt retries rejected pages. */
export const FENCE_REPAIR_PROMPT_VERSION = 2;

/** Residual reasons a model may clear: the screen reasons whose tier is `llm` (everything else is manual or the resolver's). */
export const TIER3_REASONS: ReadonlySet<FenceReason> = new Set(FENCE_REASON_CODES.filter(reason => FENCE_REASONS[reason].stage === 'screen' && FENCE_REASONS[reason].tier === 'llm'));
const FENCE_LEVEL: ReadonlySet<FenceReason> = new Set(['header_unmapped', 'no_header']);

export type Tier3Failure = 'llm_unavailable' | 'llm_empty' | 'llm_refused' | 'llm_malformed' | 'llm_truncated' | 'llm_declined';

/** The whole answer a model gives to decline (prompt rule 8). */
export const TIER3_DECLINE = 'HOLD';
/** Output tokens a reasoning model may spend thinking before it writes the table. */
export const TIER3_REASONING_TOKENS = 2048;

/** One fence the model is asked to repair. */
export interface Tier3Request {
  kind: FenceKind;
  section: FenceSection;
  pageVisibility: 'private' | 'world';
  layout: 'narrow' | 'wide';
  /** The header line as written, or null when the fence has none. */
  header: string | null;
  /** The rows sent, as written, in fence order, with their data-row ordinal. */
  rows: Array<{ occurrence: number; text: string }>;
  /** Residual reasons with the row numbers they name (location only). */
  issues: Array<{ reason: FenceReason; rows: number[] }>;
}

/** Why a fence cannot go to the model (it stays held with its own reason). */
export type Tier3Ineligible = { kind: FenceKind; section: FenceSection; why: 'no_fence' | 'stray_lines' | 'no_end_marker' };

/**
 * The model requests for a page's residual issues, one per fence, or why a
 * fence is not eligible. Callers send only issues whose reason is in
 * TIER3_REASONS.
 */
export function tier3Requests(page: FencePage, issues: readonly FenceIssue[], pageVisibility: 'private' | 'world'): { requests: Tier3Request[]; ineligible: Tier3Ineligible[] } {
  const requests: Tier3Request[] = [];
  const ineligible: Tier3Ineligible[] = [];
  const texts = new Map(sectionsOf(page));
  const groups = new Map<string, FenceIssue[]>();
  for (const issue of issues) {
    const key = `${issue.section}\u0000${issue.fence}`;
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  for (const group of groups.values()) {
    const { section, fence: kind } = group[0]!;
    const text = texts.get(section) ?? '';
    const fence = primaryFence(extractRawRows(text, section), kind);
    if (!fence) { ineligible.push({ kind, section, why: 'no_fence' }); continue; }
    if (!fence.end) { ineligible.push({ kind, section, why: 'no_end_marker' }); continue; }
    if (strayLines(text, fence)) { ineligible.push({ kind, section, why: 'stray_lines' }); continue; }
    const named = new Set(group.flatMap(issue => fence.rows.filter(row => row.line === issue.line).map(row => row.occurrence)));
    const fenceLevel = group.some(issue => FENCE_LEVEL.has(issue.reason) || issue.line === null || !fence.rows.some(row => row.line === issue.line));
    const sent = fence.rows.filter(row => fenceLevel || named.has(row.occurrence));
    const byReason = new Map<FenceReason, Set<number>>();
    for (const issue of group) {
      const rows = byReason.get(issue.reason) ?? new Set<number>();
      if (issue.row !== null) rows.add(issue.row);
      byReason.set(issue.reason, rows);
    }
    requests.push({ kind, section, pageVisibility, layout: wideLayout(kind, fence) ? 'wide' : 'narrow',
      header: fence.header ? text.slice(fence.header.start, fence.header.end) : null,
      rows: sent.map(row => ({ occurrence: row.occurrence, text: text.slice(row.start, row.end) })),
      issues: [...byReason].map(([reason, rows]) => ({ reason, rows: [...rows].sort((a, b) => a - b) })) });
  }
  return { requests, ineligible };
}

/** Wide when the header names a wide-layout column, or (no header) when a row as written has more cells than the narrow width. */
function wideLayout(kind: FenceKind, fence: RawFence): boolean {
  const base = BASE_WIDTH[kind];
  if (fence.header) return fence.columns.some(column => column !== null && COLUMNS[kind].indexOf(column) >= base);
  return fence.rows.some(row => row.cells.length > base);
}

/** Non-blank lines inside the fence that are neither the header, a separator nor a data row: rebuilding the table would drop them. */
function strayLines(text: string, fence: RawFence): boolean {
  const region = text.slice(fence.begin.end, fence.end!.start);
  const tableLines = (fence.header ? 1 : 0) + fence.separators.length + fence.rows.length;
  return region.split('\n').filter(line => line.trim()).length !== tableLines;
}

function headerOf(req: Pick<Tier3Request, 'kind' | 'layout'>): { header: string; separator: string } {
  const h = CANONICAL_HEADER[req.kind];
  return req.layout === 'wide' ? { header: h.wide, separator: h.wideSep } : { header: h.narrow, separator: h.narrowSep };
}

function vocabulary(kind: FenceKind): string {
  return Object.entries(ALLOWED[kind]).filter(([column]) => column !== '#').map(([column, values]) => `- ${column}: ${values.join(', ')}`).join('\n');
}

const GATE_TEXT: Record<GateLetter, string> = {
  a: 'it still does not parse as a valid fence table',
  b: 'a claim cell changed',
  c: 'an existing row number changed',
  d: 'a row became more visible than the input allows',
  e: 'rows were added, dropped, merged, split or reordered',
  f: "a cell's text changed, or a valid cell moved out of its column",
  g: 'it would expose text that sat outside the table',
};

/** The system and first user message. Location and the rows as written; no other page text. */
export function buildTier3Prompt(req: Tier3Request): { system: string; user: string } {
  const { header, separator } = headerOf(req);
  const defaults = Object.entries(COLUMN_DEFAULTS[req.kind]);
  const system = [
    `You repair one malformed markdown table from a gbrain ${req.kind} fence. You move cells into the right columns and supply the canonical header; you never change what a cell says.`,
    '',
    `Return exactly one markdown table and nothing else (or the single word ${TIER3_DECLINE}, rule 8): no prose, no explanation, no code fence.`,
    'The table starts with this header and separator, unchanged:',
    header,
    separator,
    'Then one row per input row, in the same order. Do not add, drop, merge, split or reorder rows.',
    '',
    'Rules:',
    '1. Copy every cell exactly as written: same words, spelling, case, punctuation, links, numbers, dates and ~~strikethrough~~. Only its column may change.',
    '2. The claim cell of each output row is the claim of the matching input row, unchanged.',
    '3. Keep each row number in the # column. If an input row has none, leave # empty.',
    `4. Put each cell in the column its content belongs to. A column with no matching input cell stays empty${defaults.length
      ? `, except a column the input header lacks entirely, which takes its default: ${defaults.map(([column, value]) => `${column} ${value}`).join(', ')}` : ''}.`,
    '5. Never invent, translate, summarize or correct a value. A cell you cannot place goes in the column it was written under.',
    `6. This page is ${req.pageVisibility}-visible. A row's visibility may be world only when that row already says world or public and the page is world-visible; otherwise keep what the row says or leave it empty.`,
    '7. Write a literal | inside a cell as \\|.',
    `8. If any row has more than one reasonable reading (two values for one column, or a cell that fits more than one column), return only the single word ${TIER3_DECLINE} instead of a table.`,
    '',
    'Allowed values per column:',
    vocabulary(req.kind),
  ].join('\n');
  const user = [
    `Fence: ${req.kind} (${req.section} section). Page visibility: ${req.pageVisibility}.`,
    'Problems found (reason codes, with row numbers where known):',
    ...req.issues.map(issue => `- ${issue.reason}${issue.rows.length ? `: row(s) ${issue.rows.join(', ')}` : ''}`),
    '',
    'Header as written:',
    req.header ?? '(none)',
    '',
    `Rows as written (${req.rows.length}):`,
    ...req.rows.map(row => row.text),
  ].join('\n');
  return { system, user };
}

/** The follow-up after a structural gate rejection: the gate letter, its reason code and row numbers only. */
export function correctionMessage(gate: GateLetter, rows: readonly number[]): string {
  return `Your table was rejected by validation gate (${gate}) ${GATE_REASONS[gate]}${rows.length ? ` at row(s) ${rows.join(', ')}` : ''}: ${GATE_TEXT[gate]}. `
    + `Return the corrected full table following every rule above, or ${TIER3_DECLINE} if a row has more than one reasonable reading. Output only the table or ${TIER3_DECLINE}.`;
}

/** The model may reason whatever the call asks: a thinking-by-default model, or a route whose thinking-off option does not turn reasoning fully off. */
function mayReason(model: string): boolean {
  return isThinkingModel(model) || !thinkingOffControl(model)?.disables;
}

/**
 * Token bounds for one call: the prompt's size, and the output ceiling the
 * gateway will send: the table's size (from the rows sent), plus
 * TIER3_REASONING_TOKENS for a model that may reason, raised to the
 * gateway's thinking headroom where a thinking model's route cannot switch
 * thinking off. Estimates and the caps use this ceiling, so they reserve the
 * worst case.
 */
export function tier3TokenBudget(req: Tier3Request, model: string, prior?: { answer: string }): { inputTokens: number; maxOutputTokens: number } {
  const prompt = buildTier3Prompt(req);
  const rowChars = req.rows.reduce((sum, row) => sum + row.text.length, 0) + headerOf(req).header.length * 2;
  const inputChars = prompt.system.length + prompt.user.length + (prior ? prior.answer.length + 400 : 0);
  const table = Math.min(4096, Math.max(512, Math.ceil(rowChars * 1.5 / 3) + 256));
  const requested = table + (mayReason(model) ? TIER3_REASONING_TOKENS : 0);
  return { inputTokens: Math.ceil(inputChars / 3) + 64, maxOutputTokens: thinkingOffMaxOutputTokens(model, requested, isThinkingModel(model), THINKING_MODEL_MAX_OUTPUT_TOKENS) };
}

export interface Tier3Table { header: string; separator: string; rows: string[] }

const REFUSAL = /\b(cannot|can['’]t|unable to|won['’]t|will not|refuse|not able to)\b/i;

/**
 * The single table in a model answer, or why there is none. A single
 * wrapping code fence is stripped; any other non-table line is prose.
 */
export function extractSingleTable(text: string, req: Pick<Tier3Request, 'kind' | 'layout'>): { ok: true; table: Tier3Table } | { ok: false; reason: 'llm_empty' | 'llm_refused' | 'llm_malformed' | 'llm_declined' } {
  let body = text.trim();
  if (!body) return { ok: false, reason: 'llm_empty' };
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  if (body.replace(/[.*_`]/g, '').trim() === TIER3_DECLINE) return { ok: false, reason: 'llm_declined' };
  const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.some(line => line.startsWith('|'))) return { ok: false, reason: REFUSAL.test(body) ? 'llm_refused' : 'llm_malformed' };
  if (lines.some(line => !line.startsWith('|')) || lines.length < 2) return { ok: false, reason: 'llm_malformed' };
  const headerCells = parseRowCells(lines[0]!)?.map(cell => cell.trim().toLowerCase()).join('|');
  const sepCells = parseRowCells(lines[1]!);
  const layout = (['narrow', 'wide'] as const).find(width => headerCells === COLUMNS[req.kind].slice(0, width === 'wide' ? COLUMNS[req.kind].length : BASE_WIDTH[req.kind]).join('|'));
  if (!layout || !sepCells || !isSeparatorRow(sepCells)) return { ok: false, reason: 'llm_malformed' };
  const rows = lines.slice(2);
  if (rows.some(row => parseRowCells(row) === null || isSeparatorRow(parseRowCells(row)!))) return { ok: false, reason: 'llm_malformed' };
  const { header, separator } = headerOf({ kind: req.kind, layout });
  return { ok: true, table: { header, separator, rows } };
}

/**
 * The page with one request's fence rebuilt from the model's table: the
 * canonical header and separator, then every data row in fence order, the
 * sent rows replaced by the answer's rows in order. Everything outside the
 * fence region is unchanged. Null when the answer's row count differs.
 */
export function spliceTier3<T extends FencePage>(page: T, req: Tier3Request, table: Tier3Table): T | null {
  if (table.rows.length !== req.rows.length) return null;
  const field = req.section === 'body' ? 'compiled_truth' : 'timeline';
  const text = (page[field] ?? '') as string;
  const fence = primaryFence(extractRawRows(text, req.section), req.kind);
  if (!fence?.end) return null;
  const answers = new Map(req.rows.map((row, i) => [row.occurrence, table.rows[i]!]));
  const lines = [table.header, table.separator, ...fence.rows.map((row: RawRow) => answers.get(row.occurrence) ?? text.slice(row.start, row.end))];
  const rebuilt = `${text.slice(0, fence.begin.end)}\n${lines.join('\n')}\n${text.slice(fence.end.start)}`;
  return { ...page, [field]: rebuilt };
}

export type Tier3Answer =
  | { ok: true; table: Tier3Table; text: string; result: ChatResult }
  | { ok: false; reason: Tier3Failure; text?: string; result?: ChatResult; error?: string }
  /** The answer parsed but has the wrong number of rows: a gate (e) failure, eligible for the corrective re-ask. */
  | { ok: false; reason: 'row_count_changed'; text: string; result: ChatResult; table: Tier3Table };

export interface Tier3CallOptions {
  model: string;
  /** The first attempt's answer and the gate it failed, for the corrective re-ask. */
  correction?: { answer: string; gate: GateLetter; rows: readonly number[] };
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One gateway call (no tools, no fallback model, thinking off where the route allows; no temperature, which reasoning models refuse), classified. */
export async function callTier3(req: Tier3Request, opts: Tier3CallOptions): Promise<Tier3Answer> {
  const prompt = buildTier3Prompt(req);
  const messages: ChatMessage[] = [{ role: 'user', content: prompt.user }];
  if (opts.correction) messages.push({ role: 'assistant', content: opts.correction.answer }, { role: 'user', content: correctionMessage(opts.correction.gate, opts.correction.rows) });
  const budget = tier3TokenBudget(req, opts.model, opts.correction ? { answer: opts.correction.answer } : undefined);
  let result: ChatResult;
  try {
    result = await chat({ model: opts.model, system: prompt.system, messages, maxTokens: budget.maxOutputTokens, allowFallback: false,
      thinking: 'off', purpose: 'fence_repair', ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.signal ? { abortSignal: opts.signal } : {}) });
  } catch (error) {
    return { ok: false, reason: 'llm_unavailable', error: error instanceof Error ? error.name : 'Error' };
  }
  if (result.stopReason === 'refusal' || result.stopReason === 'content_filter') return { ok: false, reason: 'llm_refused', text: result.text, result };
  if (result.stopReason !== 'end') return { ok: false, reason: result.text.trim() ? 'llm_truncated' : 'llm_empty', text: result.text, result };
  const extracted = extractSingleTable(result.text, req);
  if (!extracted.ok) return { ok: false, reason: extracted.reason, text: result.text, result };
  if (extracted.table.rows.length !== req.rows.length) return { ok: false, reason: 'row_count_changed', text: result.text, result, table: extracted.table };
  return { ok: true, table: extracted.table, text: result.text, result };
}
