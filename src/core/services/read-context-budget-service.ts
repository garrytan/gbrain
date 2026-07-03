import type { RetrievalSelector } from '../types.ts';
import { scalarLength, sliceScalars } from '../text-offsets.ts';

const CHARS_PER_TOKEN_ESTIMATE = 4;
const CJK_CHAR_TOKEN_WEIGHT = 2;
const NON_CJK_CHAR_TOKEN_WEIGHT = 1;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(tokenWeightUnits(text) / CHARS_PER_TOKEN_ESTIMATE));
}

export function clipToBudget(text: string, tokenBudget: number): { text: string; consumed_chars: number } {
  const maxUnits = Math.max(1, tokenBudget * CHARS_PER_TOKEN_ESTIMATE);
  const textLength = scalarLength(text);
  if (tokenWeightUnits(text) <= maxUnits) return { text, consumed_chars: textLength };
  const clipped = sliceScalars(text, 0, scalarCountWithinTokenUnits(text, maxUnits));
  return { text: clipped, consumed_chars: scalarLength(clipped) };
}

export function projectionCharLimit(selector: RetrievalSelector, tokenBudget: number): number {
  const charStart = selector.char_start ?? 0;
  const budgetLimit = Math.max(1, tokenBudget * CHARS_PER_TOKEN_ESTIMATE);
  if (selector.char_end !== undefined) {
    return Math.max(1, Math.min(selector.char_end - charStart, budgetLimit));
  }
  return budgetLimit;
}

export function charBudgetForTokens(tokenBudget: number): number {
  return Math.max(1, tokenBudget * CHARS_PER_TOKEN_ESTIMATE);
}

function tokenWeightUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    units += isCjkScalar(char) ? CJK_CHAR_TOKEN_WEIGHT : NON_CJK_CHAR_TOKEN_WEIGHT;
  }
  return units;
}

function scalarCountWithinTokenUnits(text: string, maxUnits: number): number {
  let units = 0;
  let count = 0;
  for (const char of text) {
    const weight = isCjkScalar(char) ? CJK_CHAR_TOKEN_WEIGHT : NON_CJK_CHAR_TOKEN_WEIGHT;
    if (count > 0 && units + weight > maxUnits) break;
    if (count === 0 && weight > maxUnits) return 1;
    units += weight;
    count += 1;
  }
  return count;
}

function isCjkScalar(char: string): boolean {
  return /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char);
}
