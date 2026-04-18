import { describe, test, expect } from 'bun:test';
import { sleepCancelable } from '../src/commands/autopilot.ts';

describe('sleepCancelable', () => {
  test('resolves after the given delay when never aborted', async () => {
    const start = Date.now();
    await sleepCancelable(40, new AbortController().signal);
    const elapsed = Date.now() - start;
    // Allow generous slack for CI timer jitter — we only care that it waited
    // at least ~40ms and didn't resolve immediately.
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  test('rejects immediately with AbortError when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const start = Date.now();
    let caught: unknown;
    try {
      await sleepCancelable(10_000, ctl.signal);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    // Rejection must be effectively synchronous — the 10s timer is never armed.
    expect(elapsed).toBeLessThan(50);
  });

  test('rejects with AbortError mid-sleep when the signal aborts', async () => {
    const ctl = new AbortController();
    // Abort well before the 10s timer would fire. If sleepCancelable were
    // not cancelable, this test would hang for ~10s and bun:test would kill it.
    setTimeout(() => ctl.abort(), 20);
    const start = Date.now();
    let caught: unknown;
    try {
      await sleepCancelable(10_000, ctl.signal);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(elapsed).toBeLessThan(200);
  });
});
