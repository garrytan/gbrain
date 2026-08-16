/**
 * issue #5 — `parseJobIsolationFlag` (jobs-nice-flag.test.ts pattern: pure
 * parser, env injected as the 2nd param so tests never mutate process.env).
 */

import { describe, expect, test } from 'bun:test';
import { parseJobIsolationFlag } from '../src/commands/jobs.ts';

describe('parseJobIsolationFlag', () => {
  test('default: inline', () => {
    expect(parseJobIsolationFlag([], {})).toBe('inline');
  });

  test('space form', () => {
    expect(parseJobIsolationFlag(['--job-isolation', 'process'], {})).toBe('process');
    expect(parseJobIsolationFlag(['--job-isolation', 'inline'], {})).toBe('inline');
  });

  test('= form', () => {
    expect(parseJobIsolationFlag(['--job-isolation=process'], {})).toBe('process');
    expect(parseJobIsolationFlag(['--job-isolation=inline'], {})).toBe('inline');
  });

  test('env fallback, flag wins over env', () => {
    expect(parseJobIsolationFlag([], { GBRAIN_JOB_ISOLATION: 'process' })).toBe('process');
    expect(
      parseJobIsolationFlag(['--job-isolation', 'inline'], { GBRAIN_JOB_ISOLATION: 'process' }),
    ).toBe('inline');
  });

  test('empty env value falls through to the default', () => {
    expect(parseJobIsolationFlag([], { GBRAIN_JOB_ISOLATION: '' })).toBe('inline');
  });

  test('other flags are untouched', () => {
    expect(parseJobIsolationFlag(['--queue', 'q', '--concurrency', '3'], {})).toBe('inline');
  });
});
