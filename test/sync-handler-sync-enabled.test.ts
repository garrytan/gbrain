/**
 * Queued freshness syncs re-read syncEnabled before running; explicit jobs
 * still run. Reverting the handler guard makes the disabled-source assertion
 * fail. Dispatcher tests only cover enqueue time, not a later config change.
 * Uses real PGLite source rows and the existing performSync boundary (stubbed
 * to avoid filesystem/provider work); no production-only test seam is needed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as sync from '../src/commands/sync.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let perform: ReturnType<typeof spyOn<typeof sync, 'performSync'>>;
const syncResult: sync.SyncResult = {
  status: 'up_to_date', fromCommit: null, toCommit: '',
  added: 0, modified: 0, deleted: 0, renamed: 0,
  chunksCreated: 0, embedded: 0, pagesAffected: [],
};
const sourceId = 'sync-example';
const repoPath = '/fixture/sync-example';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, $2, '{}'::jsonb)`,
    [sourceId, repoPath],
  );
  perform = spyOn(sync, 'performSync').mockResolvedValue(syncResult);
});

afterEach(() => {
  perform.mockRestore();
});

function makeJob(data: Record<string, unknown>): MinionJobContext {
  return {
    id: 1, name: 'sync', data, attempts_made: 0, deadlineAtMs: null,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {}, updateTokens: async () => {},
    log: async () => {}, isActive: async () => true, readInbox: async () => [],
  };
}

async function setConfig(config: unknown): Promise<void> {
  await engine.executeRaw(
    'UPDATE sources SET config = $1::text::jsonb WHERE id = $2',
    [JSON.stringify(config), sourceId],
  );
}

async function expectRuns(data: Record<string, unknown>): Promise<void> {
  const result = await makeSyncHandler(engine)(makeJob(data));
  expect(perform).toHaveBeenCalledTimes(1);
  expect(perform.mock.calls[0][0]).toBe(engine);
  expect(perform.mock.calls[0][1]).toMatchObject({ sourceId, noPull: true });
  expect(result).toMatchObject(syncResult);
}

describe('sync handler execution-time syncEnabled policy', () => {
  test('freshness job disabled after enqueue skips without calling performSync', async () => {
    await setConfig({ syncEnabled: true });
    const job = makeJob({ sourceId, repoPath, pull: false, auto_embed_backfill: true, embed_reason: 'autopilot_freshness' });
    const handler = makeSyncHandler(engine);
    await setConfig({ syncEnabled: false });

    const result = await handler(job);
    expect(perform).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'sync_disabled', source_id: sourceId });
  });

  for (const config of [{}, { syncEnabled: true }]) {
    test(`freshness job runs with config ${JSON.stringify(config)}`, async () => {
      await setConfig(config);
      await expectRuns({ sourceId, repoPath, pull: false, embed_reason: 'autopilot_freshness' });
    });
  }

  test('unmarked explicit job still runs for a disabled source', async () => {
    await setConfig({ syncEnabled: false });
    await expectRuns({ sourceId, repoPath, pull: false, auto_embed_backfill: true });
  });

  test('other embed reasons do not identify freshness jobs', async () => {
    await setConfig({ syncEnabled: false });
    await expectRuns({ sourceId, repoPath, pull: false, embed_reason: 'sync_handler' });
  });

  test('connector-shaped freshness job skips without a repoPath', async () => {
    await setConfig({ kind: 'github', syncEnabled: false });
    const result = await makeSyncHandler(engine)(makeJob({ sourceId, pull: false, embed_reason: 'autopilot_freshness' }));
    expect(perform).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'sync_disabled', source_id: sourceId });
  });

  test('repoPath-resolved source uses the same guard for JSON-string config', async () => {
    await setConfig(JSON.stringify({ syncEnabled: false }));
    const result = await makeSyncHandler(engine)(makeJob({ repoPath, pull: false, embed_reason: 'autopilot_freshness' }));
    expect(perform).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'sync_disabled', source_id: sourceId });
  });

  test('source lookup failure preserves the existing sync attempt', async () => {
    await setConfig({ syncEnabled: false });
    const lookup = spyOn(engine, 'executeRaw').mockRejectedValue(new Error('source lookup unavailable'));
    try {
      await expectRuns({ sourceId, repoPath, pull: false, embed_reason: 'autopilot_freshness' });
    } finally {
      lookup.mockRestore();
    }
  });

  test('missing source preserves the existing sync attempt', async () => {
    await engine.executeRaw('DELETE FROM sources WHERE id = $1', [sourceId]);
    await expectRuns({ sourceId, repoPath, pull: false, embed_reason: 'autopilot_freshness' });
  });
});
