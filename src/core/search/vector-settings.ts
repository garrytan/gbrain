import { hnswEfSearchFor, HNSW_EF_SEARCH_DEFAULT } from '../vector-index.ts';
import { remainingVectorBudget } from './vector-pool.ts';
import { HNSW_ITERATIVE_SCAN_DEFAULT, type HnswIterativeScanMode } from './hnsw-iterative-scan.ts';
import { INDEX_WALK_SETTINGS, JOINED_STATEMENT_SETTINGS } from './vector-statement.ts';

/**
 * `walkOverfetch` (the statement's `indexWalkOverfetch`, set only for the
 * index walk) adds INDEX_WALK_SETTINGS and sizes `hnsw.ef_search` for the
 * walk's over-fetched window: a non-iterative scan cannot return past it, and
 * an iterative one past it orders less exactly (recall@50 0.96 against 0.995).
 * `joined` (an attempt that runs the joined statement, `sql`, of a statement
 * with an index walk) adds JOINED_STATEMENT_SETTINGS.
 */

/** What each scan setting reads as when nothing set it (pgvector's defaults; NULL before the extension loads). */
export const VECTOR_SETTING_DEFAULTS: Readonly<Record<string, string>> = { 'hnsw.ef_search': String(HNSW_EF_SEARCH_DEFAULT), 'hnsw.iterative_scan': 'off', 'hnsw.max_scan_tuples': '20000' };

/** The transaction-local scan settings for one vector attempt; `statement_timeout` is what remains of `deadline`, read now. */
export function vectorScanSettings(
  iterative: boolean,
  candidateLimit: number,
  maxScanTuples: number,
  deadline?: number,
  iterativeMode: HnswIterativeScanMode = HNSW_ITERATIVE_SCAN_DEFAULT,
  walkOverfetch?: number,
  joined = false,
): Record<string, string> {
  const window = walkOverfetch ? candidateLimit * walkOverfetch : candidateLimit;
  const settings: Record<string, string> = { 'hnsw.ef_search': String(hnswEfSearchFor(window)), ...(walkOverfetch ? INDEX_WALK_SETTINGS : {}), ...(joined ? JOINED_STATEMENT_SETTINGS : {}) };
  if (iterative) {
    settings['hnsw.iterative_scan'] = iterativeMode;
    settings['hnsw.max_scan_tuples'] = String(maxScanTuples);
  }
  if (deadline !== undefined) settings.statement_timeout = String(remainingVectorBudget(deadline));
  return settings;
}

/**
 * Read, set and restore the scan settings around `run` through `query`
 * (PGLite and the fact-relevance read). Postgres search attempts set them in
 * their transaction's one settings statement instead
 * (postgres-engine/search-settings.ts).
 */
export async function withVectorSettings<T>(
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
  iterative: boolean,
  candidateLimit: number,
  maxScanTuples: number,
  run: () => Promise<T>,
  deadline?: number,
  iterativeMode: HnswIterativeScanMode = HNSW_ITERATIVE_SCAN_DEFAULT,
  walkOverfetch?: number,
  joined = false,
): Promise<T> {
  const settings = vectorScanSettings(iterative, candidateLimit, maxScanTuples, deadline, iterativeMode, walkOverfetch, joined);
  const names = Object.keys(settings);
  const previous = await query(`SELECT name, current_setting(name, true) AS value FROM unnest($1::text[]) AS settings(name)`, [names]);
  const setSql = `SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS settings(name, value)`;
  if (deadline !== undefined) settings.statement_timeout = String(remainingVectorBudget(deadline));
  await query(setSql, [names, names.map(name => settings[name])]);
  const result = await run();
  await query(setSql, [previous.map(row => row.name), previous.map(row => row.value ?? VECTOR_SETTING_DEFAULTS[String(row.name)])]);
  return result;
}
