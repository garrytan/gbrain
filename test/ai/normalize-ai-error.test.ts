/**
 * normalizeAIError — status extraction from typed provider errors.
 *
 * The claude-cli provider throws ClaudeCliProcessError with the HTTP status
 * on `apiErrorStatus` (not `status`/`statusCode`); normalizeAIError must
 * treat it like every other provider's status so a claude-cli 401/403
 * becomes AIConfigError instead of an endlessly-retried AITransientError.
 * 429 stays transient (retryable) for every status spelling.
 */

import { describe, test, expect } from 'bun:test';
import { normalizeAIError, AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';

describe('normalizeAIError — apiErrorStatus classification', () => {
  test('apiErrorStatus 401/403 classify as AIConfigError with the key fix hint', () => {
    for (const status of [401, 403]) {
      const err = normalizeAIError(
        Object.assign(new Error(`claude-cli API error ${status}`), { apiErrorStatus: status }),
      );
      expect(err).toBeInstanceOf(AIConfigError);
      expect((err as AIConfigError).fix).toContain('API key');
      expect(err.apiErrorStatus).toBe(status);
    }
  });

  test('apiErrorStatus 404 classifies as AIConfigError (model-id class)', () => {
    const err = normalizeAIError(Object.assign(new Error('model not found'), { apiErrorStatus: 404 }));
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as AIConfigError).fix).toContain('model id');
  });

  test('apiErrorStatus 429 stays AITransientError (retryable rate/spend limit)', () => {
    const err = normalizeAIError(Object.assign(new Error('slow down'), { apiErrorStatus: 429 }));
    expect(err).toBeInstanceOf(AITransientError);
    expect(err.apiErrorStatus).toBe(429);
  });

  test('apiErrorStatus 529 stays AITransientError (5xx)', () => {
    const err = normalizeAIError(Object.assign(new Error('overloaded'), { apiErrorStatus: 529 }));
    expect(err).toBeInstanceOf(AITransientError);
  });

  test('non-numeric apiErrorStatus is ignored (defaults to transient)', () => {
    const err = normalizeAIError(Object.assign(new Error('weird shape'), { apiErrorStatus: '401' }));
    expect(err).toBeInstanceOf(AITransientError);
  });

  test('status/statusCode take precedence over apiErrorStatus', () => {
    const err = normalizeAIError(
      Object.assign(new Error('conflicting statuses'), { status: 500, apiErrorStatus: 401 }),
    );
    expect(err).toBeInstanceOf(AITransientError);
  });
});
