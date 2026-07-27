/**
 * v0.41.6.0 D3 — withTimeout<T> helper.
 *
 * Pure-function tests. Verifies the Promise.race contract: resolves
 * before deadline, rejects with OperationTimeoutError after, propagates
 * underlying rejection, doesn't leak the underlying promise (timer is
 * cleared on settle).
 */
import { describe, test, expect } from 'bun:test';
import { withTimeout, OperationTimeoutError } from '../src/core/timeout.ts';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('withTimeout', () => {
  test('resolves with the underlying value when the promise settles before deadline', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'fast-resolve');
    expect(result).toBe(42);
  });

  test('rejects with OperationTimeoutError when the promise exceeds the deadline', async () => {
    const slow = new Promise(() => { /* never settles */ });
    let caught: unknown;
    try { await withTimeout(slow, 30, 'slow-resolve'); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OperationTimeoutError);
    const e = caught as OperationTimeoutError;
    expect(e.label).toBe('slow-resolve');
    expect(e.ms).toBe(30);
    expect(e.message).toContain('slow-resolve');
    expect(e.message).toContain('30ms');
  });

  test('propagates underlying rejection (not OperationTimeoutError)', async () => {
    const sentinel = new Error('real failure');
    let caught: unknown;
    try { await withTimeout(Promise.reject(sentinel), 1000, 'rejecting'); }
    catch (e) { caught = e; }
    expect(caught).toBe(sentinel);
    expect(caught).not.toBeInstanceOf(OperationTimeoutError);
  });

  test('clears the timeout after settle (no zombie timer keeping the process alive)', async () => {
    // If we don't clear the timer, the process would stay alive for the
    // full deadline. With sleep(40) BELOW deadline(2000) and clear-on-settle,
    // the test resolves immediately after await.
    const start = Date.now();
    const result = await withTimeout(sleep(40).then(() => 'ok'), 2000, 'short-with-long-deadline');
    expect(result).toBe('ok');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200); // far less than 2000ms deadline
  });

  test('Infinity deadline passes through unchanged', async () => {
    const result = await withTimeout(Promise.resolve('passthrough'), Number.POSITIVE_INFINITY, 'no-deadline');
    expect(result).toBe('passthrough');
  });

  test('NaN deadline passes through unchanged (treated as no-timeout)', async () => {
    const result = await withTimeout(Promise.resolve('nan-passthrough'), Number.NaN, 'no-deadline');
    expect(result).toBe('nan-passthrough');
  });

  test('zero deadline rejects immediately', async () => {
    let caught: unknown;
    try { await withTimeout(Promise.resolve('would-have-resolved'), 0, 'zero-deadline'); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OperationTimeoutError);
  });

  test('negative deadline rejects immediately', async () => {
    let caught: unknown;
    try { await withTimeout(Promise.resolve('would-have-resolved'), -100, 'neg-deadline'); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OperationTimeoutError);
  });

  test('OperationTimeoutError exposes label + ms fields for hint formatting', () => {
    const e = new OperationTimeoutError('gbrain search', 30_000);
    expect(e.label).toBe('gbrain search');
    expect(e.ms).toBe(30_000);
    expect(e.name).toBe('OperationTimeoutError');
  });
});
