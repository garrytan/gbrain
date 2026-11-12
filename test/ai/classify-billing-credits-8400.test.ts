/**
 * #8385 / #8400 — an OpenAI organisation with no credits answers HTTP 429
 * ("You have no credits remaining", body error.type insufficient_quota,
 * error.code credit_balance_exhausted). That is a billing condition: callers
 * must halt with a billing message instead of retrying it as a rate limit.
 */
import { describe, test, expect } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import { classifyGlobalLlmError, AITransientError } from '../../src/core/ai/errors.ts';

function apiError(statusCode: number, message: string, responseBody?: string): APICallError {
  return new APICallError({
    message,
    url: 'https://provider.example.invalid/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseBody,
    isRetryable: statusCode === 429,
  });
}

const CREDITS_BODY = JSON.stringify({
  error: { message: 'synthetic provider message', type: 'insufficient_quota', code: 'credit_balance_exhausted' },
});

describe('credit exhaustion classifies as billing (#8385)', () => {
  test('the no-credits message on a 429 is billing', () => {
    const err = Object.assign(new Error('You have no credits remaining'), { statusCode: 429 });
    expect(classifyGlobalLlmError(err)).toBe('billing');
  });

  test('the provider body type/code decides billing whatever the message says', () => {
    expect(classifyGlobalLlmError(apiError(429, 'Too Many Requests', CREDITS_BODY))).toBe('billing');
    const codeOnly = JSON.stringify({ error: { code: 'credit_balance_exhausted' } });
    expect(classifyGlobalLlmError(apiError(429, 'Too Many Requests', codeOnly))).toBe('billing');
  });

  test('after the SDK spends its retries, the last attempt body still decides', () => {
    const attempt = () => apiError(429, 'Too Many Requests', CREDITS_BODY);
    const err = new RetryError({ message: 'Failed after 3 attempts.', reason: 'maxRetriesExceeded', errors: [attempt(), attempt(), attempt()] });
    expect(classifyGlobalLlmError(err)).toBe('billing');
  });

  test('the body decides through the facts backstop wrapper chain', () => {
    const codeOnly = JSON.stringify({ error: { code: 'credit_balance_exhausted' } });
    const attempt = () => apiError(429, 'Too Many Requests', codeOnly);
    const retry = new RetryError({ message: 'Failed after 3 attempts.', reason: 'maxRetriesExceeded', errors: [attempt(), attempt(), attempt()] });
    const err = new Error('facts extraction failed', { cause: new AITransientError('chat failed: Too Many Requests', retry) });
    expect(classifyGlobalLlmError(err)).toBe('billing');
  });

  test('a real rate-limit body stays rate_limit', () => {
    const body = JSON.stringify({ error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } });
    expect(classifyGlobalLlmError(apiError(429, 'Too Many Requests', body))).toBe('rate_limit');
  });

  test('an unparseable body changes nothing', () => {
    expect(classifyGlobalLlmError(apiError(429, 'Too Many Requests', '<html>insufficient_quota</html>'))).toBe('rate_limit');
  });
});
