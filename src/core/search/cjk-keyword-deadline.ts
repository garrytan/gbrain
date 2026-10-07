/**
 * `search.cjk_keyword_deadline_ms` (#5989): the one total deadline, in
 * milliseconds, for hybrid search's CJK keyword arm (engine-sql/cjk-search.ts
 * splits it 2/3 full scoring, 1/3 capped retry on Postgres). Integer,
 * default 3000, range 500..30000; `config set` refuses other values. Read
 * from the merged config per hybrid request (file > DB).
 */
import type { GBrainConfig } from '../config.ts';

export const CJK_KEYWORD_DEADLINE_KEY = 'search.cjk_keyword_deadline_ms';
export const CJK_KEYWORD_DEADLINE_DEFAULT_MS = 3000;
export const CJK_KEYWORD_DEADLINE_MIN_MS = 500;
export const CJK_KEYWORD_DEADLINE_MAX_MS = 30_000;

function valid(n: number): boolean {
  return Number.isInteger(n) && n >= CJK_KEYWORD_DEADLINE_MIN_MS && n <= CJK_KEYWORD_DEADLINE_MAX_MS;
}

export function resolveCjkKeywordDeadlineMs(cfg: Pick<GBrainConfig, 'search'> | null | undefined): number {
  const n = Number(cfg?.search?.cjk_keyword_deadline_ms);
  return valid(n) ? n : CJK_KEYWORD_DEADLINE_DEFAULT_MS;
}

export function cjkKeywordDeadlineValueProblem(value: string): string | null {
  return valid(Number(value.trim()))
    ? null
    : `${CJK_KEYWORD_DEADLINE_KEY} must be an integer number of milliseconds from ${CJK_KEYWORD_DEADLINE_MIN_MS} to ${CJK_KEYWORD_DEADLINE_MAX_MS} (got '${value}'). Nothing was written.`;
}
