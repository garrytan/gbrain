/**
 * Evidence delivery (`return_unit`) — the authorization-safe assembler that
 * turns ranked chunk hits into whole evidence: a window of neighbor chunks,
 * the enclosing section, or the page, packed into a token budget.
 *
 * Runs at the op layer AFTER `hybridSearchCached` returns and before output
 * redaction / snippet capping. It never mutates the hit rows (they may be
 * shared with cache or capture) and never caches expanded text. Opt-in: a
 * resolved unit of `chunk` means the stage does not run at all, so the
 * off path is byte-identical.
 *
 * Text source: the page's stored body, sanitized WHOLE with the strict
 * protected-body boundary before any slicing (a slice can cut a fence and
 * read as a protected tail), fetched with the hit chunks in one batched
 * `getChunkWindows` call that re-authorizes every page under the caller's
 * current read scope. Chunks only anchor hits in that text.
 *
 * The normative algorithm (page text, units, allocation, spans) is specified
 * in docs/evidence-delivery.md; gbrain-evals measures exactly this code.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, SearchResult } from '../types.ts';
import type { ChunkWindowPage, ChunkWindowRequest } from './chunk-windows.ts';
import { estimateTokens as cl100kTokens, cl100kAvailable } from '../chunkers/token-estimate.ts';
import { estimateTokens as heuristicTokens } from './token-budget.ts';
import { redactRetrievalOutput } from './output-redaction.ts';
import { buildSnippetMarker } from './snippet-cap.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { currentTextProjectionFilter, safeChunksFilter, requiresSafeChunks } from './safe-chunks.ts';
import { resolveExcludePrivatePages } from './private-visibility.ts';
import { safeSplitIndex } from '../text-safe.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { credentialSafeProjection } from '../credential-projection.ts';
import { stripChunkHeader } from '../chunkers/code.ts';
import { OperationError } from '../ops/contract.ts';
import { applyEffectiveDate } from '../utils.ts';
import { configPacking, MIN_EXPLICIT_AUTO_BUDGET, parseAutoPacking, type AutoPacking } from './evidence-packing.ts';

export { AUTO_PACKINGS, AUTO_PACKING_CONFIG_KEY, DEFAULT_AUTO_PACKING, MIN_EXPLICIT_AUTO_BUDGET, autoPackingValueProblem, parseAutoPacking, type AutoPacking } from './evidence-packing.ts';

export const RETURN_UNITS = ['chunk', 'window', 'section', 'page', 'auto'] as const;
export type ReturnUnit = typeof RETURN_UNITS[number];
export type DeliveredUnit = 'chunk' | 'window' | 'section' | 'page';

export const RETURN_UNIT_CONFIG_KEY = 'search.return_unit';
export const THINK_RETURN_UNIT_CONFIG_KEY = 'think.return_unit';
export const RETURN_WINDOW_CONFIG_KEY = 'search.return_window';
export const RETURN_BUDGET_DEFAULT_KEY = 'search.return_budget_default';
export const RETURN_BUDGET_MAX_REMOTE_KEY = 'search.return_budget_max_remote';
export const RETURN_BUDGET_CONVERSATION_KEY = 'search.return_budget_conversation';
export const DEFAULT_RETURN_BUDGET = 6000;
/** `auto`'s default budget: whole chat sessions run about 15K tokens, and 16K still trimmed some sessions. */
export const DEFAULT_CONVERSATION_BUDGET = 24000;
export const DEFAULT_REMOTE_BUDGET_MAX = 32000;
export const EVIDENCE_BLOCK_CHAR_CAP = 60_000;
export const EVIDENCE_OMISSION = '\n\n[…]\n\n';
export const EVIDENCE_FETCH_TIMEOUT_MS = 5000;
/** First server release that understands `return_unit` (thin-client skew warning). */
export const EVIDENCE_DELIVERY_MIN_SERVER_VERSION = '0.60.13.0';

/** Ends a block or chunk the cap cut short (the omission line, as emitted at a block's end). */
export const EVIDENCE_CUT_MARKER = EVIDENCE_OMISSION.trimEnd();
/** Body tokens a cut always keeps: a cut title never takes them. */
const CUT_BODY_MIN = 8;

const PIECE_MAX_CHARS = 400;
const MAX_ROWS = 1024;
const MAX_WINDOW = 3;

export interface MatchSpan { chunk_id: number; start: number; end: number }

/**
 * Why `auto` chose a result's unit: a conversation page (by type or slug
 * prefix) gets the whole page; anything else keeps its ranked chunk exactly;
 * a conversation whose matching span no longer fits the budget keeps its
 * ranked chunks too.
 */
export type AutoReason = 'conversation_type' | 'conversation_slug' | 'not_conversation' | 'conversation_over_budget';

export interface DeliveredEvidence {
  unit: DeliveredUnit;
  chunk_ids: number[];
  match_spans: MatchSpan[];
  tokens: number;
  truncated: boolean;
  revision?: string;
  unmapped_chunk_ids?: number[];
  fallback_reason?: string;
  /** Present only under `auto`: why this result got its unit. */
  reason?: AutoReason;
}

export interface DeliveryMeta {
  requested_unit: ReturnUnit;
  applied_unit: ReturnUnit;
  return_window: number;
  budget_tokens: number;
  budget_used: number;
  tokens_delivered: number;
  tokenizer: 'cl100k' | 'heuristic';
  coordinates: 'utf16';
  blocks: number;
  dropped: number;
  dropped_reasons: Record<string, number>;
  fallbacks: string[];
  budget_clamped?: { requested: number; max: number };
  /** Present only when an explicit budget engaged the cap: the packing that ran. */
  auto_packing?: AutoPacking;
}

export type DeliveredSearchResult = SearchResult & { delivered: DeliveredEvidence };

export interface EvidencePlan {
  requestedUnit: ReturnUnit;
  unit: Exclude<ReturnUnit, 'chunk'>;
  window: number;
  budgetTokens: number;
  /** return_unit came from the call, not config (snippet precedence). */
  explicitUnit: boolean;
  /** The caller passed the budget; a config or default budget never engages the cap. */
  budgetExplicit: boolean;
  /** search.auto_packing (or the library override), resolved once; allocation never rereads config. */
  packing: AutoPacking;
  budgetClamped?: { requested: number; max: number };
}

/** The cap runs only under `auto`, with a budget the caller passed and a packing other than `off`. */
export function capEngaged(plan: EvidencePlan): boolean {
  return plan.unit === 'auto' && plan.budgetExplicit && plan.packing !== 'off';
}

export interface DeliveryScope extends PageReadScope {
  detail?: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Parameter validation + plan resolution
// ---------------------------------------------------------------------------

function exampleCall(op: string, unit: string, extra = ''): string {
  const head = op === 'recall' ? '"query": "renewal terms"' : '"query": "launch date"';
  return `Example: {${head}, "return_unit": "${unit}"${extra}}`;
}

export function parseReturnUnit(raw: unknown, op: string): ReturnUnit | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && (RETURN_UNITS as readonly string[]).includes(raw)) return raw as ReturnUnit;
  const shown = typeof raw === 'string' ? JSON.stringify(raw.slice(0, 40)) : typeof raw;
  throw new OperationError(
    'invalid_params',
    `return_unit must be one of ${RETURN_UNITS.join(', ')} (got ${shown}).`,
    `${exampleCall(op, 'page')}. Use "window" for local context, "page" for whole conversations.`,
  );
}

export function parseReturnWindow(raw: unknown, op: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_WINDOW) return raw;
  const shown = typeof raw === 'number' ? String(raw) : typeof raw;
  throw new OperationError(
    'invalid_params',
    `return_window must be an integer from 1 to ${MAX_WINDOW} (got ${shown}).`,
    exampleCall(op, 'window', ', "return_window": 2'),
  );
}

async function configNumber(engine: BrainEngine, key: string): Promise<number | null> {
  try {
    const raw = await engine.getConfig(key);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface ResolvePlanInput {
  remote: boolean | undefined;
  viaSubagent?: boolean;
  returnUnit: unknown;
  returnWindow: unknown;
  /** The op's own budget param (token_budget / budget_tokens). */
  budget: unknown;
  /** Explicit snippet_chars param (number) or undefined. */
  snippetChars: unknown;
  /** The resolved snippet cap for this call (0 = none). */
  snippetCap: number;
  configKey?: string;
  op: string;
  /**
   * The caller passed a chunk-mode budget knob (query's token_budget, recall's
   * budget_policy): an implied unit stays `chunk` so that legacy budgeting
   * keeps its meaning.
   */
  legacyBudget?: boolean;
  /** Library-only per-call packing (gbrain-evals); wins over search.auto_packing. Never an MCP param. */
  autoPacking?: unknown;
}

/**
 * Resolve the per-call evidence plan, or null when the resolved unit is
 * `chunk` (the stage stays inert and the response is unchanged). The unit is
 * the call's `return_unit`, else the config unit, else `auto`. Throws
 * invalid_params for a bad `return_unit` / `return_window`.
 */
export async function resolveEvidencePlan(engine: BrainEngine, input: ResolvePlanInput): Promise<EvidencePlan | null> {
  const explicit = parseReturnUnit(input.returnUnit, input.op);
  const explicitWindow = parseReturnWindow(input.returnWindow, input.op);
  let unit: ReturnUnit = explicit ?? 'auto';
  if (explicit === undefined) {
    try {
      const raw = await engine.getConfig(input.configKey ?? RETURN_UNIT_CONFIG_KEY);
      if (typeof raw === 'string' && (RETURN_UNITS as readonly string[]).includes(raw)) unit = raw as ReturnUnit;
    } catch { /* config unreadable: stay on the default */ }
    // Snippet precedence: an implied or config-level unit never overrides an
    // explicit snippet cap, the subagent default token economy, or a legacy
    // chunk-mode budget knob.
    const explicitSnippet = typeof input.snippetChars === 'number' && Number.isFinite(input.snippetChars);
    if (unit !== 'chunk' && !explicitSnippet && input.viaSubagent === true && input.snippetCap > 0) unit = 'chunk';
    if (input.legacyBudget === true) unit = 'chunk';
  }
  if (unit === 'chunk') return null;
  // A budget that is not a positive number keeps its old meaning (no budget)
  // unless the call also named its unit; then it is validated below.
  const budgetExplicit = typeof input.budget === 'number' && (explicit !== undefined || (Number.isFinite(input.budget) && input.budget > 0));
  const packing = parseAutoPacking(input.autoPacking) ?? await configPacking(engine);
  if (unit === 'auto' && budgetExplicit && packing !== 'off') {
    const raw = input.budget as number;
    if (!Number.isFinite(raw) || Math.floor(raw) < MIN_EXPLICIT_AUTO_BUDGET) {
      const name = input.op === 'recall' ? 'budget_tokens' : 'token_budget';
      throw new OperationError(
        'invalid_params',
        `${name} must be at least ${MIN_EXPLICIT_AUTO_BUDGET} tokens under return_unit auto (got ${String(raw)}): an explicit budget is a hard cap, and a smaller one cannot hold a title, a cut marker and any evidence.`,
        `${exampleCall(input.op, 'auto', `, "${name}": ${MIN_EXPLICIT_AUTO_BUDGET * 50}`)}. Omit ${name} for the default budget.`,
      );
    }
  }
  let window = explicitWindow ?? 1;
  if (explicitWindow === undefined) {
    const w = await configNumber(engine, RETURN_WINDOW_CONFIG_KEY);
    if (w !== null) window = Math.min(MAX_WINDOW, Math.max(1, Math.floor(w)));
  }
  const fallbackBudget = unit === 'auto' ? DEFAULT_CONVERSATION_BUDGET : DEFAULT_RETURN_BUDGET;
  let budget = typeof input.budget === 'number' && Number.isFinite(input.budget) && input.budget > 0
    ? Math.floor(input.budget)
    : Math.floor((await configNumber(engine, unit === 'auto' ? RETURN_BUDGET_CONVERSATION_KEY : RETURN_BUDGET_DEFAULT_KEY)) ?? fallbackBudget);
  if (budget <= 0) budget = fallbackBudget;
  let budgetClamped: EvidencePlan['budgetClamped'];
  if (input.remote !== false) {
    const cfgMax = await configNumber(engine, RETURN_BUDGET_MAX_REMOTE_KEY);
    const max = cfgMax !== null && cfgMax > 0 ? Math.floor(cfgMax) : DEFAULT_REMOTE_BUDGET_MAX;
    if (budget > max) {
      budgetClamped = { requested: budget, max };
      budget = max;
    }
  }
  return {
    requestedUnit: unit,
    unit,
    window,
    budgetTokens: budget,
    explicitUnit: explicit !== undefined,
    budgetExplicit,
    packing,
    ...(budgetClamped ? { budgetClamped } : {}),
  };
}

// ---------------------------------------------------------------------------
// auto: conversation detection
// ---------------------------------------------------------------------------

/**
 * Page types that hold conversations: imported sessions (`conversation`, what
 * the transcripts and chat-connector ingest paths write), `transcript` and
 * `chat` pages, meetings, and the Slack / iMessage chat-log types the
 * conversation-facts pipeline reads (including the collector's granular
 * Slack types before type consolidation).
 */
const CONVERSATION_PAGE_TYPES: ReadonlySet<string> = new Set([
  'conversation', 'transcript', 'chat', 'meeting',
  'slack', 'slack-dm-day', 'slack-thread', 'imessage', 'imessage-daily',
]);

/** `chat/` (LongMemEval and chat imports) and `conversations/` (transcripts + connectors ingest). */
const CONVERSATION_SLUG_PREFIXES: readonly string[] = ['chat/', 'conversations/'];

/** Deterministic, row-local conversation signal for `auto` (no query, no model). */
export function conversationSignal(hit: { type?: string | null; slug: string }): 'conversation_type' | 'conversation_slug' | null {
  if (typeof hit.type === 'string' && CONVERSATION_PAGE_TYPES.has(hit.type.toLowerCase())) return 'conversation_type';
  if (CONVERSATION_SLUG_PREFIXES.some(prefix => hit.slug.startsWith(prefix))) return 'conversation_slug';
  return null;
}

/**
 * The plan to run for these hits: an implied or config-level `auto` with no
 * conversation hit is the chunk path (null), so responses without
 * conversations stay byte-identical. An explicit `auto`, or an `auto` under
 * an explicit budget the cap enforces, always runs and reports its
 * per-result decision.
 */
export function effectivePlan(plan: EvidencePlan | null, hits: SearchResult[]): EvidencePlan | null {
  if (!plan || plan.unit !== 'auto' || plan.explicitUnit || capEngaged(plan)) return plan;
  return hits.some(h => conversationSignal(h) !== null) ? plan : null;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function evidenceTokenizer(): 'cl100k' | 'heuristic' {
  return cl100kAvailable() ? 'cl100k' : 'heuristic';
}

function pieceTokens(text: string, tokenizer: 'cl100k' | 'heuristic'): number {
  if (!text) return 0;
  return tokenizer === 'cl100k' ? cl100kTokens(text) : heuristicTokens(text);
}

/** Split into lines (newline kept); lines over PIECE_MAX_CHARS split at whitespace. */
export function splitPieces(text: string): Array<{ start: number; end: number; lineStart: boolean }> {
  const out: Array<{ start: number; end: number; lineStart: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    let s = i;
    let first = true;
    while (s < lineEnd) {
      let e = lineEnd;
      if (e - s > PIECE_MAX_CHARS) {
        e = s + PIECE_MAX_CHARS;
        const ws = text.slice(s + PIECE_MAX_CHARS - 80, e).search(/\s\S*$/);
        e = ws >= 0 ? s + PIECE_MAX_CHARS - 80 + ws + 1 : safeSplitIndex(text, e);
        if (e <= s) e = Math.min(lineEnd, s + PIECE_MAX_CHARS);
      }
      out.push({ start: s, end: e, lineStart: first });
      first = false;
      s = e;
    }
    i = lineEnd;
  }
  return out;
}

/** Deterministic token count: the sum of per-piece counts (see the doc). */
export function countEvidenceTokens(text: string, tokenizer: 'cl100k' | 'heuristic' = evidenceTokenizer()): number {
  let n = 0;
  for (const p of splitPieces(text)) n += pieceTokens(text.slice(p.start, p.end), tokenizer);
  return n;
}

function sliceToTokenCount(text: string, max: number, tokenizer: 'cl100k' | 'heuristic'): string {
  if (max <= 0) return '';
  if (countEvidenceTokens(text, tokenizer) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countEvidenceTokens(text.slice(0, safeSplitIndex(text, mid)), tokenizer) <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, safeSplitIndex(text, lo));
}

// ---------------------------------------------------------------------------
// Locating chunks in the sanitized body
// ---------------------------------------------------------------------------

/** Separator serializeMarkdown writes between compiled truth and timeline. */
export const TIMELINE_SEPARATOR = '\n\n<!-- timeline -->\n\n';

/** Whitespace runs collapsed to one space, with a map back to original offsets. */
function squeeze(text: string): { s: string; map: number[] } {
  const parts: string[] = [];
  const map: number[] = [];
  let runStart = 0;
  const WS = /\s+/g;
  for (const m of text.matchAll(WS)) {
    const at = m.index!;
    if (at > runStart) {
      parts.push(text.slice(runStart, at));
      for (let i = runStart; i < at; i++) map.push(i);
    }
    parts.push(' ');
    map.push(at);
    runStart = at + m[0].length;
  }
  if (runStart < text.length) {
    parts.push(text.slice(runStart));
    for (let i = runStart; i < text.length; i++) map.push(i);
  }
  return { s: parts.join(''), map };
}

/**
 * Locate each chunk (chunk_index order) in the page text the chunks were cut
 * from. The chunker trims chunks and can fold whitespace-only runs, so the
 * match ignores whitespace differences; consecutive chunks overlap, so each
 * search starts just after the previous chunk's start. Unlocated chunks are absent.
 */
export function locateChunks(text: string, chunks: Array<{ id: number; chunk_index: number; chunk_text: string }>): Array<{ id: number; chunk_index: number; start: number; end: number }> {
  let body: ReturnType<typeof squeeze> | null = null;
  const out: Array<{ id: number; chunk_index: number; start: number; end: number }> = [];
  let from = 0;
  for (const c of [...chunks].sort((a, b) => a.chunk_index - b.chunk_index)) {
    const exact = c.chunk_text.trim();
    if (exact.length === 0) continue;
    let at = text.indexOf(exact, from);
    if (at < 0) at = text.indexOf(exact);
    if (at >= 0) {
      out.push({ id: c.id, chunk_index: c.chunk_index, start: at, end: at + exact.length });
      from = at + 1;
      continue;
    }
    body ??= squeeze(text);
    const needle = squeeze(exact).s;
    let lo = 0;
    let hi = body.map.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (body.map[mid] < from) lo = mid + 1; else hi = mid; }
    let sq = body.s.indexOf(needle, lo);
    if (sq < 0) sq = body.s.indexOf(needle);
    if (sq < 0) continue;
    out.push({ id: c.id, chunk_index: c.chunk_index, start: body.map[sq], end: body.map[sq + needle.length - 1] + 1 });
    from = body.map[sq] + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

interface Piece {
  run: number;
  start: number;
  end: number;
  text: string;
  lineStart: boolean;
  heading: number;
  speaker: string | null;
  tok: number;
}

interface Doc {
  text: string;
  pieces: Piece[];
  spans: Array<{ id: number; chunk_index: number; start: number; end: number }>;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+\S/;
const FENCE = /^ {0,3}(```|~~~)/;
const SPEAKER = /^\s{0,3}(?:\*\*([^*\n:]{1,40}):\s*\*\*|\*\*([^*\n:]{1,40})\*\*\s*:|(user|assistant|human|ai|system|bot|speaker\s*\d{1,3})\s*:)/i;

function buildDoc(text: string, spans: Doc['spans']): Doc {
  const pieces: Piece[] = [];
  let inFence = false;
  for (const p of splitPieces(text)) {
    const t = text.slice(p.start, p.end);
    let heading = 0;
    let speaker: string | null = null;
    if (p.lineStart) {
      if (FENCE.test(t)) inFence = !inFence;
      else if (!inFence) {
        const h = HEADING.exec(t);
        if (h) heading = h[1].length;
        const sp = SPEAKER.exec(t);
        if (sp) speaker = (sp[1] ?? sp[2] ?? sp[3]).trim().toLowerCase().replace(/\s+/g, ' ');
      }
    }
    pieces.push({ run: 0, start: p.start, end: p.end, text: t, lineStart: p.lineStart, heading, speaker, tok: -1 });
  }
  return { text, pieces, spans };
}

/** ≥ 4 speaker-turn lines, ≥ 2 distinct labels, ≥ 3 label changes. */
export function isConversationLabels(labels: string[]): boolean {
  if (labels.length < 4 || new Set(labels).size < 2) return false;
  let changes = 0;
  for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) changes++;
  return changes >= 3;
}

function piecesOverlapping(doc: Doc, start: number, end: number): number[] {
  let lo = 0;
  let hi = doc.pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (doc.pieces[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  const out: number[] = [];
  for (let i = lo; i < doc.pieces.length && doc.pieces[i].start < end; i++) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

interface Anchor {
  chunk_id: number;
  mapped: boolean;
  pieces: number[];
  start: number;
  end: number;
  chunkIndex: number;
}

interface Block {
  hit: SearchResult;
  hits: SearchResult[];
  doc: Doc;
  unit: DeliveredUnit;
  candidates: number[];
  anchors: Anchor[];
  revision?: string;
  fallbackReason?: string;
  titleTok: number;
  selected: Set<number>;
  cut: boolean;
  title: string;
  /** Index of the block's best hit in the ranked input. */
  rank: number;
  reason?: AutoReason;
  /** The cap cut this block: its text ends with EVIDENCE_CUT_MARKER. */
  capMarker?: boolean;
}

type PlannedBlock = Omit<Block, 'titleTok' | 'title' | 'rank' | 'reason' | 'capMarker'>;

/**
 * The hit's text as it appears in the page: a fenced_code chunk carries the
 * code chunker's synthesized `[Lang] fence.ts:N-M symbol` header, which is
 * not page text, so it is stripped before the chunk anchors or is delivered.
 */
function hitPageText(hit: SearchResult): string {
  const text = hit.chunk_text ?? '';
  return hit.chunk_source === 'fenced_code' ? stripChunkHeader(text) : text;
}

function fallbackBlock(hit: SearchResult, hits: SearchResult[], reason: string): PlannedBlock {
  const text = hitPageText(hit);
  const doc = buildDoc(text, []);
  const all = doc.pieces.map((_, i) => i);
  return {
    hit, hits, doc, unit: 'chunk', candidates: all,
    anchors: [
      { chunk_id: hit.chunk_id, mapped: true, pieces: all, start: 0, end: text.length, chunkIndex: hit.chunk_index },
      ...hits.slice(1).map(h => ({ chunk_id: h.chunk_id, mapped: false, pieces: [], start: 0, end: 0, chunkIndex: h.chunk_index })),
    ],
    fallbackReason: reason, selected: new Set(), cut: false,
  };
}

/**
 * The page text evidence is cut from: the complete stored body, sanitized
 * with the strict protected-body boundary BEFORE any slicing (Takes, non-world
 * and withdrawn Facts rows, malformed protected tails, materialized markers),
 * compiled truth and timeline each sanitized whole, run through the same
 * credential-safe projection the chunkers cut from (private-key spans become
 * newline-padded tokens), and joined the way serializeMarkdown joins them.
 * Frontmatter is not part of it.
 */
export function pageEvidenceText(page: { compiled_truth: string; timeline: string }, includeTimeline: boolean): { text: string; timelineAt: number } {
  const truth = credentialSafeProjection(sanitizeRemoteBody(page.compiled_truth ?? ''));
  const timeline = includeTimeline ? credentialSafeProjection(sanitizeRemoteBody(page.timeline ?? '')) : '';
  if (!timeline.trim()) return { text: truth, timelineAt: -1 };
  return { text: truth + TIMELINE_SEPARATOR + timeline, timelineAt: truth.length + TIMELINE_SEPARATOR.length };
}

function locateAnchor(doc: Doc, hit: SearchResult): Anchor {
  const byId = hit.chunk_id > 0 ? doc.spans.find(x => x.id === hit.chunk_id) : undefined;
  if (byId) return { chunk_id: hit.chunk_id, mapped: true, pieces: piecesOverlapping(doc, byId.start, byId.end), start: byId.start, end: byId.end, chunkIndex: byId.chunk_index };
  const text = hitPageText(hit).trim();
  if (text.length >= 16) {
    const found = locateChunks(doc.text, [{ id: hit.chunk_id, chunk_index: hit.chunk_index, chunk_text: text }])[0];
    if (found) {
      // A fenced_code chunk_index follows every prose chunk, so it says nothing
      // about position: the window grows from the prose chunk holding the fence,
      // or not at all when none was fetched.
      const chunkIndex = hit.chunk_source !== 'fenced_code' ? hit.chunk_index
        : doc.spans.find(sp => sp.start <= found.start && found.end <= sp.end)?.chunk_index ?? Number.NEGATIVE_INFINITY;
      return { chunk_id: hit.chunk_id, mapped: true, pieces: piecesOverlapping(doc, found.start, found.end), start: found.start, end: found.end, chunkIndex };
    }
  }
  // Positional anchor (the current revision no longer holds the hit chunk, or
  // a synthetic chunk_id 0 row): the nearest located chunk drives the unit
  // cut, but no match span is reported.
  let best: Doc['spans'][number] | null = null;
  for (const sp of doc.spans) if (!best || Math.abs(sp.chunk_index - hit.chunk_index) < Math.abs(best.chunk_index - hit.chunk_index)) best = sp;
  if (!best) return { chunk_id: hit.chunk_id, mapped: false, pieces: [], start: 0, end: 0, chunkIndex: hit.chunk_index };
  const mapped = hit.chunk_id === 0 && best.chunk_index === hit.chunk_index;
  return { chunk_id: hit.chunk_id, mapped, pieces: piecesOverlapping(doc, best.start, best.end), start: best.start, end: best.end, chunkIndex: best.chunk_index };
}

function windowCandidates(doc: Doc, anchors: Anchor[], n: number): number[] {
  const set = new Set<number>();
  for (const a of anchors) {
    for (const sp of doc.spans) {
      if (Math.abs(sp.chunk_index - a.chunkIndex) <= n) for (const p of piecesOverlapping(doc, sp.start, sp.end)) set.add(p);
    }
    for (const p of a.pieces) set.add(p);
  }
  return [...set].sort((x, y) => x - y);
}

function sectionCandidates(doc: Doc, anchors: Anchor[], conversation: boolean): number[] | null {
  const set = new Set<number>();
  let opener: string | null = null;
  if (conversation) {
    const labels = doc.pieces.map(p => p.speaker).filter((x): x is string => x !== null);
    opener = labels.find(l => l === 'user' || l === 'human') ?? labels[0] ?? null;
  }
  for (const a of anchors) {
    if (a.pieces.length === 0) continue;
    const first = a.pieces[0];
    const last = a.pieces[a.pieces.length - 1];
    let start = 0;
    let level = 0;
    for (let i = first; i >= 0; i--) {
      const p = doc.pieces[i];
      if (conversation ? p.speaker === opener : p.heading > 0) { start = i; level = conversation ? 0 : p.heading; break; }
    }
    let end = doc.pieces.length - 1;
    for (let i = last + 1; i < doc.pieces.length; i++) {
      const p = doc.pieces[i];
      if (conversation ? p.speaker === opener : p.heading > 0 && (level === 0 || p.heading <= level)) { end = i - 1; break; }
    }
    for (let i = start; i <= end; i++) set.add(i);
  }
  return set.size === 0 ? null : [...set].sort((x, y) => x - y);
}

function planBlock(page: ChunkWindowPage, hits: SearchResult[], plan: EvidencePlan, includeTimeline: boolean): PlannedBlock {
  const best = hits[0];
  if (!page.sealed) return fallbackBlock(best, hits, 'unsealed_page');
  if (page.chunks.length === 0 && page.row_limited) return fallbackBlock(best, hits, 'row_limit');
  const { text, timelineAt } = pageEvidenceText(page, includeTimeline);
  const truthChunks = page.chunks.filter(c => c.chunk_source === 'compiled_truth');
  const timelineChunks = page.chunks.filter(c => c.chunk_source === 'timeline');
  const spans = [
    ...locateChunks(timelineAt < 0 ? text : text.slice(0, timelineAt - TIMELINE_SEPARATOR.length), truthChunks),
    ...(timelineAt < 0 ? [] : locateChunks(text.slice(timelineAt), timelineChunks).map(sp => ({ ...sp, start: sp.start + timelineAt, end: sp.end + timelineAt }))),
  ];
  const doc = buildDoc(text, spans);
  const anchors = hits.map(h => locateAnchor(doc, h));
  if (anchors.every(a => a.pieces.length === 0)) {
    return fallbackBlock(best, hits, page.row_limited ? 'row_limit' : page.chunks.length === 0 ? 'no_text_chunks' : 'anchor_not_located');
  }
  const labels = doc.pieces.map(p => p.speaker).filter((x): x is string => x !== null);
  const conversation = isConversationLabels(labels);
  const hasHeadings = doc.pieces.some(p => p.heading > 0);
  let unit: DeliveredUnit = plan.unit === 'auto' ? 'page' : plan.unit;
  let fallbackReason: string | undefined;
  let candidates: number[];
  if (unit === 'page') {
    candidates = doc.pieces.map((_, i) => i);
  } else if (unit === 'section') {
    const sec = conversation || hasHeadings ? sectionCandidates(doc, anchors, conversation) : null;
    if (sec) candidates = sec;
    else {
      unit = 'window';
      if (plan.unit === 'section') fallbackReason = 'no_section_structure';
      candidates = windowCandidates(doc, anchors, plan.window);
    }
  } else {
    candidates = windowCandidates(doc, anchors, plan.window);
  }
  return {
    hit: best, hits, doc, unit, candidates, anchors,
    revision: page.revision,
    ...(fallbackReason ? { fallbackReason } : {}),
    selected: new Set(), cut: false,
  };
}

// ---------------------------------------------------------------------------
// Allocation + emission
// ---------------------------------------------------------------------------

function tok(b: Block, i: number, tokenizer: 'cl100k' | 'heuristic'): number {
  const p = b.doc.pieces[i];
  if (p.tok < 0) p.tok = pieceTokens(p.text, tokenizer);
  return p.tok;
}

function adjacent(b: Block, i: number): boolean {
  const p = b.doc.pieces[i];
  return (b.selected.has(i - 1) && b.doc.pieces[i - 1].run === p.run) || (b.selected.has(i + 1) && b.doc.pieces[i + 1]?.run === p.run);
}

function enrichmentOrder(b: Block): number[] {
  const core = new Set(b.anchors[0]?.pieces ?? []);
  const candPos = new Map(b.candidates.map((c, i) => [c, i]));
  const coreRank = new Map<number, number>();
  b.anchors.slice(1).forEach((a, r) => { for (const p of a.pieces) if (!coreRank.has(p)) coreRank.set(p, r); });
  const seeds = b.candidates.map((c, i) => (core.has(c) || coreRank.has(c) ? i : -1)).filter(i => i >= 0);
  const dist = new Array<number>(b.candidates.length).fill(Number.MAX_SAFE_INTEGER);
  for (const s of seeds) dist[s] = 0;
  for (let i = 1; i < dist.length; i++) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
  for (let i = dist.length - 2; i >= 0; i--) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
  return b.candidates
    .filter(c => !core.has(c))
    .sort((x, y) => {
      const ox = coreRank.has(x) ? 0 : 1;
      const oy = coreRank.has(y) ? 0 : 1;
      if (ox !== oy) return ox - oy;
      if (ox === 0 && coreRank.get(x)! !== coreRank.get(y)!) return coreRank.get(x)! - coreRank.get(y)!;
      const dx = dist[candPos.get(x)!];
      const dy = dist[candPos.get(y)!];
      return dx - dy || x - y;
    });
}

/** Rank one alone exceeds the budget: cut its title to `titleMax`, then keep core pieces (slicing the first) to fit. */
function cutToFit(b: Block, remaining: number, titleMax: number, tokenizer: 'cl100k' | 'heuristic'): number {
  const core = b.anchors[0]?.pieces ?? [];
  if (b.titleTok > titleMax) {
    b.title = sliceToTokenCount(b.title, titleMax, tokenizer);
    b.titleTok = countEvidenceTokens(b.title, tokenizer);
  }
  remaining -= b.titleTok;
  let chars = 0;
  for (const i of core) {
    const t = tok(b, i, tokenizer);
    const len = b.doc.pieces[i].text.length;
    if (t <= remaining && chars + len <= EVIDENCE_BLOCK_CHAR_CAP) {
      b.selected.add(i);
      remaining -= t;
      chars += len;
      continue;
    }
    if (b.selected.size === 0) {
      const p = b.doc.pieces[i];
      p.text = sliceToTokenCount(p.text.slice(0, EVIDENCE_BLOCK_CHAR_CAP), remaining, tokenizer);
      p.end = p.start + p.text.length;
      p.tok = pieceTokens(p.text, tokenizer);
      b.selected.add(i);
      remaining -= p.tok;
    }
    break;
  }
  b.cut = true;
  return remaining;
}

/** Grow a kept block in enrichment order until the next piece does not fit; returns what is left. */
function enrichBlock(b: Block, remaining: number, tokenizer: 'cl100k' | 'heuristic', omitTok: number): number {
  let chars = [...b.selected].reduce((n, i) => n + b.doc.pieces[i].text.length, 0);
  for (const i of enrichmentOrder(b)) {
    if (b.selected.has(i)) continue;
    const adj = adjacent(b, i);
    const cost = tok(b, i, tokenizer) + (adj ? 0 : omitTok);
    const len = b.doc.pieces[i].text.length + (adj ? 0 : EVIDENCE_OMISSION.length);
    if (cost > remaining || chars + len > EVIDENCE_BLOCK_CHAR_CAP) break;
    b.selected.add(i);
    remaining -= cost;
    chars += len;
  }
  return remaining;
}

function floorOf(b: Block, tokenizer: 'cl100k' | 'heuristic'): { tokens: number; chars: number } {
  const core = b.anchors[0]?.pieces ?? [];
  return {
    tokens: b.titleTok + core.reduce((n, i) => n + tok(b, i, tokenizer), 0),
    chars: core.reduce((n, i) => n + b.doc.pieces[i].text.length, 0),
  };
}

/**
 * Reserve each block's floor in rank order, then enrich. `spill` (auto) takes
 * a block whose floor does not fit instead of dropping or cutting it.
 */
function allocate(blocks: Block[], budget: number, tokenizer: 'cl100k' | 'heuristic', dropped: Record<string, number>, spill?: (b: Block) => void): Block[] {
  const omitTok = pieceTokens(EVIDENCE_OMISSION, tokenizer);
  let remaining = budget;
  const kept: Block[] = [];
  let droppedAny = false;
  for (const b of blocks) {
    const core = b.anchors[0]?.pieces ?? [];
    const floor = floorOf(b, tokenizer);
    if (floor.tokens <= remaining && floor.chars <= EVIDENCE_BLOCK_CHAR_CAP) {
      for (const i of core) b.selected.add(i);
      remaining -= floor.tokens;
      kept.push(b);
      continue;
    }
    if (spill) { spill(b); continue; }
    if (kept.length === 0 && !droppedAny) {
      // Rank one alone exceeds the budget: cut it to fit (minKeep).
      remaining = cutToFit(b, remaining, remaining, tokenizer);
      kept.push(b);
      continue;
    }
    droppedAny = true;
    dropped.budget_floor = (dropped.budget_floor ?? 0) + 1;
  }
  for (const b of kept) {
    if (b.cut) continue;
    remaining = enrichBlock(b, remaining, tokenizer, omitTok);
  }
  return kept;
}

/** A non-conversation hit under `auto`: its ranked chunk, or a cut prefix of it under the cap. */
interface ChunkItem { rank: number; hit: SearchResult; reason: AutoReason; title: string; text: string; cut: boolean }

/** A selection as emit writes it: the pieces plus one omission line per gap. */
function selectionCost(b: Block, sel: Set<number>, tokenizer: 'cl100k' | 'heuristic', omitTok: number): { tokens: number; chars: number } {
  const order = [...sel].sort((x, y) => x - y);
  let tokens = 0;
  let chars = 0;
  order.forEach((i, k) => {
    const gap = k > 0 && order[k - 1] !== i - 1;
    tokens += tok(b, i, tokenizer) + (gap ? omitTok : 0);
    chars += b.doc.pieces[i].text.length + (gap ? EVIDENCE_OMISSION.length : 0);
  });
  return { tokens, chars };
}

/**
 * The cap (explicit budget under `auto`, docs/evidence-delivery.md
 * "Explicit budgets"): global rank one first, cut to fit if it alone exceeds
 * the budget; then the rank-order prefix of the other non-conversation chunks
 * that fits; then conversations by the plan's packing. Nothing is spilled
 * outside the budget; what does not fit is counted in `dropped`.
 */
function allocateCapped(blocks: Block[], chunks: ChunkItem[], plan: EvidencePlan, tokenizer: 'cl100k' | 'heuristic', dropped: Record<string, number>): { kept: Block[]; chunks: ChunkItem[] } {
  const omitTok = pieceTokens(EVIDENCE_OMISSION, tokenizer);
  const cutTok = countEvidenceTokens(EVIDENCE_CUT_MARKER, tokenizer);
  const drop = (reason: string) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  const chunkCost = (c: ChunkItem) => countEvidenceTokens(c.title, tokenizer) + countEvidenceTokens(c.text, tokenizer);
  let remaining = plan.budgetTokens;
  const keptChunks: ChunkItem[] = [];
  const kept: Block[] = [];
  let lead: Block | null = null;

  const firstChunk = chunks[0];
  const firstBlock = blocks[0];
  let rest = chunks;
  let others = blocks;
  if (firstChunk && (!firstBlock || firstChunk.rank < firstBlock.rank)) {
    rest = chunks.slice(1);
    const cost = chunkCost(firstChunk);
    if (cost <= remaining) remaining -= cost;
    else {
      const room = remaining - cutTok;
      let title = firstChunk.title;
      if (countEvidenceTokens(title, tokenizer) > room - CUT_BODY_MIN) title = sliceToTokenCount(title, Math.max(0, room - CUT_BODY_MIN), tokenizer);
      const bodyRoom = room - countEvidenceTokens(title, tokenizer);
      const source = firstChunk.text.slice(0, EVIDENCE_BLOCK_CHAR_CAP);
      let end = 0;
      let used = 0;
      for (const piece of splitPieces(source)) {
        const t = pieceTokens(source.slice(piece.start, piece.end), tokenizer);
        if (used + t > bodyRoom) break;
        used += t;
        end = piece.end;
      }
      const body = end > 0 ? source.slice(0, end).replace(/\s+$/, '') : sliceToTokenCount(source, Math.max(0, bodyRoom), tokenizer);
      Object.assign(firstChunk, { title, text: body + EVIDENCE_CUT_MARKER, cut: true });
      remaining -= chunkCost(firstChunk);
    }
    keptChunks.push(firstChunk);
  } else if (firstBlock) {
    others = blocks.slice(1);
    const floor = floorOf(firstBlock, tokenizer);
    if (floor.tokens <= remaining && floor.chars <= EVIDENCE_BLOCK_CHAR_CAP) {
      for (const i of firstBlock.anchors[0]?.pieces ?? []) firstBlock.selected.add(i);
      remaining -= floor.tokens;
      lead = firstBlock;
    } else {
      remaining = cutToFit(firstBlock, remaining - cutTok, Math.max(0, remaining - cutTok - CUT_BODY_MIN), tokenizer);
      firstBlock.capMarker = true;
    }
    kept.push(firstBlock);
  }

  let stopped = false;
  for (const c of rest) {
    const cost = chunkCost(c);
    if (!stopped && cost <= remaining) { remaining -= cost; keptChunks.push(c); continue; }
    stopped = true;
    drop('budget_note');
  }

  const reserveFloor = (b: Block): boolean => {
    const floor = floorOf(b, tokenizer);
    if (floor.tokens > remaining || floor.chars > EVIDENCE_BLOCK_CHAR_CAP) return false;
    for (const i of b.anchors[0]?.pieces ?? []) b.selected.add(i);
    remaining -= floor.tokens;
    return true;
  };

  if (plan.packing === 'depth_first') {
    if (lead) remaining = enrichBlock(lead, remaining, tokenizer, omitTok);
    for (const b of others) {
      if (!reserveFloor(b)) { drop('budget_floor'); continue; }
      kept.push(b);
      remaining = enrichBlock(b, remaining, tokenizer, omitTok);
    }
  } else if (plan.packing === 'breadth_capped') {
    // k: the longest rank-order prefix of conversations whose title, floor
    // and target window (the window unit's candidates at return_window) fit.
    let capped = false;
    for (const b of lead ? [lead, ...others] : others) {
      if (capped) { drop('breadth_cap'); continue; }
      const window = new Set(windowCandidates(b.doc, b.anchors, plan.window));
      const target = new Set(b.anchors[0]?.pieces ?? []);
      for (const i of enrichmentOrder(b)) {
        if (!window.has(i)) continue;
        target.add(i);
        if (selectionCost(b, target, tokenizer, omitTok).chars > EVIDENCE_BLOCK_CHAR_CAP) { target.delete(i); break; }
      }
      const sel = selectionCost(b, target, tokenizer, omitTok);
      const cost = b.titleTok + sel.tokens - (b === lead ? floorOf(b, tokenizer).tokens : 0);
      if (cost <= remaining && sel.chars <= EVIDENCE_BLOCK_CHAR_CAP) {
        for (const i of target) b.selected.add(i);
        remaining -= cost;
        if (b !== lead) kept.push(b);
        continue;
      }
      capped = true;
      if (b !== lead) drop('breadth_cap');
    }
    for (const b of kept) if (!b.cut) remaining = enrichBlock(b, remaining, tokenizer, omitTok);
  } else {
    for (const b of others) {
      if (reserveFloor(b)) kept.push(b);
      else drop('budget_floor');
    }
    for (const b of kept) if (!b.cut) remaining = enrichBlock(b, remaining, tokenizer, omitTok);
  }
  return { kept, chunks: keptChunks };
}

function emit(b: Block, tokenizer: 'cl100k' | 'heuristic'): { text: string; spans: MatchSpan[]; unmapped: number[]; tokens: number } {
  const order = [...b.selected].sort((x, y) => x - y);
  const emitStart = new Map<number, number>();
  let text = '';
  let gaps = 0;
  let tokens = 0;
  order.forEach((i, k) => {
    const prev = order[k - 1];
    if (k > 0 && !(prev === i - 1 && b.doc.pieces[prev].run === b.doc.pieces[i].run)) {
      text += EVIDENCE_OMISSION;
      gaps++;
    }
    emitStart.set(i, text.length);
    text += b.doc.pieces[i].text;
    tokens += tok(b, i, tokenizer);
  });
  tokens += gaps * pieceTokens(EVIDENCE_OMISSION, tokenizer);
  const trimmed = text.replace(/\s+$/, '');
  const spans: MatchSpan[] = [];
  const unmapped: number[] = [];
  for (const a of b.anchors) {
    if (!a.mapped) { unmapped.push(a.chunk_id); continue; }
    const sel = a.pieces.filter(i => b.selected.has(i));
    if (sel.length === 0) { unmapped.push(a.chunk_id); continue; }
    let segStart = sel[0];
    for (let k = 0; k < sel.length; k++) {
      const i = sel[k];
      const next = sel[k + 1];
      if (next === i + 1 && emitStart.get(next)! === emitStart.get(i)! + b.doc.pieces[i].text.length) continue;
      const first = b.doc.pieces[segStart];
      const last = b.doc.pieces[i];
      const start = emitStart.get(segStart)! + Math.max(0, a.start - first.start);
      const end = Math.min(trimmed.length, emitStart.get(i)! + Math.min(last.text.length, a.end - last.start));
      if (end > start) spans.push({ chunk_id: a.chunk_id, start, end });
      segStart = next;
    }
  }
  return { text: trimmed, spans, unmapped, tokens };
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export interface DeliverOptions {
  /**
   * The hits came from this request's live, authorized retrieval: a fetch
   * failure may fall back to the hit chunk text. When false (cached hits),
   * a fetch failure drops the result instead — uncertain authorization
   * never fails open to cached text.
   */
  liveHits?: boolean;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EvidenceTimeout()), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

class EvidenceTimeout extends Error {}

/**
 * Assemble delivered evidence for ranked hits. Returns NEW result objects
 * (one per page, at the page's best rank) plus the delivery meta. The hit
 * array and its objects are never mutated.
 */
export async function deliverEvidence(
  engine: BrainEngine,
  hits: SearchResult[],
  plan: EvidencePlan,
  scope: DeliveryScope,
  opts: DeliverOptions = {},
): Promise<{ results: DeliveredSearchResult[]; delivery: DeliveryMeta }> {
  const tokenizer = evidenceTokenizer();
  const fallbacks = new Set<string>();
  const dropped: Record<string, number> = {};
  if (plan.budgetClamped) fallbacks.add('budget_clamped');
  if (tokenizer === 'heuristic') fallbacks.add('tokenizer_heuristic');

  // auto keeps every non-conversation hit as its ranked chunk, unchanged;
  // conversation hits are grouped by page like every other unit.
  const auto = plan.unit === 'auto';
  const passthrough: Array<{ rank: number; hit: SearchResult; reason: AutoReason }> = [];
  type Group = { pageId: number | null; hits: SearchResult[]; rank: number; reason?: AutoReason };
  const groups: Group[] = [];
  const byPage = new Map<number, Group>();
  hits.forEach((h, rank) => {
    const signal = auto ? conversationSignal(h) : null;
    if (auto && !signal) { passthrough.push({ rank, hit: h, reason: 'not_conversation' }); return; }
    const id = Number.isFinite(h.page_id) ? h.page_id : null;
    const g = id === null ? undefined : byPage.get(id);
    if (g) { g.hits.push(h); return; }
    const ng: Group = { pageId: id, hits: [h], rank, ...(signal ? { reason: signal } : {}) };
    if (id !== null) byPage.set(id, ng);
    groups.push(ng);
  });

  // Chunks only anchor hits in the page text; every unit but window (and the
  // section fallback to window) needs just the hit chunks themselves.
  const radius = plan.window;
  const requests: ChunkWindowRequest[] = [];
  groups.forEach((g, rank) => {
    if (g.pageId === null) return;
    for (const h of g.hits) {
      const at = Number.isFinite(h.chunk_index) ? h.chunk_index : 0;
      requests.push({ page_id: g.pageId, from_index: Math.max(0, at - radius), to_index: at + radius, priority: rank });
    }
  });
  const maxRows = Math.min(MAX_ROWS, requests.reduce((n, r) => n + (r.to_index - r.from_index + 1), 0));

  let pages: Map<number, ChunkWindowPage> | null = null;
  let fetchFailure: string | null = null;
  if (requests.length > 0) {
    try {
      const rows = await withTimeout(engine.getChunkWindows(requests, {
        ...(scope.sourceIds && scope.sourceIds.length > 0 ? { sourceIds: scope.sourceIds } : scope.sourceId ? { sourceId: scope.sourceId } : {}),
        excludePrivate: scope.excludePrivate,
        requireSafeChunks: requiresSafeChunks(scope),
        chunkSources: scope.detail === 'low' ? ['compiled_truth'] : ['compiled_truth', 'timeline'],
        maxRows,
      }), opts.timeoutMs ?? EVIDENCE_FETCH_TIMEOUT_MS);
      pages = new Map(rows.map(p => [p.page_id, p]));
    } catch (e) {
      fetchFailure = e instanceof EvidenceTimeout ? 'fetch_timeout' : 'fetch_failed';
      fallbacks.add(fetchFailure);
    }
  }

  const planned: Block[] = [];
  for (const g of groups) {
    let b: PlannedBlock;
    if (g.pageId === null) {
      b = fallbackBlock(g.hits[0], g.hits, 'page_missing');
    } else if (fetchFailure) {
      if (opts.liveHits === false) { dropped.not_readable = (dropped.not_readable ?? 0) + 1; continue; }
      b = fallbackBlock(g.hits[0], g.hits, fetchFailure);
    } else {
      const page = pages?.get(g.pageId);
      if (!page) { dropped.not_readable = (dropped.not_readable ?? 0) + 1; continue; }
      b = planBlock(page, g.hits, plan, scope.detail !== 'low');
    }
    if (b.fallbackReason) fallbacks.add(b.fallbackReason);
    const title = b.hit.title ?? '';
    planned.push({ ...b, title, titleTok: countEvidenceTokens(title, tokenizer), rank: g.rank, ...(g.reason ? { reason: g.reason } : {}) });
  }

  const capped = capEngaged(plan);
  let kept: Block[];
  let chunkItems: ChunkItem[] = [];
  if (capped) {
    ({ kept, chunks: chunkItems } = allocateCapped(planned,
      passthrough.map(p => ({ ...p, title: p.hit.title ?? '', text: p.hit.chunk_text ?? '', cut: false })), plan, tokenizer, dropped));
  } else {
    // Unchanged chunks are paid for first; conversations share the rest, and one
    // whose matching span no longer fits keeps its ranked chunks instead.
    const reserved = passthrough.reduce((n, p) => n + countEvidenceTokens(p.hit.chunk_text ?? '', tokenizer) + countEvidenceTokens(p.hit.title ?? '', tokenizer), 0);
    kept = allocate(planned, Math.max(0, plan.budgetTokens - reserved), tokenizer, dropped, auto
      ? b => { for (const h of b.hits) passthrough.push({ rank: hits.indexOf(h), hit: h, reason: 'conversation_over_budget' }); }
      : undefined);
  }
  let results: DeliveredSearchResult[] = kept.map(b => {
    const out = emit(b, tokenizer);
    const text = b.capMarker ? out.text + EVIDENCE_CUT_MARKER : out.text;
    const truncated = b.cut || b.selected.size < b.candidates.length;
    const delivered: DeliveredEvidence = {
      unit: b.unit,
      chunk_ids: b.hits.map(h => h.chunk_id),
      match_spans: out.spans,
      tokens: b.capMarker ? countEvidenceTokens(text, tokenizer) : out.tokens,
      truncated,
      ...(b.revision ? { revision: b.revision } : {}),
      ...(out.unmapped.length > 0 ? { unmapped_chunk_ids: out.unmapped } : {}),
      ...(b.fallbackReason && b.unit === 'chunk' ? { fallback_reason: b.fallbackReason } : {}),
      ...(b.reason ? { reason: b.reason } : {}),
    };
    return { ...b.hit, title: b.title, chunk_text: text, delivered };
  });

  // Under the cap the kept chunks join before redaction, so every evidence
  // field is redacted and recounted inside the budget.
  if (capped) {
    const ranked = results.map((r, i) => ({ rank: kept[i].rank, r }));
    for (const c of chunkItems) ranked.push({ rank: c.rank, r: chunkResult(c, tokenizer) });
    results = ranked.sort((a, b) => a.rank - b.rank).map(x => x.r);
  }
  results = redactDelivered(results, tokenizer, fallbacks);

  if (!capped && passthrough.length > 0) {
    const ranked = results.map((r, i) => ({ rank: kept[i].rank, r }));
    for (const p of passthrough) ranked.push({ rank: p.rank, r: chunkResult({ ...p, title: p.hit.title ?? '', text: p.hit.chunk_text ?? '', cut: false }, tokenizer) });
    results = ranked.sort((a, b) => a.rank - b.rank).map(x => x.r);
  }

  const tokensDelivered = results.reduce((n, r) => n + r.delivered.tokens, 0);
  const budgetUsed = tokensDelivered + results.reduce((n, r) => n + countEvidenceTokens(r.title ?? '', tokenizer), 0);
  const droppedTotal = Object.values(dropped).reduce((n, v) => n + v, 0);
  const delivery: DeliveryMeta = {
    requested_unit: plan.requestedUnit,
    applied_unit: fetchFailure ? 'chunk' : plan.unit,
    return_window: plan.window,
    budget_tokens: plan.budgetTokens,
    budget_used: budgetUsed,
    tokens_delivered: tokensDelivered,
    tokenizer,
    coordinates: 'utf16',
    blocks: results.length,
    dropped: droppedTotal,
    dropped_reasons: dropped,
    fallbacks: [...fallbacks].sort(),
    ...(plan.budgetClamped ? { budget_clamped: plan.budgetClamped } : {}),
    ...(capped ? { auto_packing: plan.packing } : {}),
  };
  return { results: capped ? capEvidenceToBudget(results, delivery) : results, delivery };
}

/** A non-conversation hit's delivered row: the ranked chunk unchanged, or the cap's cut prefix of it. */
function chunkResult(c: ChunkItem, tokenizer: 'cl100k' | 'heuristic'): DeliveredSearchResult {
  const text = c.cut ? c.text : c.hit.chunk_text ?? '';
  const matched = c.cut ? text.length - EVIDENCE_CUT_MARKER.length : text.length;
  return { ...c.hit, ...(c.cut ? { title: c.title, chunk_text: text } : {}), delivered: {
    unit: 'chunk',
    chunk_ids: [c.hit.chunk_id],
    match_spans: matched > 0 ? [{ chunk_id: c.hit.chunk_id, start: 0, end: matched }] : [],
    tokens: countEvidenceTokens(text, tokenizer),
    truncated: c.cut,
    reason: c.reason,
  } };
}

/**
 * Budget after redaction: blocks pass through the same secret redaction as
 * every search response before spans and tokens are final. A block the
 * redactor changed loses its spans (explicit unmapped state) and is
 * re-counted, never allowed to grow past its allocation.
 */
function redactDelivered(results: DeliveredSearchResult[], tokenizer: 'cl100k' | 'heuristic', fallbacks: Set<string>): DeliveredSearchResult[] {
  const redacted = redactRetrievalOutput(results, {}).results;
  return results.map((r, i) => {
    const rr = redacted[i];
    if (rr.chunk_text === r.chunk_text && rr.title === r.title) return r;
    fallbacks.add('redaction_unmapped');
    let text = rr.chunk_text;
    const titleTok = countEvidenceTokens(rr.title ?? '', tokenizer);
    const allowed = r.delivered.tokens + countEvidenceTokens(r.title ?? '', tokenizer) - titleTok;
    if (countEvidenceTokens(text, tokenizer) > allowed) text = sliceToTokenCount(text, allowed, tokenizer);
    const unmapped = [...new Set([...(r.delivered.unmapped_chunk_ids ?? []), ...r.delivered.match_spans.map(s => s.chunk_id)])];
    return {
      ...r,
      title: rr.title,
      chunk_text: text,
      delivered: {
        ...r.delivered,
        match_spans: [],
        tokens: countEvidenceTokens(text, tokenizer),
        ...(unmapped.length > 0 ? { unmapped_chunk_ids: unmapped } : {}),
      },
    };
  });
}

/**
 * The cap's final evidence boundary: recount every row's evidence fields
 * (title and chunk_text, with every marker in it) and keep the rank-order
 * rows that fit `budget_tokens`. A row that would cross it is cut with
 * EVIDENCE_CUT_MARKER when a body still fits (rank one always is), otherwise
 * dropped as `budget_recount`. `budget_used`, `tokens_delivered`, `blocks`
 * and `dropped` are rewritten from the recount. Runs only when the delivery
 * carries `auto_packing`; everything else is returned as is.
 */
export function capEvidenceToBudget<T extends SearchResult & { delivered?: DeliveredEvidence }>(results: T[], delivery: DeliveryMeta): T[] {
  if (!delivery.auto_packing) return results;
  const tokenizer = delivery.tokenizer;
  const count = (text: string | undefined) => countEvidenceTokens(text ?? '', tokenizer);
  const cutTok = count(EVIDENCE_CUT_MARKER);
  let remaining = delivery.budget_tokens;
  let lost = 0;
  const out: T[] = [];
  for (const r of results) {
    const titleTok = count(r.title);
    const textTok = count(r.chunk_text);
    if (titleTok + textTok <= remaining) {
      remaining -= titleTok + textTok;
      out.push(!r.delivered || r.delivered.tokens === textTok ? r : { ...r, delivered: { ...r.delivered, tokens: textTok } });
      continue;
    }
    if (out.length > 0 && remaining - titleTok - cutTok < CUT_BODY_MIN) { lost++; continue; }
    const title = titleTok > Math.max(0, remaining - cutTok - CUT_BODY_MIN) ? sliceToTokenCount(r.title ?? '', Math.max(0, remaining - cutTok - CUT_BODY_MIN), tokenizer) : r.title ?? '';
    const source = (r.chunk_text ?? '').endsWith(EVIDENCE_CUT_MARKER) ? (r.chunk_text ?? '').slice(0, -EVIDENCE_CUT_MARKER.length) : r.chunk_text ?? '';
    const body = sliceToTokenCount(source, Math.max(0, remaining - count(title) - cutTok), tokenizer).replace(/\s+$/, '');
    const text = body + EVIDENCE_CUT_MARKER;
    remaining -= count(title) + count(text);
    const row = { ...r, title, chunk_text: text } as T;
    if (r.delivered) {
      const spans = r.delivered.match_spans.filter(s => s.start < body.length).map(s => ({ ...s, end: Math.min(s.end, body.length) }));
      const unmapped = [...new Set([...(r.delivered.unmapped_chunk_ids ?? []), ...r.delivered.match_spans.map(s => s.chunk_id).filter(id => !spans.some(s => s.chunk_id === id))])];
      row.delivered = { ...r.delivered, match_spans: spans, tokens: count(text), truncated: true, ...(unmapped.length > 0 ? { unmapped_chunk_ids: unmapped } : {}) };
    }
    out.push(row);
  }
  if (lost > 0) {
    delivery.dropped_reasons = { ...delivery.dropped_reasons, budget_recount: (delivery.dropped_reasons.budget_recount ?? 0) + lost };
    delivery.dropped += lost;
  }
  delivery.blocks = out.length;
  delivery.tokens_delivered = out.reduce((n, r) => n + (r.delivered?.tokens ?? count(r.chunk_text)), 0);
  delivery.budget_used = delivery.tokens_delivered + out.reduce((n, r) => n + count(r.title), 0);
  return out;
}

/**
 * Explicit `snippet_chars` precedence: cap delivered blocks at `cap`
 * characters (marker names the get_page recovery move), clip spans, mark
 * truncated and re-count. Non-mutating.
 */
export function capDeliveredSnippets<T extends SearchResult & { delivered?: DeliveredEvidence }>(
  results: T[],
  cap: number,
  delivery: DeliveryMeta,
): T[] {
  if (!Number.isFinite(cap) || cap <= 0) return results;
  let any = false;
  const tokenizer = delivery.tokenizer;
  let markerOmitted = false;
  const out = results.map(r => {
    if (typeof r.chunk_text !== 'string' || r.chunk_text.length <= cap) return r;
    any = true;
    let keep = cap;
    let text = r.chunk_text.slice(0, cap) + buildSnippetMarker(r.slug, r.chunk_text.length - cap);
    if (delivery.auto_packing) {
      // Under the cap the marker is paid from the row's own allocation: a
      // capped row never grows past what it held before the snippet cap.
      const allowed = countEvidenceTokens(r.chunk_text, tokenizer);
      if (countEvidenceTokens(text, tokenizer) > allowed) {
        const markerTok = countEvidenceTokens(buildSnippetMarker(r.slug, r.chunk_text.length), tokenizer);
        const withMarker = allowed - markerTok >= 1;
        const body = sliceToTokenCount(r.chunk_text.slice(0, cap), withMarker ? allowed - markerTok : allowed, tokenizer);
        keep = body.length;
        text = withMarker ? body + buildSnippetMarker(r.slug, r.chunk_text.length - keep) : body;
        if (!withMarker) markerOmitted = true;
      }
    }
    if (!r.delivered) return { ...r, chunk_text: text };
    const spans = r.delivered.match_spans.filter(s => s.start < keep).map(s => ({ ...s, end: Math.min(s.end, keep) }));
    const lost = r.delivered.match_spans.filter(s => s.start >= keep).map(s => s.chunk_id);
    const unmapped = [...new Set([...(r.delivered.unmapped_chunk_ids ?? []), ...lost.filter(id => !spans.some(s => s.chunk_id === id))])];
    return {
      ...r,
      chunk_text: text,
      delivered: {
        ...r.delivered,
        match_spans: spans,
        tokens: countEvidenceTokens(text, tokenizer),
        truncated: true,
        ...(unmapped.length > 0 ? { unmapped_chunk_ids: unmapped } : {}),
      },
    };
  });
  if (!any) return results;
  if (!delivery.fallbacks.includes('snippet_cap')) delivery.fallbacks = [...delivery.fallbacks, 'snippet_cap'].sort();
  if (markerOmitted && !delivery.fallbacks.includes('snippet_marker_omitted')) delivery.fallbacks = [...delivery.fallbacks, 'snippet_marker_omitted'].sort();
  delivery.tokens_delivered = out.reduce((n, r) => n + (r.delivered?.tokens ?? 0), 0);
  return capEvidenceToBudget(out, delivery);
}

/** Image-query branches never expand; the meta says so instead of staying silent. */
export function unsupportedDelivery(plan: EvidencePlan, reason: string): DeliveryMeta {
  return {
    requested_unit: plan.requestedUnit,
    applied_unit: 'chunk',
    return_window: plan.window,
    budget_tokens: plan.budgetTokens,
    budget_used: 0,
    tokens_delivered: 0,
    tokenizer: evidenceTokenizer(),
    coordinates: 'utf16',
    blocks: 0,
    dropped: 0,
    dropped_reasons: {},
    fallbacks: [reason],
    ...(plan.budgetClamped ? { budget_clamped: plan.budgetClamped } : {}),
  };
}

// ---------------------------------------------------------------------------
// Frozen-candidate interface (gbrain-evals E1/E3 parity)
// ---------------------------------------------------------------------------

export interface FrozenHit { source_id: string; slug: string; chunk_id: number }

export interface AssembleEvidenceInput {
  hits: FrozenHit[];
  return_unit: ReturnUnit;
  return_window?: number;
  budget_tokens?: number;
  detail?: 'low' | 'medium' | 'high';
  caller?: { remote?: boolean; sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean };
  /**
   * Library only (trusted local, never an MCP param): the packing for this
   * call's explicit `auto` budget, winning over search.auto_packing, so an
   * evaluation can compare packings on one frozen hit list.
   */
  auto_packing?: AutoPacking;
}

export interface AssembleEvidenceOutput {
  results: Array<SearchResult & { delivered?: DeliveredEvidence }>;
  delivery: DeliveryMeta | null;
  unresolved: number[];
}

export const MAX_ASSEMBLE_HITS = 50;

/**
 * Resolve frozen (source_id, slug, chunk_id) hits into search rows under the
 * caller's read scope (one query). Hits outside the scope, on deleted or
 * private-to-this-caller pages, or naming a chunk the page no longer holds
 * are unresolved. chunk_id 0 addresses the page's first chunk.
 */
export async function resolveFrozenHits(
  engine: BrainEngine,
  hits: FrozenHit[],
  scope: PageReadScope,
): Promise<{ rows: SearchResult[]; unresolved: number[] }> {
  if (hits.length === 0) return { rows: [], unresolved: [] };
  const params: unknown[] = [
    hits.map(h => String(h.source_id)),
    hits.map(h => String(h.slug)),
    hits.map(h => (Number.isInteger(h.chunk_id) ? h.chunk_id : -1)),
    hits.map((_, i) => i),
  ];
  const filter = pageReadFilter('p', scope, params, true);
  const safe = requiresSafeChunks(scope) ? `AND ${safeChunksFilter('p')}` : '';
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT h.ord, p.id AS page_id, p.slug, p.source_id, p.title, p.type,
            p.effective_date, p.effective_date_source,
            cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
       FROM unnest($1::text[], $2::text[], $3::int[], $4::int[]) AS h(source_id, slug, chunk_id, ord)
       JOIN pages p ON p.source_id = h.source_id AND p.slug = h.slug
       LEFT JOIN content_chunks cc ON cc.page_id = p.id
            AND CASE WHEN h.chunk_id > 0 THEN cc.id = h.chunk_id ELSE cc.chunk_index = 0 END
      WHERE ${filter} AND ${currentTextProjectionFilter('p')} ${safe}`,
    params,
  );
  const byOrd = new Map<number, Record<string, unknown>>();
  for (const r of rows) byOrd.set(Number(r.ord), r);
  const out: SearchResult[] = [];
  const unresolved: number[] = [];
  hits.forEach((h, i) => {
    const r = byOrd.get(i);
    if (!r || (h.chunk_id > 0 && r.chunk_id == null) || h.chunk_id < 0) { unresolved.push(i); return; }
    const row: SearchResult = {
      slug: String(r.slug),
      page_id: Number(r.page_id),
      source_id: String(r.source_id),
      title: String(r.title ?? ''),
      type: r.type as SearchResult['type'],
      chunk_text: r.chunk_text == null ? '' : String(r.chunk_text),
      chunk_source: (r.chunk_source ?? 'compiled_truth') as SearchResult['chunk_source'],
      chunk_id: r.chunk_id == null ? 0 : Number(r.chunk_id),
      chunk_index: r.chunk_index == null ? 0 : Number(r.chunk_index),
      score: 0,
      stale: false,
    };
    // The page date, normalized exactly as live search rows are, so frozen
    // and live delivery hand a reader the same date fields.
    applyEffectiveDate(row, r);
    out.push(row);
  });
  return { rows: out, unresolved };
}

/**
 * The library entry gbrain-evals calls for a frozen candidate list: the
 * same plan resolution, assembler and output redaction the `query` op
 * applies, for these hits. `caller.remote` selects the trust class
 * (default trusted local).
 */
export async function assembleEvidenceForHits(engine: BrainEngine, input: AssembleEvidenceInput): Promise<AssembleEvidenceOutput> {
  if (!Array.isArray(input.hits)) throw new OperationError('invalid_params', 'hits must be an array of { source_id, slug, chunk_id }.',
    'Pass hits as an array of { source_id, slug, chunk_id } objects, e.g. [{ "source_id": "default", "slug": "notes/a", "chunk_id": 12 }], ranked best first.');
  if (input.hits.length > MAX_ASSEMBLE_HITS) {
    throw new OperationError('invalid_params', `hits holds at most ${MAX_ASSEMBLE_HITS} entries (got ${input.hits.length}).`, 'Pass the top-ranked hits only.');
  }
  const remote = input.caller?.remote === true;
  const excludePrivate = input.caller?.excludePrivate ?? await resolveExcludePrivatePages(engine, remote ? true : false);
  const scope: DeliveryScope = {
    ...(input.caller?.sourceIds && input.caller.sourceIds.length > 0 ? { sourceIds: input.caller.sourceIds } : input.caller?.sourceId ? { sourceId: input.caller.sourceId } : {}),
    excludePrivate,
    requireSafeChunks: remote,
    ...(input.detail ? { detail: input.detail } : {}),
  };
  const plan = await resolveEvidencePlan(engine, {
    remote,
    returnUnit: input.return_unit ?? 'page',
    returnWindow: input.return_window,
    budget: input.budget_tokens,
    snippetChars: undefined,
    snippetCap: 0,
    op: 'assemble_evidence',
    autoPacking: input.auto_packing,
  });
  const { rows, unresolved } = await resolveFrozenHits(engine, input.hits, scope);
  if (!plan) {
    const out = redactRetrievalOutput(rows, {});
    return { results: out.results, delivery: null, unresolved };
  }
  const d = await deliverEvidence(engine, rows, plan, scope, { liveHits: true });
  const out = redactRetrievalOutput(d.results, d.delivery);
  return { results: capEvidenceToBudget(out.results, out.meta), delivery: out.meta, unresolved };
}

/** SHA-256 over the delivered evidence (see docs/evidence-delivery.md). */
export function evidenceFingerprint(results: Array<{ source_id?: string; slug: string; chunk_text: string; chunk_id: number; delivered?: { unit: string; chunk_ids: number[] } }>): string {
  const canon = results.map(r => [r.source_id ?? 'default', r.slug, r.chunk_text, r.delivered?.unit ?? 'chunk', r.delivered?.chunk_ids ?? [r.chunk_id]]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/**
 * Thin-client version skew: `return_unit` was requested but the response
 * carries no delivery meta (an older server ignored the param). Returns the
 * one-line warning, or null.
 */
export function deliveryVersionSkewWarning(
  opName: string,
  params: Record<string, unknown>,
  retrievalMeta: Record<string, unknown> | null | undefined,
  result: unknown,
): string | null {
  if (!['search', 'query', 'recall'].includes(opName)) return null;
  const unit = params.return_unit;
  if (typeof unit !== 'string' || unit === 'chunk') return null;
  const present = opName === 'recall'
    ? typeof result === 'object' && result !== null && 'delivery' in result
    : !!retrievalMeta && 'delivery' in retrievalMeta;
  if (present) return null;
  return `warning: the server ignored return_unit (evidence delivery needs gbrain server v${EVIDENCE_DELIVERY_MIN_SERVER_VERSION} or newer); results are plain chunks.`;
}
