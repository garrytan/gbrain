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
});
