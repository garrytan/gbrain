import { describe, test, expect } from 'bun:test';
import { shouldRunDreamCycle } from '../src/core/promotion.ts';

describe('shouldRunDreamCycle', () => {
  const HOUR = 3600000;
  const now = Date.UTC(2026, 3, 18, 12, 0, 0); // 2026-04-18 12:00 UTC

  test('runs on first ever call (lastRun = 0)', () => {
    expect(shouldRunDreamCycle(0, now)).toBe(true);
  });

  test('runs when stamp file is missing/unparseable (NaN passed in)', () => {
    expect(shouldRunDreamCycle(NaN, now)).toBe(true);
  });

  test('skips when last run was 1 hour ago', () => {
    expect(shouldRunDreamCycle(now - 1 * HOUR, now)).toBe(false);
  });

  test('skips when last run was 22 hours ago (just under threshold)', () => {
    expect(shouldRunDreamCycle(now - 22 * HOUR, now)).toBe(false);
  });

  test('runs when last run was exactly 23 hours ago (boundary)', () => {
    expect(shouldRunDreamCycle(now - 23 * HOUR, now)).toBe(true);
  });

  test('runs when last run was 25 hours ago (well past threshold)', () => {
    expect(shouldRunDreamCycle(now - 25 * HOUR, now)).toBe(true);
  });

  test('honors custom minHours override', () => {
    expect(shouldRunDreamCycle(now - 5 * HOUR, now, 6)).toBe(false);
    expect(shouldRunDreamCycle(now - 7 * HOUR, now, 6)).toBe(true);
  });

  test('runs when clock went backwards (lastRun > now)', () => {
    // Defensive: if system clock was adjusted backward, fire rather than
    // wait indefinitely. Better to run one extra time than never.
    expect(shouldRunDreamCycle(now + 1 * HOUR, now)).toBe(true);
  });

  test('runs when lastRun is negative (corrupted stamp file)', () => {
    expect(shouldRunDreamCycle(-1000, now)).toBe(true);
  });
});
