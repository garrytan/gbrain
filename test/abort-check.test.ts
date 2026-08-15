/**
 * Tests for src/core/abort-check.ts (#1737 cooperative-abort helper).
 */
import { describe, test, expect } from 'bun:test';
import { isAborted, throwIfAborted, anySignal, AbortError } from '../src/core/abort-check.ts';

describe('abort-check: isAborted', () => {
  test('false for undefined / null / not-yet-fired signal', () => {
    expect(isAborted(undefined)).toBe(false);
    expect(isAborted(null)).toBe(false);
    expect(isAborted(new AbortController().signal)).toBe(false);
  });

  test('true once the controller aborts', () => {
    const ac = new AbortController();
    ac.abort();
    expect(isAborted(ac.signal)).toBe(true);
  });
});

describe('abort-check: throwIfAborted', () => {
  test('no-op when signal absent or unfired', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  test('throws AbortError carrying the signal reason', () => {
    const ac = new AbortController();
    ac.abort(new Error('wall-clock'));
    try {
      throwIfAborted(ac.signal, '[cycle]');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AbortError);
      expect((e as Error).name).toBe('AbortError');
      expect((e as Error).message).toBe('[cycle]: wall-clock');
    }
  });
});

describe('abort-check: anySignal', () => {
  test('returns the internal signal unchanged when no external signal', () => {
    const internal = new AbortController().signal;
    expect(anySignal(internal, undefined)).toBe(internal);
    expect(anySignal(internal, null)).toBe(internal);
  });

  test('combined signal fires when the EXTERNAL signal fires', () => {
    const internal = new AbortController();
    const external = new AbortController();
    const combined = anySignal(internal.signal, external.signal);
    expect(combined.aborted).toBe(false);
    external.abort();
    expect(combined.aborted).toBe(true);
  });

  test('combined signal fires when the INTERNAL signal fires', () => {
    const internal = new AbortController();
    const external = new AbortController();
    const combined = anySignal(internal.signal, external.signal);
    internal.abort();
    expect(combined.aborted).toBe(true);
  });

  test('combined is already aborted if external was pre-aborted', () => {
    const internal = new AbortController();
    const external = new AbortController();
    external.abort();
    const combined = anySignal(internal.signal, external.signal);
    expect(combined.aborted).toBe(true);
  });
});
