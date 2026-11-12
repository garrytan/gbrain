/**
 * Set-time validation for the `search.*` keys whose value is an enum, a
 * boolean or a bounded number, so `gbrain config set` refuses a value the reader would
 * ignore (exit 2, `invalid_params`, nothing written) instead of storing it.
 */
import { HNSW_ITERATIVE_SCAN_KEY, HNSW_ITERATIVE_SCAN_MODES, hnswIterativeScanValueProblem } from './hnsw-iterative-scan.ts';
import { CJK_KEYWORD_DEADLINE_DEFAULT_MS, CJK_KEYWORD_DEADLINE_KEY, cjkKeywordDeadlineValueProblem } from './cjk-keyword-deadline.ts';
import { AUTO_PACKING_CONFIG_KEY, DEFAULT_AUTO_PACKING, autoPackingValueProblem } from './evidence-packing.ts';
import { DEFAULT_LONG_PAGE_MIN_CHARS, LONG_PAGE_MIN_CHARS_CONFIG_KEY, LONG_PAGE_UNIT_CONFIG_KEY, longPageMinCharsValueProblem, longPageUnitValueProblem } from './evidence-delivery.ts';
import { DIVERSE_POOL_DEPTH_KEY, diversePoolDepthValueProblem } from './diverse-pool.ts';
import { parseBoolKnob } from './mode.ts';

/** A `search.*` boolean the mode reader parses with parseBoolKnob (true/false, on/off, 1/0). */
const booleanValueProblem = (key: string) => (value: string): string | null =>
  parseBoolKnob(value) === undefined ? `${key} must be true or false (got '${value}'). Nothing was written.` : null;

interface SearchValueRule {
  problem: (value: string) => string | null;
  /** A valid example for the fix line. */
  example: string;
}

export const SEARCH_VALUE_RULES: Readonly<Record<string, SearchValueRule>> = {
  [HNSW_ITERATIVE_SCAN_KEY]: { problem: hnswIterativeScanValueProblem, example: HNSW_ITERATIVE_SCAN_MODES[0] },
  [CJK_KEYWORD_DEADLINE_KEY]: { problem: cjkKeywordDeadlineValueProblem, example: String(CJK_KEYWORD_DEADLINE_DEFAULT_MS) },
  [AUTO_PACKING_CONFIG_KEY]: { problem: autoPackingValueProblem, example: DEFAULT_AUTO_PACKING },
  [LONG_PAGE_UNIT_CONFIG_KEY]: { problem: longPageUnitValueProblem, example: 'section' },
  [LONG_PAGE_MIN_CHARS_CONFIG_KEY]: { problem: longPageMinCharsValueProblem, example: String(DEFAULT_LONG_PAGE_MIN_CHARS) },
  [DIVERSE_POOL_DEPTH_KEY]: { problem: diversePoolDepthValueProblem, example: '100' },
  'search.qualified_aliases': { problem: booleanValueProblem('search.qualified_aliases'), example: 'true' },
  'search.title_qualified': { problem: booleanValueProblem('search.title_qualified'), example: 'true' },
};

/** The refusal for an invalid value of a validated `search.*` key, or null. */
export function searchConfigValueRefusal(key: string, value: string): { message: string; example: string } | null {
  const rule = SEARCH_VALUE_RULES[key];
  const message = rule?.problem(value) ?? null;
  return rule && message ? { message, example: rule.example } : null;
}
