import { describe, test, expect } from 'bun:test';
import { waitFor, waitForValue } from './wait-for.ts';

describe('waitFor', () => {
  test('immediate-true fast path: single check, no interval sleep', async () => {
    let calls = 0;
    const t0 = Date.now();
    await waitFor(() => {
      calls += 1;
      return true;
    });
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('eventually-true: polls until the predicate flips', async () => {
    let calls = 0;
    await waitFor(
      () => {
        calls += 1;
        return calls >= 3;
      },
      { intervalMs: 5 },
    );
    expect(calls).toBe(3);
  });

  test('deadline throw carries label and elapsed', async () => {
    let caught: unknown = null;
    try {
      await waitFor(() => false, { timeoutMs: 50, intervalMs: 5, label: 'row-appears' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('row-appears');
    expect(msg).toMatch(/after \d+ms/);
    expect(msg).toContain('timeout 50ms');
  });

  test('checks at least once even with timeoutMs 0', async () => {
    let calls = 0;
    await waitFor(() => {
      calls += 1;
      return true;
    }, { timeoutMs: 0 });
    expect(calls).toBe(1);
  });

  test('async predicate is awaited', async () => {
    let calls = 0;
    await waitFor(
      async () => {
        calls += 1;
        await new Promise(r => setTimeout(r, 2));
        return calls >= 2;
      },
      { intervalMs: 5 },
    );
    expect(calls).toBe(2);
  });
});

describe('waitForValue', () => {
  test('returns the first non-null value', async () => {
    let calls = 0;
    const value = await waitForValue(
      () => {
        calls += 1;
        return calls >= 3 ? { hit: calls } : undefined;
      },
      { intervalMs: 5 },
    );
    expect(value).toEqual({ hit: 3 });
  });

  test('null is "keep polling", not a value', async () => {
    let calls = 0;
    const value = await waitForValue(
      () => {
        calls += 1;
        return calls >= 2 ? 'ready' : null;
      },
      { intervalMs: 5 },
    );
    expect(value).toBe('ready');
    expect(calls).toBe(2);
  });

  test('async fn: resolved value is returned', async () => {
    const value = await waitForValue(async () => 42);
    expect(value).toBe(42);
  });

  test('deadline throw when the value never appears', async () => {
    await expect(
      waitForValue(() => undefined, { timeoutMs: 40, intervalMs: 5, label: 'never-value' }),
    ).rejects.toThrow('never-value');
  });
});
