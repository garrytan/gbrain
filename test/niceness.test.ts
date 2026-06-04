/**
 * Unit tests for the niceness core (issue #1815).
 *
 * Pins the correctness bugs Codex flagged on the plan:
 *   - parseNiceValue must reject "3.5"/"10abc" that plain parseInt would accept (#3).
 *   - applyNiceness must re-read effective in the FAILURE path too, so a denied
 *     renice records effective:0, not null (#4).
 */

import { describe, test, expect } from 'bun:test';
import {
  parseNiceValue,
  applyNiceness,
  getEffectiveNiceness,
  formatNice,
  NICE_MIN,
  NICE_MAX,
} from '../src/core/minions/niceness.ts';

describe('parseNiceValue', () => {
  test('accepts the full POSIX range', () => {
    expect(parseNiceValue('0')).toBe(0);
    expect(parseNiceValue('10')).toBe(10);
    expect(parseNiceValue(String(NICE_MIN))).toBe(NICE_MIN);
    expect(parseNiceValue(String(NICE_MAX))).toBe(NICE_MAX);
    expect(parseNiceValue('-5')).toBe(-5);
    expect(parseNiceValue('  7  ')).toBe(7); // trimmed
  });

  test('rejects out-of-range', () => {
    expect(() => parseNiceValue('20')).toThrow();
    expect(() => parseNiceValue('-21')).toThrow();
  });

  test('rejects non-integers parseInt would silently truncate (Codex #3)', () => {
    expect(() => parseNiceValue('3.5')).toThrow();
    expect(() => parseNiceValue('10abc')).toThrow();
    expect(() => parseNiceValue('abc')).toThrow();
    expect(() => parseNiceValue('')).toThrow();
  });
});

describe('applyNiceness', () => {
  test('success path returns applied + re-read effective', () => {
    let setTo: number | undefined;
    const r = applyNiceness(
      10,
      (_pid, p) => { setTo = p; },
      () => 10,
    );
    expect(setTo).toBe(10);
    expect(r.applied).toBe(true);
    expect(r.requested).toBe(10);
    expect(r.effective).toBe(10);
    expect(r.error).toBeUndefined();
  });

  test('reports the clamped effective when the kernel caps it (Q3)', () => {
    // setPriority "succeeds" but the OS clamped to a higher (less negative) value.
    const r = applyNiceness(
      -20,
      () => { /* no throw */ },
      () => -5,
    );
    expect(r.applied).toBe(true);
    expect(r.requested).toBe(-20);
    expect(r.effective).toBe(-5); // re-read shows the real value
  });

  test('failure path STILL re-reads effective (Codex #4) — records 0, not null', () => {
    const r = applyNiceness(
      -5,
      () => { const e: NodeJS.ErrnoException = new Error('EACCES'); e.code = 'EACCES'; throw e; },
      () => 0, // process stays at its inherited niceness
    );
    expect(r.applied).toBe(false);
    expect(r.error).toContain('EACCES');
    expect(r.effective).toBe(0); // NOT null — doctor can show "asked -5, got 0"
  });

  test('effective is null only when the re-read itself throws', () => {
    const r = applyNiceness(
      10,
      () => { /* ok */ },
      () => { throw new Error('boom'); },
    );
    expect(r.applied).toBe(true);
    expect(r.effective).toBeNull();
  });
});

describe('getEffectiveNiceness', () => {
  test('returns the stub value', () => {
    expect(getEffectiveNiceness(1234, () => 7)).toBe(7);
  });
  test('returns null when the read throws (dead/unreadable pid)', () => {
    expect(getEffectiveNiceness(1234, () => { throw new Error('ESRCH'); })).toBeNull();
  });
});

describe('formatNice', () => {
  test('prefixes positive values with +', () => {
    expect(formatNice(10)).toBe('+10');
    expect(formatNice(0)).toBe('0');
    expect(formatNice(-5)).toBe('-5');
  });
});
