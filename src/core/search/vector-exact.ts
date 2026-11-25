/**
 * Exact vector scan on Postgres brains up to a chunk ceiling.
 *
 * An HNSW index answers vector search fast but misses neighbours as a brain
 * grows: at 50k pages gbrain's default `hnsw.ef_search` kept about 68% of an
 * exact scan's nDCG@5 (35.0 against 51.3, 548 probes, mean of 3 index
 * builds), and raising `ef_search` to pgvector's 1000 ceiling won back about
 * 1.7 points. Postgres scans 50k pages exactly at about 257 ms p50 against
 * the index's 102 ms. This setting trades that latency for exact results.
 *
 * `search.vector_exact_max_chunks` (file or DB plane, read per search, so
 * `gbrain config set` takes effect without a restart) is the largest brain,
 * counted in `content_chunks` rows, that runs the exact attempt first. 0 or
 * unset is off, the default.
 * The count comes from planner statistics (`pg_class.reltuples`); a count
 * that is unknown (never analyzed), unreadable or slower than
 * VECTOR_EXACT_COUNT_WAIT_MS leaves the setting off for that search.
 *
 * The exact attempt is the statement's `exactSql` (every filter, visibility
 * rule and the freshness guard inside the candidate CTE, ordered by
 * `distance + 0` so no index can serve it) bound at the normal candidate
 * window: the nearest eligible chunks by plain cosine, then the same source
 * boost and best chunk per page as the index path. It runs under
 * VECTOR_EXACT_BUDGET_MS; on a timeout the search continues on the index path
 * exactly as before, so the setting never fails a search.
 */
import type { GBrainConfig } from '../config.ts';
import type { VectorSearchStatement } from './vector-statement.ts';
import { POOL_MAX_SCAN_TUPLES, type VectorPoolAttempt, type VectorPoolBatch } from './vector-pool.ts';

export const VECTOR_EXACT_MAX_CHUNKS_KEY = 'search.vector_exact_max_chunks';
/**
 * The ceiling the docs suggest when turning the setting on; not a default
 * (the default is 0, off). The exact attempt alone measured p50 568 ms /
 * p95 582 ms unfiltered at 150k 1536-dim chunks and 1,093 / 1,143 ms at 300k
 * (PG 18, pgvector 0.8, 8 vCPU, synthetic clustered vectors).
 */
export const VECTOR_EXACT_SUGGESTED_MAX_CHUNKS = 150_000;

/** Statement budget for the exact attempt and its widenings together. */
export const VECTOR_EXACT_BUDGET_MS = 2_000;

let exactBudgetMs = VECTOR_EXACT_BUDGET_MS;

/** Test seam: lower the exact attempt's budget (e.g. to force its timeout); no argument restores VECTOR_EXACT_BUDGET_MS. */
export function __setVectorExactBudgetForTests(ms?: number): void {
  exactBudgetMs = ms ?? VECTOR_EXACT_BUDGET_MS;
}

/** Times a full exact window whose pages fall short of the limit widens (x4 each), as the index walk does. */
export const VECTOR_EXACT_ESCALATIONS = 2;

/** A non-negative integer from a number or a string of digits; anything else is unreadable. */
export function parseVectorExactMaxChunks(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** What the setting says; an unreadable value is ignored (off). */
export function readVectorExactMaxChunks(cfg: Pick<GBrainConfig, 'search'> | null | undefined): { maxChunks: number; via: 'config' | null } {
  const fromConfig = parseVectorExactMaxChunks(cfg?.search?.vector_exact_max_chunks);
  return fromConfig !== undefined ? { maxChunks: fromConfig, via: 'config' } : { maxChunks: 0, via: null };
}

/** Set-time refusal text for an unreadable value, or null. */
export function vectorExactMaxChunksValueProblem(value: string): string | null {
  return parseVectorExactMaxChunks(value) === undefined
    ? `${VECTOR_EXACT_MAX_CHUNKS_KEY} must be a whole number of chunks, 0 to turn it off (got '${value}'). Nothing was written.`
    : null;
}

/** Whether a brain of `chunks` content chunks runs the exact attempt under a ceiling of `maxChunks`. */
export function vectorExactApplies(maxChunks: number | undefined, chunks: number | undefined): boolean {
  return maxChunks !== undefined && maxChunks > 0 && chunks !== undefined && chunks >= 0 && chunks <= maxChunks;
}

/** `content_chunks` rows from planner statistics: a catalog read, no table lock (the engine runs it). */
export const CONTENT_CHUNK_COUNT_SQL = `SELECT reltuples::float8 AS reltuples FROM pg_class WHERE oid = to_regclass('content_chunks')`;

/** Chunks from CONTENT_CHUNK_COUNT_SQL's rows, or undefined when the table is missing or was never analyzed (reltuples -1). */
export function parseContentChunkCount(rows: ReadonlyArray<{ reltuples?: unknown }>): number | undefined {
  const raw = rows[0]?.reltuples;
  const reltuples = raw == null ? undefined : Number(raw);
  return reltuples !== undefined && Number.isFinite(reltuples) && reltuples >= 0 ? Math.round(reltuples) : undefined;
}

/** How long a search waits for the chunk count; a slower read leaves the setting off for that search. */
export const VECTOR_EXACT_COUNT_WAIT_MS = 250;

/**
 * The engine's chunk count: one read in flight at a time, refreshed at most
 * once a minute. A search waits for it at most `waitMs`; a slow, failed or
 * unknown read answers undefined, so the search stays on the index path
 * (fail open). A failed read is retried on the next call.
 */
export function contentChunkCountCache(
  read: () => Promise<number | undefined>,
  waitMs: number = VECTOR_EXACT_COUNT_WAIT_MS,
): () => Promise<number | undefined> {
  let cached: { at: number; value: Promise<number | undefined> } | undefined;
  return async () => {
    if (!cached || performance.now() - cached.at > 60_000) {
      const entry = { at: performance.now(), value: read().catch(() => undefined) };
      cached = entry;
      void entry.value.then(value => { if (value === undefined && cached === entry) cached = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); timer.unref?.(); });
    try { return await Promise.race([cached.value, late]); } finally { clearTimeout(timer); }
  };
}

/**
 * Runs the exact attempt: rows answer the search when they fill the limit or
 * the window came back short (every eligible chunk was seen). A full window
 * whose pages fall short widens x4 up to VECTOR_EXACT_ESCALATIONS times.
 * Returns null, so the caller continues on the index path, when the budget
 * runs out, an attempt times out, or the widenings still fall short.
 */
export async function searchExactWindow(
  stmt: Pick<VectorSearchStatement, 'innerLimit'>,
  limit: number,
  run: (attempt: VectorPoolAttempt) => Promise<VectorPoolBatch>,
  budgetMs: number = exactBudgetMs,
): Promise<Record<string, unknown>[] | null> {
  const deadline = performance.now() + budgetMs;
  const attempt = async (innerLimit: number): Promise<VectorPoolBatch | null> => {
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) return null;
    try {
      return await run({ innerLimit, maxScanTuples: POOL_MAX_SCAN_TUPLES, remainingMs, exact: true, exactWindow: true });
    } catch (error) {
      if ((error as { code?: string }).code === '57014') return null;
      throw error;
    }
  };
  for (let innerLimit = stmt.innerLimit, escalations = 0; ; innerLimit *= 4, escalations++) {
    const batch = await attempt(innerLimit);
    if (!batch) return null;
    if (batch.rows.length >= limit || batch.candidatePool < innerLimit) return batch.rows;
    if (escalations >= VECTOR_EXACT_ESCALATIONS) return null;
  }
}

/**
 * The exact attempt when the setting covers the brain (`maxChunks` above 0
 * and `chunkCount()` at or below it), else null without reading the count.
 */
export async function searchExactFirst(
  stmt: Pick<VectorSearchStatement, 'innerLimit' | 'indexed'>,
  limit: number,
  maxChunks: number | undefined,
  chunkCount: () => Promise<number | undefined>,
  run: (attempt: VectorPoolAttempt) => Promise<VectorPoolBatch>,
): Promise<Record<string, unknown>[] | null> {
  if (!stmt.indexed || !maxChunks || maxChunks <= 0) return null;
  return vectorExactApplies(maxChunks, await chunkCount()) ? searchExactWindow(stmt, limit, run) : null;
}
