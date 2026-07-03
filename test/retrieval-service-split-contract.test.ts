import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import {
  candidateLimitForTokenBudget,
  requiredReadLimitForTokenBudget,
  shouldIncludeOrientationForTokenBudget,
} from '../src/core/services/retrieve-context-budget-service.ts';
import {
  clipToBudget,
  estimateTokens,
  projectionCharLimit,
} from '../src/core/services/read-context-budget-service.ts';

describe('retrieval service split contract', () => {
  test('budget helpers live outside the large retrieve/read context services', () => {
    expect(existsSync(new URL('../src/core/services/retrieve-context-budget-service.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../src/core/services/read-context-budget-service.ts', import.meta.url))).toBe(true);

    const retrieveSource = readFileSync(
      new URL('../src/core/services/retrieve-context-service.ts', import.meta.url),
      'utf-8',
    );
    const readSource = readFileSync(
      new URL('../src/core/services/read-context-service.ts', import.meta.url),
      'utf-8',
    );

    expect(retrieveSource).not.toContain('function candidateLimitForTokenBudget');
    expect(readSource).not.toContain('function clipToBudget');
  });

  test('retrieve budget helpers keep candidate/read/orientation semantics stable', () => {
    expect(candidateLimitForTokenBudget(5, undefined)).toBe(5);
    expect(candidateLimitForTokenBudget(9, 1800)).toBe(3);
    expect(requiredReadLimitForTokenBudget(5, undefined)).toBe(3);
    expect(requiredReadLimitForTokenBudget(5, 1800)).toBe(1);
    expect(shouldIncludeOrientationForTokenBudget(undefined, true)).toBe(true);
    expect(shouldIncludeOrientationForTokenBudget(1999, true)).toBe(false);
    expect(shouldIncludeOrientationForTokenBudget(2500, false)).toBe(false);
  });

  test('read budget helpers keep CJK-aware clipping semantics stable', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('한글한글')).toBe(2);
    expect(clipToBudget('한글abc', 1)).toEqual({ text: '한글', consumed_chars: 2 });
    expect(projectionCharLimit({ kind: 'compiled_truth', slug: 'brain/demo', char_start: 2, char_end: 10 }, 1)).toBe(4);
  });
});
