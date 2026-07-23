// v0.41.25.0 (#1570) — retry.ts reconnect callback contract.
//
// Pins the new `reconnect?: () => Promise<void>` opt added to WithRetryOpts
// per D3 + D9 + codex finding 3. The retry primitive stays pure (no db.ts
// coupling); engine-level callers inject `() => this.reconnect()`.
//
// Hermetic: no engine, no PGLite, no env mutation, no DATABASE_URL.

import { describe, expect, test } from 'bun:test';
import { withRetry, RetryAbortError } from '../../src/core/retry.ts';

class FakeGBrainError extends Error {
  problem: string;
  detail: string;
  constructor(problem: string, detail: string) {
    super(`${problem}: ${detail}`);
    this.problem = problem;
    this.detail = detail;
  }
}

describe('withRetry reconnect callback (v0.41.25.0)', () => {
  test('calls reconnect AFTER classification + onRetry, BEFORE sleep', async () => {
    // Record the order of side effects so the contract is pinned: classifier
    // result determines reconnect, onRetry observes the retry intent, then
    // reconnect rebuilds state, THEN the inter-attempt sleep happens.
    const order: string[] = [];
    let attempts = 0;
    const start = Date.now();
    const result = await withRetry(
      async () => {
        attempts++;
        order.push(`fn-attempt-${attempts}`);
        if (attempts === 1) {
          throw new FakeGBrainError('No database connection', 'connect() has not been called');
        }
        return 'recovered';
      },
      {
        delayMs: 30, // small but observable sleep
        onRetry: () => { order.push('onRetry'); },
        reconnect: async () => { order.push('reconnect-start'); await new Promise(r => setTimeout(r, 1)); order.push('reconnect-end'); },
      },
    );
    const elapsed = Date.now() - start;
    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
    // Required order: first attempt fails -> onRetry -> reconnect -> sleep -> second attempt
    expect(order).toEqual([
      'fn-attempt-1',
      'onRetry',
      'reconnect-start',
      'reconnect-end',
      'fn-attempt-2',
    ]);
    // Sleep happened (delayMs=30) so elapsed must be at least delayMs + reconnect
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  test('does NOT call reconnect when opts.reconnect is undefined (back-compat)', async () => {
    // Existing call sites that don't opt in must see identical v0.41.18.0 behavior.
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('Connection terminated unexpectedly');
        return 'ok';
      },
      { delayMs: 0 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  test('reconnect failure PROPAGATES as the new error (codex finding 3 fail-loud)', async () => {
    // The reconnect helper itself throwing means the underlying problem
    // isn't transient — DB really down, auth failed, etc. Operators want
    // to see THAT error, not the masking "No database connection" symptom.
    let attempts = 0;
    let reconnectCalls = 0;
    const realCause = new Error('AuthError: invalid credentials');
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new FakeGBrainError('No database connection', 'connect() has not been called');
        },
        {
          delayMs: 0,
          maxRetries: 3,
          reconnect: async () => {
            reconnectCalls++;
            throw realCause;
          },
        },
      ),
    ).rejects.toThrow('AuthError: invalid credentials');
    // First attempt threw, then reconnect threw immediately — no further attempts.
    expect(attempts).toBe(1);
    expect(reconnectCalls).toBe(1);
  });

  test('signal.aborted BEFORE reconnect call short-circuits with RetryAbortError', async () => {
    const ctrl = new AbortController();
    let attempts = 0;
    let reconnectCalls = 0;
    // Abort the moment fn throws but BEFORE reconnect would fire.
    await expect(
      withRetry(
        async () => {
          attempts++;
          ctrl.abort(); // fire abort right when the retryable error throws
          throw new FakeGBrainError('No database connection', 'x');
        },
        {
          delayMs: 30,
          signal: ctrl.signal,
          reconnect: async () => { reconnectCalls++; },
        },
      ),
    ).rejects.toBeInstanceOf(RetryAbortError);
    expect(attempts).toBe(1);
    // Reconnect MUST NOT fire after abort — clean shutdown takes priority.
    expect(reconnectCalls).toBe(0);
  });

  test('onRetry is now awaited (back-compat-safe for sync arrows)', async () => {
    // An async onRetry taking 50ms should delay the inter-attempt sleep by
    // 50ms. v0.41.18.0 fire-and-forget would have lost that delay.
    let attempts = 0;
    const start = Date.now();
    await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('Connection terminated unexpectedly');
        return 'ok';
      },
      {
        delayMs: 0, // sleep itself is 0
        onRetry: async () => { await new Promise(r => setTimeout(r, 50)); },
      },
    );
    const elapsed = Date.now() - start;
    expect(attempts).toBe(2);
    // delayMs=0 so the ONLY source of elapsed time is the awaited onRetry.
    expect(elapsed).toBeGreaterThanOrEqual(45); // 45 to absorb scheduler noise
  });
});
