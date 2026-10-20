/**
 * keyword_plan (#6495): a read-only canary for the Postgres keyword arm's
 * statement bound. The strict keyword statement ranks every matching chunk
 * before its LIMIT, so its cost grows with how common the query's terms are;
 * on a large brain the commonest terms cannot finish inside
 * `search.keyword_statement_timeout_ms` and the arm fails open to the vector
 * arm (`keyword_arm_failed`). This check takes the commonest lexeme the
 * planner knows for `content_chunks.search_vector` (`pg_stats`), EXPLAINs
 * (no ANALYZE) the strict page-count statement for it and times the engine's
 * own bounded count (`countKeywordPages`, 2 s), then warns when that count
 * times out or already spends more than half the configured bound.
 *
 * It names the knob and its range, says that one canary term is not workload
 * coverage, and never reports a timed-out count as "no matches". It also
 * reads the keyword timeout counter the engine writes once per statement
 * timeout (`search.keyword_timeout_stats`, postgres-engine/keyword-timeout-cache.ts)
 * into `details.negative_cache` and, when timeouts were recorded, names them
 * and the skip TTL in the message. Skipped on
 * PGLite (no statement timeout), below 10,000 chunks (`pg_class.reltuples`)
 * and when the planner has no statistics for the column.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { loadConfig, loadConfigWithEngine } from '../../../core/config.ts';
import {
  KEYWORD_STATEMENT_TIMEOUT_KEY,
  KEYWORD_STATEMENT_TIMEOUT_MAX_MS,
  KEYWORD_STATEMENT_TIMEOUT_MIN_MS,
  resolveKeywordStatementTimeoutMs,
} from '../../../core/postgres-engine/keyword-statement-timeout.ts';
import {
  KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S,
  KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY,
  KEYWORD_TIMEOUT_STATS_KEY,
  keywordTimeoutNegativeCacheSeconds,
  parseKeywordTimeoutStats,
} from '../../../core/postgres-engine/keyword-timeout-cache.ts';
import { isStatementTimeoutError } from '../../../core/retry-matcher.ts';
import { buildKeywordCountStatement } from '../../../core/search/keyword-statement.ts';

const name = 'keyword_plan';
const DOCS = 'docs/guides/troubleshooting.md#keyword-search-times-out-on-a-large-postgres-brain';
export const KEYWORD_PLAN_MIN_CHUNKS = 10_000;
export const KEYWORD_PLAN_CANARY_TIMEOUT_MS = 2_000;

export type KeywordPlanCount = { outcome: 'counted'; pages: number; ms: number } | { outcome: 'timed_out'; ms: number };

/** The database reads behind the check; tests inject a fake to drive each outcome. */
export interface KeywordPlanProbe {
  /** Planner row estimate for content_chunks (-1 when never analyzed). */
  chunkEstimate(): Promise<number>;
  /** The commonest lexeme in content_chunks.search_vector and its estimated share of chunks, or null without statistics. */
  canary(): Promise<{ term: string; share: number } | null>;
  /** Scan nodes over content_chunks in the plan of the strict page-count statement for the term. */
  explain(term: string): Promise<string[]>;
  /** The engine's bounded strict page count for the term, timed. */
  count(term: string, timeoutMs: number): Promise<KeywordPlanCount>;
}

interface PlanNode { 'Node Type'?: string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[]; Plan?: PlanNode }

function chunkScans(node: PlanNode | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (node['Relation Name'] === 'content_chunks') out.push(node['Index Name'] ? `${node['Node Type']} using ${node['Index Name']}` : String(node['Node Type']));
  for (const child of node.Plans ?? []) chunkScans(child, out);
  return out;
}

export function engineKeywordPlanProbe(engine: BrainEngine): KeywordPlanProbe {
  return {
    async chunkEstimate() {
      const [row] = await engine.executeRaw<{ reltuples: number }>(`SELECT reltuples::float8 AS reltuples FROM pg_class WHERE oid = to_regclass('content_chunks')`);
      return Number(row?.reltuples ?? -1);
    },
    async canary() {
      const [row] = await engine.executeRaw<{ term: string | null; share: number | null }>(
        `SELECT e.term, f.share
           FROM pg_stats s,
                LATERAL unnest(s.most_common_elems::text::text[]) WITH ORDINALITY AS e(term, i),
                LATERAL unnest(s.most_common_elem_freqs) WITH ORDINALITY AS f(share, j)
          WHERE s.schemaname = 'public' AND s.tablename = 'content_chunks' AND s.attname = 'search_vector' AND e.i = f.j
          ORDER BY f.share DESC
          LIMIT 1`);
      return row?.term ? { term: row.term, share: Number(row.share ?? 0) } : null;
    },
    async explain(term) {
      const statement = buildKeywordCountStatement(term, undefined);
      if (!statement) return [];
      const rows = await engine.executeRaw<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params);
      const plan = rows[0] ? (Object.values(rows[0])[0] as PlanNode[] | string) : undefined;
      const parsed = typeof plan === 'string' ? (JSON.parse(plan) as PlanNode[]) : plan;
      return chunkScans(parsed?.[0]?.Plan);
    },
    async count(term, timeoutMs) {
      const started = performance.now();
      try {
        const pages = await engine.countKeywordPages(term, { timeoutMs });
        return { outcome: 'counted', pages, ms: Math.round(performance.now() - started) };
      } catch (error) {
        if (isStatementTimeoutError(error)) return { outcome: 'timed_out', ms: Math.round(performance.now() - started) };
        throw error;
      }
    },
  };
}

export async function keywordPlanCheck(engine: BrainEngine, probe: KeywordPlanProbe = engineKeywordPlanProbe(engine)): Promise<Check> {
  if (engine.kind !== 'postgres') {
    return { name, status: 'ok', message: 'Skipped: PGLite runs keyword search with no statement timeout; the canary applies to Postgres brains.',
      details: { outcome: 'skipped', reason: 'pglite' } };
  }
  try {
    const cfg = await loadConfigWithEngine(engine).catch(() => loadConfig());
    const timeoutMs = resolveKeywordStatementTimeoutMs(cfg?.search?.keyword_statement_timeout_ms, undefined);
    const knob = `${KEYWORD_STATEMENT_TIMEOUT_KEY} = ${timeoutMs} ms (range ${KEYWORD_STATEMENT_TIMEOUT_MIN_MS}-${KEYWORD_STATEMENT_TIMEOUT_MAX_MS})`;
    const read = async (key: string) => { try { return await engine.getConfig(key); } catch { return null; } };
    const stats = parseKeywordTimeoutStats(await read(KEYWORD_TIMEOUT_STATS_KEY));
    const ttlSeconds = keywordTimeoutNegativeCacheSeconds(await read(KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY)) ?? KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S;
    const negativeCache = { ttl_seconds: ttlSeconds, timeouts: stats?.timeouts ?? 0, skips: stats?.skips ?? 0, last_timeout_at: stats?.last_timeout_at ?? null };
    const recorded = negativeCache.timeouts > 0
      ? ` Hybrid search's keyword arm hit this bound ${negativeCache.timeouts} time(s) (last ${negativeCache.last_timeout_at ?? 'unknown'}); ${negativeCache.skips} later search(es) skipped the timed-out statement (counted at each timeout write). `
        + (ttlSeconds > 0 ? `A serving process skips the exact statement that timed out for ${ttlSeconds} s (${KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY}; 0 turns it off), reporting keyword_arm_failed: skipped_after_timeout.` : `The skip is off (${KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY} = 0).`)
      : '';
    const base = { timeout_ms: timeoutMs, canary_timeout_ms: KEYWORD_PLAN_CANARY_TIMEOUT_MS, docs: DOCS, negative_cache: negativeCache };
    const chunks = await probe.chunkEstimate();
    if (chunks < KEYWORD_PLAN_MIN_CHUNKS) {
      return { name, status: 'ok', message: `Skipped: fewer than ${KEYWORD_PLAN_MIN_CHUNKS} chunks by the planner's estimate; the keyword statements finish well inside ${knob}.${recorded}`,
        details: { ...base, outcome: 'skipped', reason: 'small_brain' } };
    }
    const canary = await probe.canary();
    if (!canary) {
      return { name, status: 'ok', message: `Skipped: the planner has no statistics for content_chunks.search_vector yet (autovacuum's analyze collects them; to do it now, run ANALYZE content_chunks(search_vector) on the brain host while no vacuum is running on the table: an ANALYZE that waits on an autovacuum cancels it); the keyword bound is ${knob}.${recorded}`,
        details: { ...base, outcome: 'skipped', reason: 'no_statistics' } };
    }
    const percent = `${(canary.share * 100).toFixed(1)}%`;
    const scans = await probe.explain(canary.term);
    const count = await probe.count(canary.term, Math.min(KEYWORD_PLAN_CANARY_TIMEOUT_MS, timeoutMs));
    const details = { ...base, chunks_estimate: chunks, canary_term: canary.term, canary_share: canary.share, plan_scans: scans, count };
    const coverage = `One canary term is not workload coverage: other common terms, source scopes and OR fallbacks are not measured here. See ${DOCS}.`;
    if (count.outcome === 'timed_out') {
      return { name, status: 'warn', details: { ...details, outcome: 'canary_timed_out' },
        message: `Keyword search's commonest term "${canary.term}" (about ${percent} of chunks) did not finish a strict page count within ${count.ms} ms, so broad keyword queries on this brain are likely to hit ${knob} and fail open to the vector arm (keyword_arm_failed). `
          + `A timed-out count is never "no matches". Raising the knob (gbrain config set ${KEYWORD_STATEMENT_TIMEOUT_KEY} <ms>, then restart the serving process) buys time, not a cheaper statement: ranking cost grows with the number of matching chunks (#6495); narrow queries to one source (gbrain search --source-id <id>, MCP source_id). Plan: ${scans.join(', ') || 'unavailable'}. ${coverage}${recorded}` };
    }
    if (count.ms > timeoutMs / 2) {
      return { name, status: 'warn', details: { ...details, outcome: 'canary_slow' },
        message: `Keyword search's commonest term "${canary.term}" (about ${percent} of chunks) took ${count.ms} ms for a strict page count, more than half of ${knob}; a slightly broader query or a busier host will hit the bound and fail open to the vector arm (keyword_arm_failed). `
          + `A timed-out count is never "no matches". Raising the knob (gbrain config set ${KEYWORD_STATEMENT_TIMEOUT_KEY} <ms>, then restart the serving process) buys time, not a cheaper statement (#6495); narrow queries to one source (gbrain search --source-id <id>, MCP source_id). Plan: ${scans.join(', ') || 'unavailable'}. ${coverage}${recorded}` };
    }
    return { name, status: 'ok', details: { ...details, outcome: 'ok' },
      message: `Keyword search's commonest term "${canary.term}" (about ${percent} of chunks) counted ${count.pages} page(s) in ${count.ms} ms, inside half of ${knob}. Plan: ${scans.join(', ') || 'unavailable'}. ${coverage}${recorded}` };
  } catch (error) {
    return { name, status: 'warn', message: `Keyword plan could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown', docs: DOCS } };
  }
}
