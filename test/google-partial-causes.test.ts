import { describe, expect, test } from 'bun:test';
import { markPartial } from '../src/core/google/sweep-shared.ts';
import type { GoogleSyncSummary } from '../src/core/google/sweep-shared.ts';

const summary = () => ({ status: 'ok' } as unknown as GoogleSyncSummary);

describe('markPartial', () => {
  test('a cause cut at its length cap never ends in half a character, and a NUL is replaced, so the job result stays valid JSONB', () => {
    const s = summary();
    markPartial(s, 'gmail thread failed: ' + 'x'.repeat(178) + '\u{1F680} tail');
    markPartial(s, 'contacts sweep failed: bad\u0000byte');
    expect(s.status).toBe('partial');
    for (const cause of s.partialCauses!) {
      expect(cause.isWellFormed()).toBe(true);
      expect(cause.includes('\u0000')).toBe(false);
    }
    expect(s.partialCauses![0]!.length).toBeLessThanOrEqual(200);
  });

  test('once the list is full, the newest cause still lands, so a run-level cause added last is kept', () => {
    const s = summary();
    for (let i = 0; i < 8; i++) markPartial(s, 'gmail thread failed: thread ' + i);
    markPartial(s, 'usage limit reached');
    expect(s.partialCauses).toHaveLength(5);
    expect(s.partialCauses!.slice(0, 4)).toEqual(['gmail thread failed: thread 0', 'gmail thread failed: thread 1', 'gmail thread failed: thread 2', 'gmail thread failed: thread 3']);
    expect(s.partialCauses![4]).toBe('usage limit reached');
  });

  test('a repeated cause is kept once', () => {
    const s = summary();
    markPartial(s, 'run aborted');
    markPartial(s, 'run aborted');
    expect(s.partialCauses).toEqual(['run aborted']);
  });
});
