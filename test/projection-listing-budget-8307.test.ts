/** #8307: only a bounded segmented census timeout is a retryable empty resident turn. */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { ProjectionListingDeadlineError, rebuildPendingSegmentedProjections } from '../src/core/page-body/projection.ts';

function engine(kind: 'postgres' | 'pglite', executeRaw: BrainEngine['executeRaw']): BrainEngine {
  return { kind, executeRaw } as BrainEngine;
}

test('the selector carries a server bound and pool-wait signal, and cancels its timer on success', async () => {
  let options: Parameters<BrainEngine['executeRaw']>[2];
  const e = engine('postgres', async (_sql, _params, opts) => { options = opts; return []; });
  expect(await rebuildPendingSegmentedProjections(e, 100, { deadlineMs: 20 })).toEqual({ rebuilt: 0, failed: 0, listed: [] });
  expect(options?.timeoutMs).toBeGreaterThan(0);
  expect(options?.timeoutMs).toBeLessThanOrEqual(20);
  expect(options?.deadlineAt).toBeGreaterThan(0);
  expect(options?.signal?.aborted).toBe(false);
  await Bun.sleep(40);
  expect(options?.signal?.aborted).toBe(false);
});

test('an already exhausted budget sends no census; ordinary unbounded and PGLite reads stay unchanged', async () => {
  const calls: Array<Parameters<BrainEngine['executeRaw']>[2]> = [];
  const e = engine('postgres', async (_sql, _params, opts) => { calls.push(opts); return []; });
  await rebuildPendingSegmentedProjections(e, 100, { deadlineMs: 0 });
  expect(calls).toEqual([]);
  await rebuildPendingSegmentedProjections(e, 100);
  await rebuildPendingSegmentedProjections(engine('pglite', e.executeRaw), 100, { deadlineMs: 20 });
  expect(calls).toEqual([undefined, undefined]);
});

for (const code of ['57014', '55P03', '42501', 'XX000', 'CONNECTION_CLOSED']) test(`bounded listing classifies ${code} without hiding storage failures`, async () => {
  const error = Object.assign(new Error('Synthetic read failure'), { code });
  const e = engine('postgres', async () => { throw error; });
  if (code === '57014' || code === '55P03') {
    const result = await rebuildPendingSegmentedProjections(e, 100, { deadlineMs: 20 }).catch(caught => caught);
    expect(result).toBeInstanceOf(ProjectionListingDeadlineError);
    expect(result.cause).toBe(error);
  } else await expect(rebuildPendingSegmentedProjections(e, 100, { deadlineMs: 20 })).rejects.toBe(error);
  await expect(rebuildPendingSegmentedProjections(e, 100)).rejects.toBe(error);
});
