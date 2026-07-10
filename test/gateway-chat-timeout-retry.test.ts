/**
 * chat() timeout-retry helpers (v0.42.x).
 *
 * The default wall-clock timeout backstop aborts a slow provider call; the AI
 * SDK's maxRetries does NOT retry an abort, so a transient slow moment (e.g. the
 * local seat-proxy under overnight load) killed the call outright. These helpers
 * retry ONLY that default-timeout abort — never a caller-initiated cancellation.
 */
import { describe, test, expect } from 'bun:test';
import { __chatRetryTesting } from '../src/core/ai/gateway.ts';

const { isRetryableChatTimeout, withChatTimeoutRetry, CHAT_TIMEOUT_MAX_RETRIES } = __chatRetryTesting;

describe('isRetryableChatTimeout', () => {
  test('true for a timeout/abort when the caller has NOT aborted', () => {
    expect(isRetryableChatTimeout({ name: 'TimeoutError' }, undefined)).toBe(true);
    expect(isRetryableChatTimeout({ name: 'AbortError' }, undefined)).toBe(true);
    expect(isRetryableChatTimeout(new Error('The operation timed out'), undefined)).toBe(true);
  });

  test('false when the CALLER aborted (intentional cancellation, never retry)', () => {
    const ac = new AbortController();
    ac.abort();
    expect(isRetryableChatTimeout({ name: 'TimeoutError' }, ac.signal)).toBe(false);
    expect(isRetryableChatTimeout({ name: 'AbortError' }, ac.signal)).toBe(false);
  });

  test('false for non-timeout errors (real failures propagate immediately)', () => {
    expect(isRetryableChatTimeout({ name: 'TypeError', message: 'bad input' }, undefined)).toBe(false);
    expect(isRetryableChatTimeout(new Error('400 invalid request'), undefined)).toBe(false);
    expect(isRetryableChatTimeout(null, undefined)).toBe(false);
  });
});

describe('withChatTimeoutRetry', () => {
  test('retries a timed-out call, then returns the eventual success', async () => {
    let calls = 0;
    const r = await withChatTimeoutRetry(async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return 'ok';
    }, undefined);
    expect(r).toBe('ok');
    expect(calls).toBe(2);
  });

  test('does NOT retry when the caller aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await expect(
      withChatTimeoutRetry(async () => {
        calls++;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }, ac.signal),
    ).rejects.toThrow();
    expect(calls).toBe(1); // one attempt, no retry
  });

  test('gives up after the bounded number of retries', async () => {
    let calls = 0;
    await expect(
      withChatTimeoutRetry(async () => {
        calls++;
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }, undefined),
    ).rejects.toThrow();
    expect(calls).toBe(CHAT_TIMEOUT_MAX_RETRIES + 1); // initial attempt + retries
  });
});
