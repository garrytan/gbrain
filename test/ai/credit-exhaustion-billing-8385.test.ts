import { describe, expect, test } from 'bun:test';
import { classifyGlobalLlmError } from '../../src/core/ai/errors.ts';

describe('provider credit exhaustion classification', () => {
  test('classifies the no-credits provider message as billing at 429', () => {
    const error = Object.assign(new Error('You have no credits remaining'), { statusCode: 429 });
    expect(classifyGlobalLlmError(error)).toBe('billing');
  });

  test('classifies a structured insufficient_quota type as billing at 429', () => {
    const error = Object.assign(new Error('Request failed'), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { type: 'insufficient_quota' } }),
    });
    expect(classifyGlobalLlmError(error)).toBe('billing');
  });

  test('classifies a structured credit_balance_exhausted code as billing at 429', () => {
    const error = Object.assign(new Error('Request failed'), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { code: 'credit_balance_exhausted' } }),
    });
    expect(classifyGlobalLlmError(error)).toBe('billing');
  });
});
