import { describe, expect, test } from 'bun:test';
import {
  AIConfigError,
  AITransientError,
  normalizeAIError,
} from '../../src/core/ai/errors.ts';

describe('normalizeAIError', () => {
  test('treats a provider spending cap as non-retryable even when status is 429', () => {
    const raw = Object.assign(
      new Error('Your project has exceeded its monthly spending cap'),
      { status: 429 },
    );
    const normalized = normalizeAIError(raw, 'embed(google:gemini-embedding-001)');

    expect(normalized).toBeInstanceOf(AIConfigError);
    expect((normalized as AIConfigError).fix).toContain('billing/spending cap');
  });

  test('keeps an ordinary 429 rate limit transient', () => {
    const raw = Object.assign(new Error('Too many requests; retry later'), { status: 429 });
    expect(normalizeAIError(raw)).toBeInstanceOf(AITransientError);
  });
});
