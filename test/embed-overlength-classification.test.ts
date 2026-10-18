/**
 * #6772: some providers report a single input over the model's context with a
 * 5xx or no HTTP status (llama.cpp's server answers 500 "input (N tokens) is
 * larger than the max context size"; Ollama answers 500 "input length exceeds
 * the context length"). Those were retried as transient and never isolated or
 * healed. A 5xx or statusless error now counts as a single-input overflow only
 * on explicit token or context-length wording; queue, connection and generic
 * "too long" 5xx messages stay transient, and the gateway's batch-token guard
 * still vetoes.
 */
import { describe, expect, test } from 'bun:test';
import { isSingleInputOverLengthError } from '../src/core/embed-overlength-heal.ts';
import { isEmbedRetriableError, isTransientNetworkEmbedError } from '../src/core/embed-retry.ts';
import { AITransientError } from '../src/core/ai/errors.ts';

const http = (status: number | undefined, message: string): Error => Object.assign(new Error(message), status === undefined ? {} : { status });
const wrapped = (status: number | undefined, message: string): Error => new AITransientError('embedding request failed', http(status, message));

const OVERFLOWS = [
  'input (1234 tokens) is larger than the max context size (512 tokens). skipping',
  'input length exceeds the context length',
  "This model's maximum context length is 8192 tokens, however you requested 9211 tokens",
  'Input length 1460 exceeds maximum allowed token size 512',
  'the input of 9000 tokens exceeds the maximum of 8192',
];

describe('#6772 single-input overflow behind a 5xx or no status', () => {
  test('explicit token or context-length wording is an overflow at 500/502/503/504 and with no status, and is never retried as transient', () => {
    for (const message of OVERFLOWS) for (const status of [500, 502, 503, 504, undefined]) {
      for (const error of [http(status, message), wrapped(status, message)]) {
        expect([message, status, isSingleInputOverLengthError(error)]).toEqual([message, status, true]);
        expect(isEmbedRetriableError(error)).toBe(false);
        expect(isTransientNetworkEmbedError(error)).toBe(false);
      }
    }
  });

  test('queue, connection-limit, URL-length and generic too-long 5xx messages stay transient', () => {
    for (const [status, message] of [
      [503, 'The input queue is too long, try again later'],
      [503, 'server exceeds maximum concurrent connection limit'],
      [undefined, 'Request text too long for URL'],
      [500, 'Input text is too long for this model'],
      [503, 'service unavailable'],
      [500, 'Internal server error'],
    ] as const) {
      expect([message, isSingleInputOverLengthError(http(status, message))]).toEqual([message, false]);
    }
    expect(isEmbedRetriableError(http(503, 'The input queue is too long, try again later'))).toBe(true);
    expect(isEmbedRetriableError(http(503, 'server exceeds maximum concurrent connection limit'))).toBe(true);
  });

  test('batch-level token errors are vetoed at any status, and 4xx outside 400/413/422 never count', () => {
    for (const status of [500, 503, undefined]) {
      expect(isSingleInputOverLengthError(http(status, 'max allowed tokens per batch is 120000'))).toBe(false);
      expect(isSingleInputOverLengthError(http(status, "Invalid 'input': maximum request size is 300000 tokens per request."))).toBe(false);
      expect(isSingleInputOverLengthError(http(status, 'batch of 40000 tokens exceeds the maximum context length'))).toBe(false);
    }
    for (const status of [401, 403, 404, 429]) expect(isSingleInputOverLengthError(http(status, OVERFLOWS[0]!))).toBe(false);
  });
});
