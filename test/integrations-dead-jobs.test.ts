/**
 * Unit tests for summarizeDeadJobs (PR #1185 rework) — the dead-jobs queue
 * check behind `gbrain integrations doctor`. The check must:
 *   - count only jobs that dead-lettered in the last 24h (one ancient dead
 *     job must NOT flag [queue]: ISSUES forever — parity with the main
 *     `gbrain doctor` queue checks), and
 *   - consume machine-readable `jobs list --json` output, never the human
 *     table (long job names shift the column widths).
 */

import { describe, test, expect } from 'bun:test';
import { summarizeDeadJobs } from '../src/commands/integrations.ts';

const NOW = new Date('2026-07-21T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function job(name: string, finishedAgoMs: number | null) {
  return {
    name,
    finished_at: finishedAgoMs === null ? null : new Date(NOW.getTime() - finishedAgoMs).toISOString(),
  };
}

describe('summarizeDeadJobs', () => {
  test('counts recent dead jobs grouped by name, biggest first', () => {
    const { total, breakdown } = summarizeDeadJobs([
      job('email-collector', 1 * HOUR),
      job('email-collector', 2 * HOUR),
      job('signal-detect', 3 * HOUR),
    ], NOW);
    expect(total).toBe(3);
    expect(breakdown).toBe('email-collector:2, signal-detect:1');
  });

  test('ignores dead jobs older than 24h (no ISSUES-forever)', () => {
    const { total } = summarizeDeadJobs([
      job('autopilot-cycle', 25 * HOUR),
      job('autopilot-cycle', 30 * 24 * HOUR),
    ], NOW);
    expect(total).toBe(0);
  });

  test('mixes windows correctly', () => {
    const { total, breakdown } = summarizeDeadJobs([
      job('subagent', 23 * HOUR),
      job('subagent', 25 * HOUR),
    ], NOW);
    expect(total).toBe(1);
    expect(breakdown).toBe('subagent:1');
  });

  test('tolerates missing / null / malformed finished_at', () => {
    const { total } = summarizeDeadJobs([
      job('shell', null),
      { name: 'shell' },
      { name: 'shell', finished_at: 'not-a-date' },
    ], NOW);
    expect(total).toBe(0);
  });

  test('handles long job names (the human table screen-scrape broke here)', () => {
    // 'autopilot-cycle' is >14 chars and breaks the padEnd(14) column
    // alignment in formatJob — the old regex scrape missed these rows.
    const { total, breakdown } = summarizeDeadJobs([job('autopilot-cycle', HOUR)], NOW);
    expect(total).toBe(1);
    expect(breakdown).toBe('autopilot-cycle:1');
  });

  test('empty array → zero', () => {
    expect(summarizeDeadJobs([], NOW).total).toBe(0);
  });
});
