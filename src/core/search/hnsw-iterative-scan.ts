/**
 * pgvector `hnsw.iterative_scan` mode for filtered vector search (#6132 idea).
 * `relaxed_order` (the default) lets an iterative scan return a closer
 * candidate it finds late, after farther ones; `strict_order` drops such a
 * candidate to keep the scan's output in exact distance order. Both engines
 * re-sort after the per-page pooling (the inner `ORDER BY distance` plus the
 * pooled outer sort), so relaxed output order never reaches a caller, and a
 * filtered query that strict order underfills finds more of its true
 * neighbours.
 *
 * Escape hatch, no release needed: `GBRAIN_HNSW_ITERATIVE_SCAN` (wins when
 * set) or the config key `search.hnsw_iterative_scan`, one of
 * `relaxed_order | strict_order | off`. Resolved once per process by the
 * caller that builds search options (like `search.vector_legacy_guard`), so
 * the owning service picks a change up on restart and the hot path never
 * re-reads config. An unreadable value falls back to the default.
 */
import type { GBrainConfig } from '../config.ts';

export const HNSW_ITERATIVE_SCAN_ENV = 'GBRAIN_HNSW_ITERATIVE_SCAN';
export const HNSW_ITERATIVE_SCAN_KEY = 'search.hnsw_iterative_scan';
export const HNSW_ITERATIVE_SCAN_MODES = ['relaxed_order', 'strict_order', 'off'] as const;
export type HnswIterativeScanMode = (typeof HNSW_ITERATIVE_SCAN_MODES)[number];
export const HNSW_ITERATIVE_SCAN_DEFAULT: HnswIterativeScanMode = 'relaxed_order';

export function parseHnswIterativeScan(value: unknown): HnswIterativeScanMode | undefined {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (HNSW_ITERATIVE_SCAN_MODES as readonly string[]).includes(v) ? (v as HnswIterativeScanMode) : undefined;
}

/** What the setting says right now and where it came from. */
export function readHnswIterativeScan(
  cfg: Pick<GBrainConfig, 'search'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { mode: HnswIterativeScanMode; via: 'env' | 'config' | null } {
  const fromEnv = parseHnswIterativeScan(env[HNSW_ITERATIVE_SCAN_ENV]);
  if (fromEnv) return { mode: fromEnv, via: 'env' };
  const fromConfig = parseHnswIterativeScan(cfg?.search?.hnsw_iterative_scan);
  if (fromConfig) return { mode: fromConfig, via: 'config' };
  return { mode: HNSW_ITERATIVE_SCAN_DEFAULT, via: null };
}

let resolved: HnswIterativeScanMode | undefined;

/** First call decides for the process; logs once to stderr when an override is active. */
export function resolveHnswIterativeScan(cfg: Pick<GBrainConfig, 'search'> | null | undefined): HnswIterativeScanMode {
  if (resolved !== undefined) return resolved;
  const setting = readHnswIterativeScan(cfg);
  resolved = setting.mode;
  if (setting.via && setting.mode !== HNSW_ITERATIVE_SCAN_DEFAULT) {
    console.error(`[gbrain] vector search uses hnsw.iterative_scan=${setting.mode} (${setting.via === 'env' ? HNSW_ITERATIVE_SCAN_ENV : HNSW_ITERATIVE_SCAN_KEY}); the default is ${HNSW_ITERATIVE_SCAN_DEFAULT}.`);
  }
  return resolved;
}

/** `config set search.hnsw_iterative_scan <value>` refusal text, or null when the value is valid. */
export function hnswIterativeScanValueProblem(value: string): string | null {
  return parseHnswIterativeScan(value) ? null : `${HNSW_ITERATIVE_SCAN_KEY} must be one of ${HNSW_ITERATIVE_SCAN_MODES.join(' | ')} (got '${value}'). Nothing was written.`;
}

/** @internal test seam */
export function _resetHnswIterativeScanForTests(): void {
  resolved = undefined;
}
