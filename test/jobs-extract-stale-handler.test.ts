/**
 * The remediation planner uses `stale_pages` for the DB-backed link/timeline
 * extraction watermark. The worker must preserve that meaning: a queued
 * `extract` job with `stale: true` must call the DB stale extractor and keep
 * the requested source boundary, never fall through to filesystem extraction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { addSource } from '../src/core/sources-ops.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await addSource(engine, { id: 'archive', localPath: null });
  await engine.putPage('archive-note', {
    title: 'Archive note',
    type: 'note' as never,
    compiled_truth: 'A DB-only page whose extraction watermark starts stale.',
    timeline: '',
    frontmatter: {},
    source_path: null,
  }, { sourceId: 'archive' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('extract worker stale mode', () => {
  it('reports the requested source DB backlog on dry-run', async () => {
    const worker = new MinionWorker(engine, { concurrency: 1 });
    await registerBuiltinHandlers(worker, engine);
    const handler = (worker as unknown as {
      handlers: Map<string, (job: unknown) => Promise<unknown>>;
    }).handlers.get('extract');
    if (!handler) throw new Error('extract handler not registered');

    const result = await handler({
      id: 1,
      data: { stale: true, dryRun: true, sourceId: 'archive' },
      updateProgress: async () => {},
    }) as { pagesProcessed: number; staleRemaining: number };

    expect(result).toEqual(expect.objectContaining({
      pagesProcessed: 0,
      staleRemaining: 1,
    }));
    expect(await engine.countStalePagesForExtraction({ sourceId: 'archive' })).toBe(1);
  });
});
