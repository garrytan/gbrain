import { hnswEfSearchFor, HNSW_EF_SEARCH_DEFAULT } from '../vector-index.ts';
import { remainingVectorBudget } from './vector-pool.ts';
import { HNSW_ITERATIVE_SCAN_DEFAULT, type HnswIterativeScanMode } from './hnsw-iterative-scan.ts';
import { INDEX_WALK_SETTINGS } from './vector-statement.ts';

/**
 * `walkOverfetch` (the statement's `indexWalkOverfetch`, set only for the
 * index walk) adds INDEX_WALK_SETTINGS and sizes `hnsw.ef_search` for the
 * walk's over-fetched window: a non-iterative scan cannot return past it, and
 * an iterative one past it orders less exactly (recall@50 0.96 against 0.995).
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
): Promise<T> {
  const window = walkOverfetch ? candidateLimit * walkOverfetch : candidateLimit;
  const settings: Record<string, string> = { 'hnsw.ef_search': String(hnswEfSearchFor(window)), ...(walkOverfetch ? INDEX_WALK_SETTINGS : {}) };
  const defaults: Record<string, string> = { 'hnsw.ef_search': String(HNSW_EF_SEARCH_DEFAULT), 'hnsw.iterative_scan': 'off', 'hnsw.max_scan_tuples': '20000' };
  if (iterative) {
    settings['hnsw.iterative_scan'] = iterativeMode;
    settings['hnsw.max_scan_tuples'] = String(maxScanTuples);
  }
  if (deadline !== undefined) settings.statement_timeout = String(remainingVectorBudget(deadline));
  const names = Object.keys(settings);
  const previous = await query(`SELECT name, current_setting(name, true) AS value FROM unnest($1::text[]) AS settings(name)`, [names]);
  const setSql = `SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS settings(name, value)`;
  if (deadline !== undefined) settings.statement_timeout = String(remainingVectorBudget(deadline));
  await query(setSql, [names, names.map(name => settings[name])]);
  const result = await run();
  await query(setSql, [previous.map(row => row.name), previous.map(row => row.value ?? defaults[String(row.name)])]);
  return result;
}
