import { describe, expect, test } from 'bun:test';
import { classifyChatError } from '../src/core/page-summary.ts';

describe('classifyChatError', () => {
  test('treats provider cooldown text as rate_limit', () => {
    expect(classifyChatError(new Error('All credentials for model gpt-5.5 are cooling down via provider codex')).kind).toBe('rate_limit');
  });

  test('treats timeout-shaped messages as timeout', () => {
    expect(classifyChatError(new Error('The operation timed out.')).kind).toBe('timeout');
    expect(classifyChatError(new Error('context deadline exceeded')).kind).toBe('timeout');
  });

  test('treats lock-lost and EOF as network transients', () => {
    expect(classifyChatError(new Error('lock-lost')).kind).toBe('network');
    expect(classifyChatError(new Error('Post "https://example.test": EOF')).kind).toBe('network');
  });
});
