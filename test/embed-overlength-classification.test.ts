import { expect, test } from 'bun:test';
import { isSingleInputOverLengthError } from '../src/core/ai/embed-overlength.ts';
import { isEmbedRetriableError, isTransientNetworkEmbedError } from '../src/core/embed-retry.ts';
import { classifyErrorCode } from '../src/core/sync-failure-ledger.ts';

const messages = [
  'input length exceeds the context length',
  'Input length 1460 exceeds maximum allowed token size 512',
  'Range of input length should be [1, 2048]',
  'input is too large to process',
  'Please reduce the length of the input',
  'input must be less than 512 tokens',
];
test('single-input overflow takes precedence over transient wrappers and matches the failure ledger', () => {
  for (const message of messages) for (const status of [undefined, 400, 413, 422, 500, 502, 503, 504]) {
    const error = new Error('embedding request failed', { cause: Object.assign(new Error(message), { status }) });
    expect(isSingleInputOverLengthError(error)).toBe(true);
    expect(isEmbedRetriableError(error)).toBe(false);
    expect(isTransientNetworkEmbedError(error)).toBe(false);
    expect(classifyErrorCode(message)).toBe('EMBEDDING_OVERSIZE');
  }
});
test('authentication, rate-limit, transport and batch failures retain their handling', () => {
  for (const status of [401, 403, 404, 429]) {
    expect(isSingleInputOverLengthError(Object.assign(new Error(messages[0]), { status }))).toBe(false);
  }
  for (const message of ['batch input exceeds the context limit', 'maximum request size is 300000 tokens per request', 'service unavailable', 'socket hang up']) {
    expect(isSingleInputOverLengthError(Object.assign(new Error(message), { status: 503 }))).toBe(false);
  }
  expect(isEmbedRetriableError(Object.assign(new Error('service unavailable'), { status: 503 }))).toBe(true);
  expect(isTransientNetworkEmbedError(new Error('socket hang up'))).toBe(true);
});
