import { describe, expect, test } from 'bun:test';
import { isTimeoutError, pushDegraded } from '../src/core/search/hybrid/degraded.ts';
import type { DegradedStageEntry } from '../src/core/types.ts';

describe('hybrid timeout classification', () => {
  test.each([
    new Error('canceling statement due to statement timeout'),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { message: 'statement_timeout exceeded' },
  ])('labels PostgreSQL statement timeouts on the wire', (error) => {
    const degraded: DegradedStageEntry[] = [];
    pushDegraded(degraded, 'keyword_arm_failed', isTimeoutError(error) ? 'timeout' : 'provider_error');
    expect(degraded).toEqual([{ stage: 'keyword_arm_failed', reason: 'timeout' }]);
  });

  test.each([
    { code: '57014', message: 'canceling statement due to user request' },
    { code: '57014' },
    new Error('canceling statement due to lock timeout'),
    { code: '53300', message: 'too many clients already' },
    new Error('permission denied to set parameter statement_timeout'),
    new Error('invalid value for parameter statement_timeout'),
    new Error('provider unavailable'),
    null,
  ])('does not relabel other failures as statement timeouts', (error) => {
    expect(isTimeoutError(error)).toBe(false);
  });

  test.each([
    new Error('deadline 8000ms exceeded'),
    Object.assign(new Error('deadline'), { name: 'TimeoutError' }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
  ])('preserves existing bounded-provider timeout cases', (error) => {
    expect(isTimeoutError(error)).toBe(true);
  });
});
