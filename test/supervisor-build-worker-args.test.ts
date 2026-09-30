/**
 * Unit tests for buildWorkerArgs (issue #1815) — the supervisor → worker argv.
 * Extracted from runSuperviseLoop so the --nice propagation is testable.
 */

import { describe, test, expect } from 'bun:test';
import { buildWorkerArgs } from '../src/core/minions/supervisor.ts';

describe('buildWorkerArgs', () => {
  test('base args without nice or rss', () => {
    expect(buildWorkerArgs({ concurrency: 2, queue: 'default', maxRssMb: 0 }))
      .toEqual(['jobs', 'work', '--concurrency', '2', '--queue', 'default']);
  });

  test('includes --max-rss when > 0', () => {
    expect(buildWorkerArgs({ concurrency: 4, queue: 'q', maxRssMb: 2048 }))
      .toEqual(['jobs', 'work', '--concurrency', '4', '--queue', 'q', '--max-rss', '2048']);
  });

  test('appends --nice when nice_requested is set', () => {
    expect(buildWorkerArgs({ concurrency: 2, queue: 'default', maxRssMb: 0, nice_requested: 10 }))
      .toEqual(['jobs', 'work', '--concurrency', '2', '--queue', 'default', '--nice', '10']);
  });

  test('negative nice propagates', () => {
    const args = buildWorkerArgs({ concurrency: 1, queue: 'q', maxRssMb: 512, nice_requested: -5 });
    expect(args).toEqual(['jobs', 'work', '--concurrency', '1', '--queue', 'q', '--max-rss', '512', '--nice', '-5']);
  });

  test('nice 0 is explicit and still propagates (distinct from inherit)', () => {
    expect(buildWorkerArgs({ concurrency: 1, queue: 'q', maxRssMb: 0, nice_requested: 0 }))
      .toContain('--nice');
  });

  test('omits --nice when nice_requested is undefined (inherit)', () => {
    expect(buildWorkerArgs({ concurrency: 1, queue: 'q', maxRssMb: 0 }))
      .not.toContain('--nice');
  });

  // issue #5 — conditional pass-through: inline/omitted keeps existing
  // deployments' argv byte-identical (the pinned arrays above never change).
  test('appends --job-isolation process when set', () => {
    expect(buildWorkerArgs({ concurrency: 2, queue: 'default', maxRssMb: 0, jobIsolation: 'process' }))
      .toEqual(['jobs', 'work', '--concurrency', '2', '--queue', 'default', '--job-isolation', 'process']);
  });

  test('omits --job-isolation when inline or undefined', () => {
    expect(buildWorkerArgs({ concurrency: 1, queue: 'q', maxRssMb: 0, jobIsolation: 'inline' }))
      .not.toContain('--job-isolation');
    expect(buildWorkerArgs({ concurrency: 1, queue: 'q', maxRssMb: 0 }))
      .not.toContain('--job-isolation');
  });
});

describe('buildWorkerArgs — --allow-shell-jobs pass-through', () => {
  // The shell-handler opt-in travels as a FLAG, not only as env: the worker's
  // cwd-.env quarantine drops GBRAIN_ALLOW_SHELL_JOBS whenever a .env in the
  // worker's cwd assigns it, so an env-only handoff could silently disable
  // shell jobs on a supervised worker.
  test('appends --allow-shell-jobs when allowShellJobs is true', () => {
    expect(buildWorkerArgs({ concurrency: 2, queue: 'default', maxRssMb: 0, allowShellJobs: true }))
      .toEqual(['jobs', 'work', '--concurrency', '2', '--queue', 'default', '--allow-shell-jobs']);
  });

  test('omits --allow-shell-jobs when false or undefined (argv byte-identical)', () => {
    expect(buildWorkerArgs({ concurrency: 1, queue: 'q', maxRssMb: 0, allowShellJobs: false }))
      .toEqual(['jobs', 'work', '--concurrency', '1', '--queue', 'q']);
    expect(buildWorkerArgs({ concurrency: 1, queue: 'q', maxRssMb: 0 }))
      .not.toContain('--allow-shell-jobs');
  });

  test('composes after --nice / --job-isolation in a stable order', () => {
    expect(buildWorkerArgs({ concurrency: 2, queue: 'default', maxRssMb: 0, nice_requested: 5, jobIsolation: 'process', allowShellJobs: true }))
      .toEqual(['jobs', 'work', '--concurrency', '2', '--queue', 'default', '--nice', '5', '--job-isolation', 'process', '--allow-shell-jobs']);
  });
});
