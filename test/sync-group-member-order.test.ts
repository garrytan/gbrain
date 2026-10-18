/**
 * #6153 class (wave 11, PR #6263 CI) and #6712 (one page, one fate): a bulk-sync group member's predecessor is the
 * member before it in its group (its `after` names only the previous group). Under lanes a member whose predecessor
 * is still unfinished releases its claim and waits, so lane commits stay in manifest order. Since #6712 a member whose
 * predecessor ended without committing publishes on its own: the members of a sync group share a transaction budget,
 * never a fate (dependency edges keep two changes of one page out of the same group). Postgres only (bulk groups and lanes).
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

describe.skipIf(!process.env.DATABASE_URL)('a bulk group member has its own fate: it publishes after the member before it ended, committed or not', () => {
  test('FIFO claim: a member whose predecessor was cancelled publishes on its own', () => withBrain(async ({ engine, config, sources }) => {
    const { b, c } = await group(engine, config, sources[0]!, null);
    await cancelWriteRequest(engine, { kind: 'local_cli', id: b.principal_id }, b.request_id);
    const { instance } = consumer(engine, config, sources);
    try {
      instance.start();
      await waitFor(async () => !['queued', 'running'].includes((await state(engine, c)).state), { timeoutMs: 15_000, label: 'the member settles' });
    } finally { await instance.stop(); }
    expect(await state(engine, c)).toMatchObject({ state: 'committed' });
    expect(await pageOf(engine, sources[0]!, 'order/c')).not.toBeNull();
    expect(await pageOf(engine, sources[0]!, 'order/b')).toBeNull();
  }), 120_000);

  test('lane claim: a member whose predecessor was cancelled publishes on its own', () => withBrain(async ({ engine, config, sources }) => {
    const run = randomUUID();
    const { b, c } = await group(engine, config, sources[0]!, run);
    await cancelWriteRequest(engine, { kind: 'local_cli', id: b.principal_id }, b.request_id);
    openLanes(sources[0]!.binding.worktree_id, run, 4, null);
    const { instance } = consumer(engine, config, sources);
    try {
      instance.start();
      await waitFor(async () => !['queued', 'running'].includes((await state(engine, c)).state), { timeoutMs: 15_000, label: 'the member settles' });
    } finally { await instance.stop(); await closeLaneRun(run, 5_000); }
    expect(await state(engine, c)).toMatchObject({ state: 'committed' });
    expect(await pageOf(engine, sources[0]!, 'order/c')).not.toBeNull();
  }), 120_000);

  test('a member whose predecessor committed still publishes, after it', () => withBrain(async ({ engine, config, sources }) => {
    const run = randomUUID();
    const { c } = await group(engine, config, sources[0]!, run);
    openLanes(sources[0]!.binding.worktree_id, run, 4, null);
    const { instance } = consumer(engine, config, sources);
    try {
      instance.start();
      await waitFor(async () => (await state(engine, c)).state === 'committed', { timeoutMs: 15_000, label: 'both pages commit' });
    } finally { await instance.stop(); await closeLaneRun(run, 5_000); }
    const rows = await engine.executeRaw<{ slug: string; state: string }>(`SELECT slug,state FROM persistence_requests WHERE source_id=$1 ORDER BY completed_at, sequence`, [sources[0]!.id]);
    expect(rows).toEqual([{ slug: 'order/b', state: 'committed' }, { slug: 'order/c', state: 'committed' }]);
  }), 120_000);

  test('#6712 (Eng 2): a sync group keeps its claim size and its preparation width of four; only its fate changed', () => withBrain(async ({ engine, config, sources }) => {
    const headId = randomUUID();
    const slugs = Array.from({ length: 12 }, (_, i) => `order/m${i}`);
    for (const [i, slug] of slugs.entries()) {
      const intent = { content: `${slug} body`, group: headId };
      await admitWrite(engine, admission(config, sources[0]!, slug, '', 0, { requestId: i === 0 ? headId : randomUUID(), callerIntent: intent, intent }));
    }
    let inFlight = 0, widest = 0;
    const groups = new Set<unknown>();
    const instance = new PersistenceConsumer(engine, { engine: 'postgres' }, async (reads, row) => {
      groups.add(reads); widest = Math.max(widest, ++inFlight);
      try { await new Promise(resolve => setTimeout(resolve, 50)); return prepared(row, sources); } finally { inFlight--; }
    }, { hostId: config.hostId, concurrency: 1, pollMs: 20 });
    try {
      instance.start();
      await waitFor(async () => (await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state<>'committed'", [sources[0]!.id])).length === 0,
        { timeoutMs: 30_000, label: 'every member commits' });
    } finally { await instance.stop(); }
    // One claim took all twelve members (a batch group would stop at PAGE_BATCH_GROUP_MAX), prepared four at a time.
    expect(groups.size).toBe(1);
    expect(widest).toBe(4);
  }), 120_000);
});
