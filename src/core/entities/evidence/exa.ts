/**
 * Dedupe v2 (GST-3609): opt-in Exa web search for pairs that would otherwise wait. Off unless the user sets EXA_API_KEY
 * and turns `dedupe.exa` on; without both, nothing leaves the machine and the X classes never fire.
 *
 * What leaves the machine: one query per page, exactly "<name> <company or job title>", sent to Exa's Lite search in its
 * people category (top result only, no page contents). Never an email address, a phone number, page text or anything
 * about the owner. A page not every reader may read (people.ts markRestricted), labelled family, about a minor, named
 * with digits or an address, named with one word, or with no company or title gets no query.
 *
 * Every answer is cached in the brain's config under `dedupe.exa_cache.<query hash>`, so a query is never paid for
 * twice. A run stops cleanly at the per-run cap (`dedupe.exa_run_cap`, 2,000 queries) or when the next query, at the
 * dearest price seen this run, would pass the total cap (`dedupe.exa_total_cap_usd`, $25; the total spent is
 * `dedupe.exa_spent_usd`), so the first query of a run can pass it by at most its own price. A request that fails after
 * it was sent counts as spent. One live run at a time: a second one finds the lock held and sends nothing. A dry run
 * reads the cache, counts the queries a live run would send and their cost, and makes no call.
 *
 * A top result counts only when its title carries every word of the name and a word of the clue; its URL is the
 * profile. For a pair: X1 both pages, searched with different queries, resolve to the same profile; X2 they resolve
 * to different profiles; X0 the two queries are the same, which is no evidence.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import type { PersonPage } from './people.ts';
import { tryAcquireDbLock } from '../../db-lock.ts';

export const EXA_SEARCH_URL = 'https://api.exa.ai/search';
/** Exa's Lite search: $4 per 1,000 requests with up to 10 results (exa.ai/pricing, read 2026-11-23). */
export const EXA_SEARCH_TYPE = 'lite';
export const EXA_COST_PER_QUERY_USD = 0.004;
export const EXA_SWITCH_KEY = 'dedupe.exa';
export const EXA_RUN_CAP_KEY = 'dedupe.exa_run_cap';
export const EXA_TOTAL_CAP_KEY = 'dedupe.exa_total_cap_usd';
export const EXA_SPENT_KEY = 'dedupe.exa_spent_usd';
export const EXA_CACHE_PREFIX = 'dedupe.exa_cache.';
export const DEFAULT_EXA_RUN_CAP = 2000;
export const DEFAULT_EXA_TOTAL_CAP_USD = 25;
const TIMEOUT_MS = 20_000;
const LIVE_LOCK_ID = 'dedupe-exa';
const LIVE_LOCK_TTL_MINUTES = 30;
const MAX_CLUE_CHARS = 80;

export type ExaBlock = 'private' | 'family' | 'minor' | 'no_name' | 'no_clue';
export interface ExaQuery { query: string; name: string; clue: string }
export type ExaMode = 'dry_run' | 'live';

export interface ExaReport {
  mode: ExaMode;
  /** Distinct queries the pairs need. */
  queries: number;
  cached: number;
  /** Sent in this run (live), or that a live run would send within the caps (dry run). */
  sent: number;
  /** Queries left unsent because a cap stopped the run. */
  unsent: number;
  /** Live: queries dropped at send time because a page changed since the scan (made private, renamed, relabelled). */
  withdrawn?: number;
  /** Paid in this run (live), or what a live run would pay (dry run), in USD. */
  cost_usd: number;
  /** What every uncached query would cost with no caps, in USD. */
  uncapped_cost_usd: number;
  spent_total_usd: number;
  run_cap: number;
  total_cap_usd: number;
  stopped?: 'run_cap' | 'total_cap' | 'busy' | 'network' | string;
  /** Pages kept away from the search, by reason. */
  blocked: Partial<Record<ExaBlock, number>>;
}

export interface ExaSettings { enabled: boolean; hasKey: boolean; runCap: number; totalCapUsd: number; spentUsd: number }

const num = (v: string | null, fallback: number) => { const n = Number(v); return v !== null && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback; };

export async function exaSettings(engine: Pick<BrainEngine, 'getConfig'>, env: Record<string, string | undefined>): Promise<ExaSettings> {
  return {
    enabled: String(await engine.getConfig(EXA_SWITCH_KEY) ?? '').trim().toLowerCase() === 'on',
    hasKey: !!env.EXA_API_KEY?.trim(),
    runCap: Math.floor(num(await engine.getConfig(EXA_RUN_CAP_KEY), DEFAULT_EXA_RUN_CAP)),
    totalCapUsd: num(await engine.getConfig(EXA_TOTAL_CAP_KEY), DEFAULT_EXA_TOTAL_CAP_USD),
    spentUsd: num(await engine.getConfig(EXA_SPENT_KEY), 0),
  };
}

const nameWords = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').split(/[^\p{L}]+/u).filter(w => w.length > 1);

/** The one query a page may send, or why it sends none. */
export function exaQueryFor(p: PersonPage): ExaQuery | { blocked: ExaBlock } {
  if (p.sensitive) return { blocked: p.sensitive };
  if (p.restricted) return { blocked: 'private' };
  const name = p.title.replace(/\s+/g, ' ').trim();
  if (!name || /[@\d]/.test(name) || nameWords(name).length < 2) return { blocked: 'no_name' };
  const clue = (p.company ?? p.role ?? '').replace(/\s+/g, ' ').trim();
  if (!clue || clue.includes('@') || /\d{5,}/.test(clue.replace(/[\s().+-]/g, '')) || clue.length > MAX_CLUE_CHARS || !nameWords(clue).length) return { blocked: 'no_clue' };
  return { query: `${name} ${clue}`, name, clue };
}

export const exaCacheKey = (query: string) => `${EXA_CACHE_PREFIX}${createHash('sha256').update(query.toLowerCase()).digest('hex').slice(0, 32)}`;

/** The profile a top result names: scheme, www, query, fragment and trailing slash dropped, lowercased. */
export function profileUrl(url: string): string {
  return url.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[?#]/)[0]!.replace(/\/+$/, '');
}

/** A top result counts when its title carries every word of the name and a word of the clue. */
export function resultMatches(q: ExaQuery, title: string): boolean {
  const words = new Set(nameWords(title));
  return nameWords(q.name).every(w => words.has(w)) && nameWords(q.clue).filter(w => w.length > 2).some(w => words.has(w));
}

interface Cached { url: string | null }

/**
 * Resolve each query to a profile URL (null when the top result does not count), from the cache, then, in a live run,
 * from Exa within both caps. Returns the answers it has, cached ones included.
 */
export async function resolveExa(engine: BrainEngine, queries: ExaQuery[], blocked: ExaReport['blocked'],
  opts: { mode: ExaMode; settings: ExaSettings; apiKey?: string; fetch?: typeof fetch; recheck?: (query: string) => Promise<boolean> }): Promise<{ hits: Map<string, string | null>; report: ExaReport }> {
  const unique = [...new Map(queries.map(q => [q.query, q])).values()].sort((x, y) => (x.query < y.query ? -1 : x.query > y.query ? 1 : 0));
  const hits = new Map<string, string | null>();
  const todo: ExaQuery[] = [];
  for (const q of unique) {
    const raw = await engine.getConfig(exaCacheKey(q.query));
    if (raw === null) { todo.push(q); continue; }
    hits.set(q.query, (JSON.parse(raw) as Cached).url);
  }
  const { settings } = opts;
  const report: ExaReport = { mode: opts.mode, queries: unique.length, cached: hits.size, sent: 0, unsent: 0, cost_usd: 0,
    uncapped_cost_usd: round(todo.length * EXA_COST_PER_QUERY_USD), spent_total_usd: round(settings.spentUsd), run_cap: settings.runCap,
    total_cap_usd: settings.totalCapUsd, blocked };
  const live = opts.mode === 'live';
  const lock = live && todo.length ? await tryAcquireDbLock(engine, LIVE_LOCK_ID, LIVE_LOCK_TTL_MINUTES) : null;
  if (live && todo.length && !lock) report.stopped = 'busy';
  let spent = settings.spentUsd;
  let perQuery = EXA_COST_PER_QUERY_USD;
  const charge = async (cost: number) => {
    spent = num(await engine.getConfig(EXA_SPENT_KEY), 0) + cost;
    report.cost_usd += cost;
    report.sent++;
    await engine.setConfig(EXA_SPENT_KEY, String(round(spent)));
  };
  try {
    for (const q of report.stopped ? [] : todo) {
      if (report.sent >= settings.runCap) { report.stopped = 'run_cap'; break; }
      if (live) spent = num(await engine.getConfig(EXA_SPENT_KEY), 0);
      if (spent + perQuery > settings.totalCapUsd + 1e-9) { report.stopped = 'total_cap'; break; }
      if (!live) { report.sent++; spent += EXA_COST_PER_QUERY_USD; report.cost_usd += EXA_COST_PER_QUERY_USD; continue; }
      await lock!.refresh();
      if (opts.recheck && !(await opts.recheck(q.query))) { report.withdrawn = (report.withdrawn ?? 0) + 1; continue; }
      let body: { results?: Array<{ title?: unknown; url?: unknown }>; costDollars?: { total?: unknown } };
      try {
        const res = await (opts.fetch ?? fetch)(EXA_SEARCH_URL, {
          method: 'POST',
          headers: { 'x-api-key': opts.apiKey ?? '', 'content-type': 'application/json' },
          body: JSON.stringify({ query: q.query, type: EXA_SEARCH_TYPE, category: 'people', numResults: 1 }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) { report.stopped = `http_${res.status}`; break; }
        body = await res.json() as typeof body;
      } catch {
        await charge(perQuery);
        report.stopped = 'network';
        break;
      }
      const reported = body.costDollars?.total;
      const cost = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? reported : EXA_COST_PER_QUERY_USD;
      perQuery = Math.max(perQuery, cost);
      await charge(cost);
      const top = body.results?.[0];
      const url = top && typeof top.url === 'string' && typeof top.title === 'string' && resultMatches(q, top.title) ? profileUrl(top.url) : null;
      await engine.setConfig(exaCacheKey(q.query), JSON.stringify({ url } satisfies Cached));
      hits.set(q.query, url);
    }
  } finally {
    await lock?.release();
  }
  report.unsent = todo.length - report.sent - (report.withdrawn ?? 0);
  report.cost_usd = round(report.cost_usd);
  report.spent_total_usd = round(opts.mode === 'live' ? spent : settings.spentUsd);
  return { hits, report };
}

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;
