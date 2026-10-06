/**
 * retrieval-arms.ts — eval-only retrieval arms for `gbrain eval longmemeval`:
 * fact keys and time scope. Nothing here runs in production; the arms let
 * a dev-split run measure a mechanism before any product code depends on it.
 *
 * Fact keys (`--fact-keys chunk|page`): after a question's sessions are
 * imported, each session's facts are extracted (`--fact-extractor paper` —
 * the benchmark's published user-turn fact prompt; `production` — gbrain's
 * own facts extractor, 8,000-char input as shipped), merged into the
 * embedding input of that session's chunks (src/core/fact-keys.ts), and the
 * chunks are re-embedded in place. `chunk_text` is untouched, so retrieval
 * still returns the raw session. Extractions are cached on disk by
 * content hash so arms and reruns never pay twice.
 *
 * Time scope (`--time-scope reserved|partition`): the question's explicit
 * time range (src/core/search/time-range.ts, resolved against the dataset's
 * question date) re-orders a widened candidate pool by the sessions' dates
 * (observation date + dates the session mentions). The unscoped top-k from
 * the same pool rides on the row, so each run is its own paired control.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { BrainEngine } from '../../core/engine.ts';
import type { ThinkLLMClient } from '../../core/think/index.ts';
import type { SearchResult } from '../../core/types.ts';
import { assignFactKeys, factKeyedEmbeddingInput, type FactKeyAssignment } from '../../core/fact-keys.ts';
import { embedBatch } from '../../core/embedding.ts';
import { quoteIdentifier, resolveActiveEmbeddingColumnFromEngine, vectorCastSuffix } from '../../core/search/embedding-column.ts';
import { canonicalLookup } from '../../core/model-pricing.ts';
import { extractFactsFromTurnWithOutcome } from '../../core/facts/extract.ts';
import { parseQueryTimeRange, type TimeRangeParse } from '../../core/search/time-range.ts';
import { applyTimeScope, type TimeScopeMode } from '../../core/search/hybrid/time-scope.ts';
import { extractEventDates } from '../../core/event-dates.ts';
import type { DayRange } from '../../core/temporal-grammar.ts';
import { resolveModel } from '../../core/model-config.ts';
import { rawSessionId, scoreRecall, type SlugToRawMap } from './metrics.ts';

export type FactExtractor = 'paper' | 'production';

const FACT_EXTRACT_CONCURRENCY = 8;

export interface FactKeyArm {
  assignment: FactKeyAssignment;
  extractor: FactExtractor;
  model: string;
  client: ThinkLLMClient;
  maxUsd: number;
  cachePath?: string;
}

/** The benchmark's published user-fact extraction instruction (zero-shot form). */
export const PAPER_USER_FACT_SYSTEM = 'You will be given a list of messages from a human user to an AI assistant. Extract all the personal information, life events, experience, and preferences related to the user. Make sure you include all details such as life events, personal experience, preferences, specific numbers, locations, or dates. State each piece of information in a simple sentence. Put these sentences in a json list, each element being a standalone personal fact about the user. Minimize the coreference across the facts, e.g., replace pronouns with actual entities. If there is no specific events, personal information, or preference mentioned, just generate an empty list.';

export function defaultFactCachePath(extractor: FactExtractor, model: string): string {
  return join(homedir(), '.cache', 'gbrain-eval', `fact-keys-${extractor}-${model.replace(/[^a-z0-9.-]+/gi, '_')}.jsonl`);
}

export class FactKeySpend {
  usd = 0;
  calls = 0;
  cacheHits = 0;
  constructor(readonly maxUsd: number) {}
  add(model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined): void {
    this.calls++;
    const p = canonicalLookup(model);
    if (!p || !usage) return;
    this.usd += ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output) / 1_000_000;
  }
  exhausted(): boolean {
    return this.usd >= this.maxUsd;
  }
}

class FactCache {
  private readonly map = new Map<string, string[]>();
  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { key: string; items: string[] };
        if (row && typeof row.key === 'string' && Array.isArray(row.items)) this.map.set(row.key, row.items);
      } catch { /* a torn final line is skipped */ }
    }
  }
  get(key: string): string[] | undefined { return this.map.get(key); }
  set(key: string, items: string[]): void {
    this.map.set(key, items);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ key, items })}\n`);
  }
}

const caches = new Map<string, FactCache>();
function cacheFor(path: string): FactCache {
  let c = caches.get(path);
  if (!c) { c = new FactCache(path); caches.set(path, c); }
  return c;
}

/** Session body without frontmatter. */
function bodyOf(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function userTurns(body: string): string {
  return body.split(/\n\n(?=\*\*(?:user|assistant):\*\*)/)
    .filter(t => t.startsWith('**user:**'))
    .map(t => `user: ${t.slice('**user:**'.length).trim()}`)
    .join('\n');
}

function parseJsonList(text: string): string[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
  } catch {
    return [];
  }
}

async function extractItems(engine: BrainEngine, arm: FactKeyArm, body: string, spend: FactKeySpend): Promise<string[]> {
  const cache = cacheFor(arm.cachePath ?? defaultFactCachePath(arm.extractor, arm.model));
  const key = createHash('sha256').update(`${arm.extractor}\n${arm.model}\n${body}`).digest('hex');
  const hit = cache.get(key);
  if (hit) { spend.cacheHits++; return hit; }
  if (spend.exhausted()) throw new Error(`fact-key extraction spend reached its cap ($${spend.maxUsd.toFixed(2)}); raise --fact-keys-max-usd or reuse the cache at ${arm.cachePath ?? defaultFactCachePath(arm.extractor, arm.model)}`);
  let items: string[];
  if (arm.extractor === 'paper') {
    const turns = userTurns(body);
    if (!turns) { cache.set(key, []); return []; }
    const res = await arm.client.create({
      model: arm.model, max_tokens: 2000, system: PAPER_USER_FACT_SYSTEM,
      messages: [{ role: 'user', content: `Human user messages:\n${turns}\n\nPersonal facts about the user (a list of strings in json format; do not generate anything else):` }],
    });
    spend.add(arm.model, (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage);
    const block = res.content.find(b => b.type === 'text');
    items = parseJsonList(block && 'text' in block ? block.text : '');
  } else {
    const outcome = await extractFactsFromTurnWithOutcome({ turnText: body, source: 'longmemeval:fact-keys', model: arm.model, engine });
    spend.calls++;
    if (!outcome.ok && outcome.reason === 'chat_unavailable') throw new Error(`production fact extractor unavailable (${outcome.reason}) for ${arm.model}`);
    items = !outcome.ok ? [] : outcome.facts.map(f => f.fact).filter(f => typeof f === 'string' && f.trim().length > 0);
  }
  cache.set(key, items);
  return items;
}

export interface FactKeyArmResult {
  pages_keyed: number;
  chunks_keyed: number;
  items: number;
}

/**
 * Extract facts for every imported session and re-embed its chunks with the
 * fact keys merged into the embedding input. Runs inside the harness's
 * embed-cache transaction, so identical inputs reuse cached vectors.
 */
export async function applyFactKeyArm(
  engine: BrainEngine,
  pages: ReadonlyArray<{ slug: string; content: string }>,
  arm: FactKeyArm,
  spend: FactKeySpend,
): Promise<FactKeyArmResult> {
  const col = await resolveActiveEmbeddingColumnFromEngine(engine);
  const column = quoteIdentifier(col.name);
  const cast = vectorCastSuffix(col);
  const out: FactKeyArmResult = { pages_keyed: 0, chunks_keyed: 0, items: 0 };
  const extracted = new Map<string, string[]>();
  const queue = [...pages];
  await Promise.all(Array.from({ length: Math.min(FACT_EXTRACT_CONCURRENCY, queue.length) }, async () => {
    for (let page = queue.shift(); page; page = queue.shift()) extracted.set(page.slug, await extractItems(engine, arm, bodyOf(page.content), spend));
  }));
  for (const page of pages) {
    const items = extracted.get(page.slug) ?? [];
    if (items.length === 0) continue;
    const chunks = await engine.executeRaw<{ id: number; chunk_text: string; chunk_source: string | null; title: string | null }>(
      `SELECT c.id, c.chunk_text, c.chunk_source, p.title FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE p.slug = $1 ORDER BY c.chunk_index`, [page.slug]);
    if (chunks.length === 0) continue;
    const keys = assignFactKeys(items, chunks, arm.assignment);
    const targets = chunks.map((c, i) => ({ c, k: keys[i] })).filter(t => t.k);
    if (targets.length === 0) continue;
    const vectors = await embedBatch(targets.map(t => factKeyedEmbeddingInput(t.c.chunk_text, t.c.title, t.k)));
    for (let i = 0; i < targets.length; i++) {
      await engine.executeRaw(`UPDATE content_chunks SET ${column} = $1${cast} WHERE id = $2`, [`[${Array.from(vectors[i]).join(',')}]`, targets[i].c.id]);
    }
    out.pages_keyed++;
    out.chunks_keyed += targets.length;
    out.items += items.length;
  }
  return out;
}

/** '2023/05/20 (Sat) 02:21' → '2023-05-20'; anything else → null. */
export function datasetDay(raw: string | undefined): string | null {
  const m = raw ? /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(raw.trim()) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export interface TimeScopeArmRow {
  time_scope: { mode: TimeScopeMode; reason: TimeRangeParse['reason']; range: DayRange | null; cue: string | null; in_range: number; moved: number };
  unscoped_slugs: string[];
}

/**
 * Re-order a widened pool by the question's explicit time range. Returns the
 * scoped top-k plus the unscoped top-k from the same pool for pairing.
 */
export function applyTimeScopeArm(
  pool: readonly SearchResult[],
  question: { question: string; question_date?: string },
  pageMeta: ReadonlyArray<{ slug: string; content: string; date?: string }>,
  mode: TimeScopeMode,
  k: number,
): { results: SearchResult[]; row: TimeScopeArmRow } {
  const distinct = (rs: readonly SearchResult[]) => {
    const seen = new Set<string>();
    return rs.filter(r => (seen.has(r.slug) ? false : (seen.add(r.slug), true)));
  };
  const unscoped = distinct(pool).slice(0, k);
  const ref = datasetDay(question.question_date);
  const parsed: TimeRangeParse = ref ? parseQueryTimeRange(question.question, ref) : { range: null, reason: 'no_cue' };
  const row: TimeScopeArmRow = {
    time_scope: { mode, reason: parsed.reason, range: parsed.range ? { start: parsed.range.start, end: parsed.range.end } : null, cue: parsed.range?.cue ?? null, in_range: 0, moved: 0 },
    unscoped_slugs: unscoped.map(r => r.slug),
  };
  if (!parsed.range) return { results: unscoped, row };
  const datesBySlug = new Map<string, DayRange[]>();
  for (const p of pageMeta) datesBySlug.set(p.slug, extractEventDates(bodyOf(p.content), datasetDay(p.date)));
  const scoped = applyTimeScope(distinct(pool), parsed.range, r => datesBySlug.get(r.slug), { mode, k });
  row.time_scope.in_range = scoped.inRange;
  row.time_scope.moved = scoped.moved;
  return { results: scoped.results.slice(0, k), row };
}

/** Parsed `--fact-keys*` / `--time-scope*` options (eval-only arms). */
export interface RetrievalArmOptions {
  factKeys?: FactKeyAssignment;
  factExtractor: FactExtractor;
  factKeysModel?: string;
  factKeysMaxUsd: number;
  timeScope?: TimeScopeMode;
  timeScopePool: number;
}

export function newRetrievalArmOptions(): RetrievalArmOptions {
  return { factExtractor: 'paper', factKeysMaxUsd: 20, timeScopePool: 50 };
}

export const LME_RETRIEVAL_ARM_FLAGS: Array<{ name: string; arg?: string; help: string[]; apply: (o: { arms: RetrievalArmOptions }, value: string) => void }> = [
  { name: '--fact-keys', arg: 'chunk|page', help: [
      'Eval-only arm: merge each session\'s extracted facts into the embedding',
      'input of its chunks (chunk = each fact on its best-matching chunk; page =',
      'all facts on every chunk) and re-embed. Retrieval still returns raw sessions.'],
    apply: (o, v) => { if (v !== 'chunk' && v !== 'page') throw new Error(`--fact-keys must be chunk|page (got: ${v})`); o.arms.factKeys = v; } },
  { name: '--fact-extractor', arg: 'paper|production', help: [
      'Fact source for --fact-keys: paper = the benchmark\'s published user-turn',
      'fact prompt; production = gbrain\'s facts extractor as shipped (default: paper).'],
    apply: (o, v) => { if (v !== 'paper' && v !== 'production') throw new Error(`--fact-extractor must be paper|production (got: ${v})`); o.arms.factExtractor = v; } },
  { name: '--fact-keys-model', arg: 'MODEL', help: ['Extraction model for --fact-keys (default: the utility tier, haiku).'],
    apply: (o, v) => { o.arms.factKeysModel = v; } },
  { name: '--fact-keys-max-usd', arg: 'N', help: ['Spend cap for uncached fact extraction (default 20). Cached extractions are free.'],
    apply: (o, v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`--fact-keys-max-usd must be a positive number (got: ${v})`); o.arms.factKeysMaxUsd = n; } },
  { name: '--time-scope', arg: 'reserved|partition', help: [
      'Eval-only arm: re-order a widened pool by the question\'s explicit time range',
      '(resolved against question_date) using each session\'s observation and',
      'mentioned dates. reserved keeps the top half of k in place; partition',
      'moves every in-range session first. Rows also carry the unscoped top-k.'],
    apply: (o, v) => { if (v !== 'reserved' && v !== 'partition') throw new Error(`--time-scope must be reserved|partition (got: ${v})`); o.arms.timeScope = v; } },
  { name: '--time-scope-pool', arg: 'N', help: ['Candidate pool depth for --time-scope (default 50).'],
    apply: (o, v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 300) throw new Error(`--time-scope-pool must be an integer from 1 to 300 (got: ${v})`); o.arms.timeScopePool = n; } },
];

/** Folds active arms into retrieval_config_hash; empty when no arm is on (existing receipts keep their hash). */
export function armPins(o: RetrievalArmOptions): { retrieval_arms?: Record<string, unknown> } {
  const pins: Record<string, unknown> = {};
  if (o.factKeys) Object.assign(pins, { fact_keys: o.factKeys, fact_extractor: o.factExtractor, fact_keys_model: o.factKeysModel ?? 'utility-tier' });
  if (o.timeScope) Object.assign(pins, { time_scope: o.timeScope, time_scope_pool: o.timeScopePool });
  return Object.keys(pins).length > 0 ? { retrieval_arms: pins } : {};
}

export async function resolveFactKeyArm(o: RetrievalArmOptions, client: ThinkLLMClient): Promise<{ arm: FactKeyArm; spend: FactKeySpend } | null> {
  if (!o.factKeys) return null;
  const model = o.factExtractor === 'production' && !o.factKeysModel
    ? await resolveModel(null, { configKey: 'facts.extraction_model', tier: 'reasoning', fallback: 'anthropic:claude-sonnet-4-6' })
    : await resolveModel(null, { cliFlag: o.factKeysModel, tier: 'utility', fallback: 'haiku' });
  return { arm: { assignment: o.factKeys, extractor: o.factExtractor, model, client, maxUsd: o.factKeysMaxUsd }, spend: new FactKeySpend(o.factKeysMaxUsd) };
}

/** Row fields for a time-scope run: the decision, plus the unscoped top-k's recall from the same pool. */
export function timeScopeRowExtras(row: TimeScopeArmRow, slugToRaw: SlugToRawMap, gold: readonly string[], k: number): Record<string, unknown> {
  const unscopedRaw = row.unscoped_slugs.map(s => rawSessionId(s, slugToRaw));
  const score = gold.length > 0 ? scoreRecall(unscopedRaw, gold, k) : null;
  return {
    time_scope: row.time_scope,
    unscoped_retrieved_session_ids: unscopedRaw,
    ...(score ? { unscoped_recall_all_hit: score.recall_all_hit, unscoped_recall_any_hit: score.recall_any_hit } : {}),
  };
}

/** Harness hook: applies the time-scope arm (when on) to a widened search result and records its row fields. */
export function scopeResults(
  found: SearchResult[],
  o: RetrievalArmOptions,
  c: { q: { question: string; question_date?: string }; pageMeta: ReadonlyArray<{ slug: string; content: string; date?: string }>; slugToRaw: SlugToRawMap; gold: readonly string[]; k: number; extra: Record<string, unknown> },
): SearchResult[] {
  if (!o.timeScope) return found;
  const scoped = applyTimeScopeArm(found, c.q, c.pageMeta, o.timeScope, c.k);
  Object.assign(c.extra, timeScopeRowExtras(scoped.row, c.slugToRaw, c.gold, c.k));
  return scoped.results;
}
