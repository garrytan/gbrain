import { describe, test, expect } from 'bun:test';
import { normalizeAIError, AIConfigError, AITransientError } from '../src/core/ai/errors.ts';

describe('normalizeAIError on unparseable 2xx body', () => {
  test('AI_JSONParseError is non-retryable config-level with a response-format hint', () => {
    const err = Object.assign(new Error('JSON parsing failed: Text: data: {"x":1}'), {
      name: 'AI_JSONParseError',
    });
    const out = normalizeAIError(err, 'chat(litellm:m)');
    expect(out).toBeInstanceOf(AIConfigError);
    expect(out).not.toBeInstanceOf(AITransientError);
    expect((out as AIConfigError).fix).toContain('stream');
  });

  test('plain network errors stay transient', () => {
    expect(normalizeAIError(new Error('socket hang up'))).toBeInstanceOf(AITransientError);
  });
});
