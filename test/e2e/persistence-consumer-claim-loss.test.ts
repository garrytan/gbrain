/**
 * #5373 on Postgres: a consumer that loses its claim during preparation lets
 * go. Protects: claim lifetime and scheduling in the durable write path for
 * the single route and the grouped (put_pages batch) route. Fails when: a lost
 * claim keeps the consumer slot until an unbounded preparation finishes, a
 * hung renewal blocks the task forever, the release resets a competing
 * consumer's claim, or the abandoned preparation publishes after the loss.
 * The renewal cadence is the committed `renewalIntervalMs` seam; takeover is
 * modelled the way a competing consumer claims an expired lease (a new
 * execution token on the row), and the hung renewal is a real row lock.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { admitWrite, getWriteRequestById } from '../../src/core/persistence/journal.ts';
import { publishMutation, type PreparedMutation } from '../../src/core/persistence/coordinator.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type FixtureSource, type HarnessConfig } from '../../scripts/persistence/harness.ts';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';

async function withBrain(run: (ctx: { engine: PostgresEngine; config: HarnessConfig; sources: FixtureSource[]; url: string }) => Promise<void>) {
  assertSafeE2eDatabaseUrl(DATABASE_URL);
  const name = `gbrain_test_claim_loss_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL); url.pathname = `/${name}`;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-claim-loss-'));
  const config: HarnessConfig = { kind: 'postgres', root, dataDir: join(root, 'unused'), hostId: randomUUID(),
    seed: 5373, schedules: 0, operations: 0, sourceIds: ['claim-loss', 'claim-loss-other'], principalIds: [randomUUID()] };
  const engine = new PostgresEngine();
  try {
    await withEnv({ GBRAIN_HOME: root, GBRAIN_PERSISTENCE_FIXTURE_HOME: root }, async () => {
      await engine.connect({ database_url: url.toString(), poolSize: 6 });
      await engine.initSchema();
      selectFixtureHost(config.hostId);
      await initializeFixtures(engine, config);
      await run({ engine, config, sources: await fixtures(engine, config), url: url.toString() });
    });
  } finally {
    await engine.disconnect();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
    rmSync(root, { recursive: true, force: true });
  }
}

const activeRoots = (consumer: PersistenceConsumer) => (consumer as unknown as { activeRoots: Set<string> }).activeRoots;
const pageExists = async (engine: PostgresEngine, slug: string) =>
  (await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', [slug])).length > 0;

describe.skipIf(!hasDatabase())('persistence consumer claim loss (Postgres)', () => {
  test('competing takeover: the slot frees, the root waits, the takeover commits and the late preparation never publishes', () => withBrain(async ({ engine, config, sources }) => {
    const first = await admitWrite(engine, admission(config, sources[0]!, 'claim-loss/first', 'first body'));
    const other = await admitWrite(engine, admission(config, sources[1]!, 'claim-loss/other', 'other body'));
    const late = Promise.withResolvers<PreparedMutation>();
    const started: string[] = [];
    const errors: unknown[] = [];
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_engine, row) => {
      started.push(row.id);
      return row.id === first.id ? late.promise : prepared(row, sources);
    }, { hostId: config.hostId, concurrency: 1, pollMs: 60_000, renewalIntervalMs: 20, phaseMs: 2_000, onError: error => errors.push(error) });
    try {
      consumer.start();
      await waitFor(() => started[0] === first.id, { timeoutMs: 10_000 });
      const takeover = randomUUID();
      await engine.executeRaw(`UPDATE persistence_requests SET execution_token=$2::uuid, claim_expires_at=now()+interval '30 seconds' WHERE id=$1::uuid`, [first.id, takeover]);
      await waitFor(() => consumer.status().active_preparations === 0, { timeoutMs: 10_000, label: 'the lost claim frees the consumer slot' });
      const held = await getWriteRequestById(engine, first.id);
      expect({ state: held?.state, token: held?.execution_token }).toEqual({ state: 'running', token: takeover });
      expect(activeRoots(consumer).has(first.worktree_id!)).toBe(true);

      (consumer as unknown as { rootRetryAfter: Map<string, number> }).rootRetryAfter.set(first.worktree_id!, Date.now() + 60_000);
      await consumer.tick();
      await waitFor(async () => (await getWriteRequestById(engine, other.id))?.state === 'committed', { timeoutMs: 10_000, label: 'an unrelated root progresses' });

      const committed = await publishMutation(engine, held!, prepared({ ...held!, intent: { ...held!.intent, content: 'takeover body' } }, sources), config.hostId);
      expect(committed.state).toBe('committed');
      late.resolve(prepared(first, sources));
      await waitFor(() => !activeRoots(consumer).has(first.worktree_id!), { timeoutMs: 10_000, label: 'the root is released once the abandoned preparation settles' });
      await consumer.stop();
      expect((await getWriteRequestById(engine, first.id))?.state).toBe('committed');
      const [page] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug='claim-loss/first'`);
      expect(page?.compiled_truth).toBe('takeover body');
      expect(errors).toEqual([]);
    } finally {
      late.resolve(prepared(first, sources));
      await consumer.stop();
    }
  }), 90_000);

  test('a renewal blocked by a row lock times out under its deadline, releases the claim and stop() drains it', () => withBrain(async ({ engine, config, sources, url }) => {
    const row = await admitWrite(engine, admission(config, sources[0]!, 'claim-loss/locked', 'locked body'));
    const late = Promise.withResolvers<PreparedMutation>();
    let preparing = false;
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async () => { preparing = true; return late.promise; },
      { hostId: config.hostId, concurrency: 1, pollMs: 60_000, renewalIntervalMs: 20, phaseMs: 300, onError: () => {} });
    const locker = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    const lockHeld = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    let lockTx: Promise<unknown> | undefined;
    try {
      consumer.start();
      await waitFor(() => preparing, { timeoutMs: 10_000 });
      lockTx = locker.begin(async tx => {
        await tx`SELECT id FROM persistence_requests WHERE id=${row.id}::uuid FOR UPDATE`;
        lockHeld.resolve();
        await unlock.promise;
      });
      await lockHeld.promise;
      const waiting = (needle: string) => engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [`%${needle}%`]).then(([r]) => r!.n);
      await waitFor(async () => await waiting(`SET state='queued'`) === 1, { timeoutMs: 10_000, label: 'the hung renewal loses the claim within its deadline and the release is next' });
      expect(await waiting('claim_expires_at=now()+')).toBe(0);
      unlock.resolve();
      await lockTx;
      await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'queued', { timeoutMs: 10_000, label: 'the unpublished claim is released' });
      expect((await getWriteRequestById(engine, row.id))?.blocked_reason).toBe('claim_lost');
      let stopped = false;
      const stopping = consumer.stop().then(() => { stopped = true; });
      await Bun.sleep(100);
      expect(stopped).toBe(false);
      late.resolve(prepared(row, sources));
      await stopping;
      expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
      expect(await pageExists(engine, 'claim-loss/locked')).toBe(false);
    } finally {
      unlock.resolve();
      await lockTx?.catch(() => {});
      late.resolve(prepared(row, sources));
      await consumer.stop();
      await locker.end();
    }
  }), 90_000);

  test('grouped route: a member taken over during preparation abandons the group; nothing publishes and only our claims are released', () => withBrain(async ({ engine, config, sources }) => {
    const batch = randomUUID();
    const rows: WriteRequest[] = [];
    for (let i = 0; i < 3; i++) {
      rows.push(await admitWrite(engine, admission(config, sources[0]!, `claim-loss/batch-${i}`, `batch body ${i}`, 0,
        { intent: { content: `batch body ${i}`, page_batch: { id: batch, index: i, size: 3 } }, callerIntent: { content: `batch body ${i}` } })));
    }
    const late = Promise.withResolvers<PreparedMutation>();
    const started: string[] = [];
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_engine, row) => {
      started.push(row.id);
      return row.id === rows[0]!.id ? late.promise : prepared(row, sources);
    }, { hostId: config.hostId, concurrency: 1, pollMs: 60_000, renewalIntervalMs: 20, phaseMs: 2_000, onError: () => {} });
    try {
      consumer.start();
      await waitFor(() => started.length === 3, { timeoutMs: 10_000, label: 'the batch is claimed as one group' });
      const takeover = randomUUID();
      await engine.executeRaw(`UPDATE persistence_requests SET execution_token=$2::uuid WHERE id=$1::uuid`, [rows[1]!.id, takeover]);
      await waitFor(() => consumer.status().active_preparations === 0 && (consumer as unknown as { active: Set<unknown> }).active.size === 0,
        { timeoutMs: 10_000, label: 'the group task ends after the member claim is lost' });
      const states = await Promise.all(rows.map(row => getWriteRequestById(engine, row.id)));
      expect(states.map(row => [row?.state, row?.blocked_reason ?? null])).toEqual([['queued', 'claim_lost'], ['running', null], ['queued', 'claim_lost']]);
      expect(states[1]?.execution_token).toBe(takeover);
      expect(activeRoots(consumer).has(rows[0]!.worktree_id!)).toBe(true);
      late.resolve(prepared(rows[0]!, sources));
      await waitFor(() => !activeRoots(consumer).has(rows[0]!.worktree_id!), { timeoutMs: 10_000 });
      await consumer.stop();
      for (let i = 0; i < 3; i++) expect(await pageExists(engine, `claim-loss/batch-${i}`)).toBe(false);
    } finally {
      late.resolve(prepared(rows[0]!, sources));
      await consumer.stop();
    }
  }), 90_000);
});
