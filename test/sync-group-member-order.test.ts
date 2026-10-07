/**
 * #6153 class (wave 11, PR #6263 CI): a bulk-sync group member released back to the queue mid-group (its group
 * fell back to the single path and an earlier member went back to the queue with `writer_busy`) was later
 * claimed on its own and published, although the member before it in its group then failed. Its `after` names
 * only the previous group, so the window checks (`cancelOrphanedWindowGroup`, the lane claim, the drain's
 * `cancelOrphanedLaneRows`) let it through and a page after a failed page published. A group member's
 * predecessor is the member before it: a member whose predecessor ended without committing is cancelled, and
 * under lanes a member whose predecessor is still unfinished waits. Postgres only (bulk groups and lanes).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { cancelOrphanedLaneRows, WINDOW_CANCEL_MESSAGE } from '../src/core/persistence/sync-window.ts';
import { closeLaneRun, openLanes } from '../src/core/persistence/sync-lanes.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type FixtureSource, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

async function withBrain(run: (ctx: { engine: BrainEngine; config: HarnessConfig; sources: FixtureSource[] }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-group-order-'));
  const config: HarnessConfig = { kind: 'postgres', root, dataDir: join(root, 'unused'), hostId: randomUUID(),
    seed: 6153, schedules: 0, operations: 0, sourceIds: ['group-order'], principalIds: [randomUUID()] };
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 6);
  try {
    await withEnv({ GBRAIN_HOME: root, GBRAIN_PERSISTENCE_FIXTURE_HOME: root }, async () => {
      selectFixtureHost(config.hostId);
      await initializeFixtures(pg.engine, config);
      await run({ engine: pg.engine, config, sources: await fixtures(pg.engine, config) });
    });
  } finally { await pg.close(); rmSync(root, { recursive: true, force: true }); }
}

/** Head `b` and member `c` of one bulk group (as formGroup names them), optionally in an open lane run. */
async function group(engine: BrainEngine, config: HarnessConfig, source: FixtureSource, lane: string | null) {
  const headId = randomUUID();
  const member = (slug: string, requestId: string) => {
    const intent = { content: `${slug} body`, group: headId, ...(lane ? { lane } : {}) };
    return admitWrite(engine, admission(config, source, slug, '', 0, { requestId, callerIntent: intent, intent }));
  };
  const b = await member('order/b', headId);
  const c = await member('order/c', randomUUID());
  return { b, c };
}
function consumer(engine: BrainEngine, config: HarnessConfig, sources: FixtureSource[]) {
  const errors: unknown[] = [];
  const instance = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_engine, row) => prepared(row, sources),
    { hostId: config.hostId, concurrency: 1, pollMs: 20, onError: error => errors.push(error) });
  return { instance, errors };
}
const state = async (engine: BrainEngine, row: WriteRequest) => (await getWriteRequestById(engine, row.id))!;
const pageOf = async (engine: BrainEngine, source: FixtureSource, slug: string) => engine.getPage(slug, { sourceId: source.id });

describe.skipIf(!process.env.DATABASE_URL)('a bulk group member never publishes after the member before it ended without committing', () => {
  test('FIFO claim: the member is cancelled, not published', () => withBrain(async ({ engine, config, sources }) => {
    const { b, c } = await group(engine, config, sources[0]!, null);
    await cancelWriteRequest(engine, { kind: 'local_cli', id: b.principal_id }, b.request_id);
    const { instance } = consumer(engine, config, sources);
    try {
      instance.start();
      await waitFor(async () => !['queued', 'running'].includes((await state(engine, c)).state), { timeoutMs: 15_000, label: 'the member settles' });
    } finally { await instance.stop(); }
    expect(await state(engine, c)).toMatchObject({ state: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE });
    expect(await pageOf(engine, sources[0]!, 'order/c')).toBeNull();
  }), 120_000);

  test('lane claim: the member is cancelled, not published', () => withBrain(async ({ engine, config, sources }) => {
    const run = randomUUID();
    const { b, c } = await group(engine, config, sources[0]!, run);
    await cancelWriteRequest(engine, { kind: 'local_cli', id: b.principal_id }, b.request_id);
    openLanes(sources[0]!.binding.worktree_id, run, 4, null);
    const { instance } = consumer(engine, config, sources);
    try {
      instance.start();
      await waitFor(async () => !['queued', 'running'].includes((await state(engine, c)).state), { timeoutMs: 15_000, label: 'the member settles' });
    } finally { await instance.stop(); await closeLaneRun(run, 5_000); }
    expect(await state(engine, c)).toMatchObject({ state: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE });
    expect(await pageOf(engine, sources[0]!, 'order/c')).toBeNull();
  }), 120_000);

  test('the drain-end sweep cancels a queued member whose predecessor failed', () => withBrain(async ({ engine, config, sources }) => {
    const run = randomUUID();
    const { b, c } = await group(engine, config, sources[0]!, run);
    await cancelWriteRequest(engine, { kind: 'local_cli', id: b.principal_id }, b.request_id);
    await cancelOrphanedLaneRows(engine, run);
    expect(await state(engine, c)).toMatchObject({ state: 'cancelled', error_message: WINDOW_CANCEL_MESSAGE });
  }), 120_000);

  test('a member whose predecessor committed still publishes', () => withBrain(async ({ engine, config, sources }) => {
    const run = randomUUID();
    const { c } = await group(engine, config, sources[0]!, run);
    openLanes(sources[0]!.binding.worktree_id, run, 4, null);
    const { instance } = consumer(engine, config, sources);
    try {
      instance.start();
      await waitFor(async () => (await state(engine, c)).state === 'committed', { timeoutMs: 15_000, label: 'both pages commit' });
    } finally { await instance.stop(); await closeLaneRun(run, 5_000); }
    const rows = await engine.executeRaw<{ slug: string; state: string }>(`SELECT slug,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence`, [sources[0]!.id]);
    expect(rows).toEqual([{ slug: 'order/b', state: 'committed' }, { slug: 'order/c', state: 'committed' }]);
  }), 120_000);
});

