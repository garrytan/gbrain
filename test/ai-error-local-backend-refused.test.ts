import { describe, test, expect } from 'bun:test';
import { normalizeAIError } from '../src/core/ai/errors.ts';

function apiError(statusCode: number, message: string, responseBody: string) {
  return Object.assign(new Error(message), { name: 'AI_APICallError', statusCode, responseBody });
}

describe('normalizeAIError local backend refused', () => {
  test('a 400 reporting a refused local runner connection is transient', () => {
    const msg = 'Post "http://127.0.0.1:41234/detokenize": dial tcp 127.0.0.1:41234: connect: connection refused';
    const err = apiError(400, msg, JSON.stringify({ error: { message: msg, type: 'invalid_request_error' } }));
    expect(normalizeAIError(err, 'embed(ollama:x)').name).toBe('AITransientError');
  });

  test('a bare connection refused body is transient', () => {
    const err = apiError(400, 'Bad Request', '{"error":"connection refused"}');
    expect(normalizeAIError(err).name).toBe('AITransientError');
  });

  test('an ordinary 400 stays a config error', () => {
    const err = apiError(400, 'invalid model', '{"error":"invalid model"}');
    expect(normalizeAIError(err).name).toBe('AIConfigError');
  });
});
