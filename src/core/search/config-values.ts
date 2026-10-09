/**
 * Set-time validation for the `search.*` keys whose value is an enum or a
 * bounded number, so `gbrain config set` refuses a value the reader would
 * ignore (exit 2, `invalid_params`, nothing written) instead of storing it.
 */
import { HNSW_ITERATIVE_SCAN_KEY, HNSW_ITERATIVE_SCAN_MODES, hnswIterativeScanValueProblem } from './hnsw-iterative-scan.ts';
import { CJK_KEYWORD_DEADLINE_DEFAULT_MS, CJK_KEYWORD_DEADLINE_KEY, cjkKeywordDeadlineValueProblem } from './cjk-keyword-deadline.ts';
import { AUTO_PACKING_CONFIG_KEY, DEFAULT_AUTO_PACKING, autoPackingValueProblem } from './evidence-packing.ts';

interface SearchValueRule {
  problem: (value: string) => string | null;
  /** A valid example for the fix line. */
  example: string;
}

export const SEARCH_VALUE_RULES: Readonly<Record<string, SearchValueRule>> = {
  [HNSW_ITERATIVE_SCAN_KEY]: { problem: hnswIterativeScanValueProblem, example: HNSW_ITERATIVE_SCAN_MODES[0] },
  [CJK_KEYWORD_DEADLINE_KEY]: { problem: cjkKeywordDeadlineValueProblem, example: String(CJK_KEYWORD_DEADLINE_DEFAULT_MS) },
  [AUTO_PACKING_CONFIG_KEY]: { problem: autoPackingValueProblem, example: DEFAULT_AUTO_PACKING },
};

/** The refusal for an invalid value of a validated `search.*` key, or null. */
export function searchConfigValueRefusal(key: string, value: string): { message: string; example: string } | null {
  const rule = SEARCH_VALUE_RULES[key];
  const message = rule?.problem(value) ?? null;
  return rule && message ? { message, example: rule.example } : null;
}
