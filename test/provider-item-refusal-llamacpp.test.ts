import { describe, expect, test } from 'bun:test';
import { providerItemRefusal } from '../src/core/ai/errors.ts';

describe('providerItemRefusal llama.cpp context overflow', () => {
  test('classifies the llama.cpp exceed_context_size_error 400 as request_too_large', () => {
    const err = Object.assign(
      new Error('request (89808 tokens) exceeds the available context size (65536 tokens), try increasing it'),
      { status: 400 },
    );
    expect(providerItemRefusal(err)).toBe('request_too_large');
  });
});
