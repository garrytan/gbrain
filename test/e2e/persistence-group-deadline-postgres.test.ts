/**
 * #6278 on Postgres: the grouped route under preparation deadlines. Protects:
 * each member's budget clock starts at its dispatch, the group lease keeps
 * renewing the members still held after one is released (one release never
 * reads as a lost group lease), member k's expiry releases k charged
 * (`preparation_deadline`, attempts +1) and the later members uncharged
 * (`group_member_waiting`), the contiguous prepared prefix publishes, an
 * independent `batch:` group releases only k, `laneFallback` keeps the expired
 * member's reason, a late result of an abandoned member never publishes and
 * the root waits for it, and the expired-claim sweep (the kill case) charges
 * only the members whose dispatch was marked. Fails when a mid-group release
 * takes the whole group down as `claim_lost` (#6278's default path), when a
 * waiting member is charged, or when an undispatched follower is charged.
 * Pre-#6278 the group path had no deadline at all (a signal-ignoring member
 * held its root for as long as renewals ran), so every case here failed by
 * hanging.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { PreparationDeadlineError } from '../../src/core/persistence/bounded-reads.ts';
import { admitWrite, getWriteRequestById } from '../../src/core/persistence/journal.ts';
import type { PreparedMutation } from '../../src/core/persistence/coordinator.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { closeLaneRun, openLanes } from '../../src/core/persistence/sync-lanes.ts';
import { admission, fixtures, initializeFixtures, prepared, selectFixtureHost, type FixtureSource, type HarnessConfig } from '../../scripts/persistence/harness.ts';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';

async function withBrain(run: (ctx: { engine: PostgresEngine; config: HarnessConfig; sources: FixtureSource[] }) => Promise<void>) {
  assertSafeE2eDatabaseUrl(DATABASE_URL);
  const name = `gbrain_test_group_deadline_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL); url.pathname = `/${name}`;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-group-deadline-'));
  const config: HarnessConfig = { kind: 'postgres', root, dataDir: join(root, 'unused'), hostId: randomUUID(),
    seed: 6278, schedules: 0, operations: 0, sourceIds: ['group-deadline', 'group-deadline-other'], principalIds: [randomUUID()] };
  const engine = new PostgresEngine();
  try {
    await withEnv({ GBRAIN_HOME: root, GBRAIN_PERSISTENCE_FIXTURE_HOME: root }, async () => {
      await engine.connect({ database_url: url.toString(), poolSize: 6 });
      await engine.initSchema();
      selectFixtureHost(config.hostId);
      await initializeFixtures(engine, config);
      await run({ engine, config, sources: await fixtures(engine, config) });
    });
  } finally {
    await engine.disconnect();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
    rmSync(root, { recursive: true, force: true });
  }
}

/** Admits `size` members of one ordered (sync-shaped) or independent (batch) group. */
async function admitGroup(engine: PostgresEngine, config: HarnessConfig, source: FixtureSource, name: string, size: number,
  shape: 'ordered' | 'batch', extra: Record<string, unknown> = {}): Promise<WriteRequest[]> {
  const rows: WriteRequest[] = [];
  const id = randomUUID();
  // An ordered group's key is its head's request id, as a bulk sync's is.
  for (let i = 0; i < size; i++) {
    const content = `${name} body ${i}`;
    const requestId = i === 0 ? id : randomUUID();
    const intent = shape === 'batch' ? { content, page_batch: { id, index: i, size } } : { content, group: id, ...extra };
    rows.push(await admitWrite(engine, admission(config, source, `${name}/m${i}`, content, 0, { intent, callerIntent: { content }, requestId })));
  }
  return rows;
}
const stateOf = async (engine: PostgresEngine, rows: WriteRequest[]) => Promise.all(rows.map(async row => {
  const current = (await getWriteRequestById(engine, row.id))!;
  return { state: current.state, reason: current.blocked_reason ?? null, attempts: current.preparation_attempts, error: current.error_code ?? null };
}));
const pageExists = async (engine: PostgresEngine, slug: string) => (await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', [slug])).length > 0;
const activeRoots = (consumer: PersistenceConsumer) => (consumer as unknown as { activeRoots: Set<string> }).activeRoots;

/** A preparer that hangs on `hung` ids, ignoring its signal, until released; counts the attempts per request. */
function hangingPreparer(sources: FixtureSource[], hung: Set<string>, release: Promise<void>, attempts: Map<string, number>) {
  return async (_engine: unknown, row: WriteRequest): Promise<PreparedMutation> => {
    attempts.set(row.id, (attempts.get(row.id) ?? 0) + 1);
    if (hung.has(row.id) && attempts.get(row.id) === 1) { await release; }
    return prepared(row, sources);
  };
}

describe.skipIf(!hasDatabase())('grouped preparation deadlines (Postgres, #6278)', () => {
  for (const position of ['first', 'middle', 'last'] as const) {
    test(`an ordered group: the ${position} member expiring releases it charged, the later members uncharged, and the prefix publishes`, () => withBrain(async ({ engine, config, sources }) => {
      const rows = await admitGroup(engine, config, sources[0]!, `ordered-${position}`, 6, 'ordered');
      const k = position === 'first' ? 0 : position === 'middle' ? 2 : 5;
      const release = Promise.withResolvers<void>();
      const attempts = new Map<string, number>();
      const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, hangingPreparer(sources, new Set([rows[k]!.id]), release.promise, attempts),
        { hostId: config.hostId, concurrency: 1, pollMs: 50, renewalIntervalMs: 20, phaseMs: 2_000, preparationMs: 80,
          preparationBudgets: { maxAttempts: 5, ceilingMs: 60_000 }, onError: () => {} });
      try {
        consumer.start();
        await waitFor(async () => (await getWriteRequestById(engine, rows[k]!.id))?.blocked_reason === 'preparation_deadline', { timeoutMs: 15_000, label: `member ${k} is released at its budget` });
        await waitFor(async () => (await stateOf(engine, rows.slice(k + 1))).every(s => s.state === 'queued'), { timeoutMs: 15_000, label: 'the suffix is released' });
        // The prefix publishes (one at a time: the harness rows are not groupable), the suffix waits uncharged, k is charged once.
        for (let i = 0; i < k; i++) await waitFor(async () => (await getWriteRequestById(engine, rows[i]!.id))?.state === 'committed', { timeoutMs: 15_000, label: `prefix member ${i} commits` });
        const states = await stateOf(engine, rows);
        expect(states[k]).toEqual({ state: 'queued', reason: 'preparation_deadline', attempts: 1, error: null });
        for (let i = k + 1; i < rows.length; i++) expect(states[i]).toEqual({ state: 'queued', reason: 'group_member_waiting', attempts: 0, error: null });
        // Members after k were never prepared (dispatch stops at the expiry); the same wave's later members may have been aborted.
        for (let i = Math.ceil((k + 1) / 4) * 4; i < rows.length; i++) expect(attempts.get(rows[i]!.id) ?? 0).toBe(0);
        // The abandoned member blocks its root until it settles: nothing re-claims k meanwhile and its late result never publishes.
        await Bun.sleep(300);
        expect(attempts.get(rows[k]!.id)).toBe(1);
        expect(activeRoots(consumer).has(rows[0]!.worktree_id!)).toBe(true);
        expect(await pageExists(engine, rows[k]!.slug)).toBe(false);
        release.resolve();
        // Once it settles, the root is free: the released members are claimed again in order and commit on a fresh preparation.
        for (const row of rows) await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 20_000, label: `${row.slug} commits after the retry` });
        expect(attempts.get(rows[k]!.id)).toBe(2);
        const final = await stateOf(engine, rows);
        // A commit resets the counter.
        expect(final.map(s => s.attempts)).toEqual(rows.map(() => 0));
        const [page] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [rows[k]!.slug]);
        expect(page?.compiled_truth).toBe(`ordered-${position} body ${k}`);
      } finally { release.resolve(); await consumer.stop(); }
    }), 90_000);
  }

  // #6278 (plan item 1.4): a bounded read the server ended inside the budget reports the deadline itself and cuts the group like the timer.
  test('a member whose read the server ended inside the budget is released charged, the later members uncharged, and the prefix publishes', () => withBrain(async ({ engine, config, sources }) => {
    const rows = await admitGroup(engine, config, sources[0]!, 'server-ended', 6, 'ordered');
    const k = 2;
    const attempts = new Map<string, number>();
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_engine: unknown, row: WriteRequest): Promise<PreparedMutation> => {
      attempts.set(row.id, (attempts.get(row.id) ?? 0) + 1);
      if (row.id === rows[k]!.id && attempts.get(row.id) === 1) throw new PreparationDeadlineError('origin_check', '57014', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
      return prepared(row, sources);
    }, { hostId: config.hostId, concurrency: 1, pollMs: 50, renewalIntervalMs: 20, phaseMs: 2_000, preparationMs: 5_000,
      preparationBudgets: { maxAttempts: 5, ceilingMs: 60_000 }, onError: () => {} });
    try {
      consumer.start();
      await waitFor(async () => (await getWriteRequestById(engine, rows[k]!.id))?.blocked_reason === 'preparation_deadline', { timeoutMs: 15_000, label: `member ${k} is released` });
      // The suffix is cut exactly as a timer deadline cuts it: released uncharged, never published ahead of k.
      await waitFor(async () => (await stateOf(engine, rows.slice(k + 1))).every(s => s.state === 'queued' && s.reason === 'group_member_waiting'), { timeoutMs: 15_000, label: 'the suffix is released waiting' });
      for (let i = 0; i < k; i++) await waitFor(async () => (await getWriteRequestById(engine, rows[i]!.id))?.state === 'committed', { timeoutMs: 15_000, label: `prefix member ${i} commits` });
      // No terminal receipt was written from the raw error, and k was charged once (it may already be claimed again by now).
      const states = await stateOf(engine, rows);
      expect(states.every(s => s.error === null)).toBe(true);
      expect(states[k]!.attempts).toBe(1);
      expect(states.slice(0, k).map(s => s.state)).toEqual(['committed', 'committed']);
      for (const row of rows) await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 20_000, label: `${row.slug} commits after the retry` });
      expect(attempts.get(rows[k]!.id)).toBe(2);
      expect((await stateOf(engine, rows)).map(s => s.attempts)).toEqual(rows.map(() => 0));
    } finally { await consumer.stop(); }
  }), 90_000);

  test('an independent batch group releases only the expired member; its siblings publish', () => withBrain(async ({ engine, config, sources }) => {
    const rows = await admitGroup(engine, config, sources[0]!, 'batch', 4, 'batch');
    const release = Promise.withResolvers<void>();
    const attempts = new Map<string, number>();
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, hangingPreparer(sources, new Set([rows[1]!.id]), release.promise, attempts),
      { hostId: config.hostId, concurrency: 1, pollMs: 50, renewalIntervalMs: 20, phaseMs: 2_000, preparationMs: 80,
        preparationBudgets: { maxAttempts: 5, ceilingMs: 60_000 }, onError: () => {} });
    try {
      consumer.start();
      await waitFor(async () => (await getWriteRequestById(engine, rows[1]!.id))?.blocked_reason === 'preparation_deadline', { timeoutMs: 15_000 });
      for (const i of [0, 2, 3]) await waitFor(async () => (await getWriteRequestById(engine, rows[i]!.id))?.state === 'committed', { timeoutMs: 15_000, label: `sibling ${i} commits` });
      const states = await stateOf(engine, rows);
      expect(states[1]).toEqual({ state: 'queued', reason: 'preparation_deadline', attempts: 1, error: null });
      expect(states.filter((_s, i) => i !== 1).map(s => s.state)).toEqual(['committed', 'committed', 'committed']);
      release.resolve();
      await waitFor(async () => (await getWriteRequestById(engine, rows[1]!.id))?.state === 'committed', { timeoutMs: 20_000 });
      expect(attempts.get(rows[1]!.id)).toBe(2);
    } finally { release.resolve(); await consumer.stop(); }
  }), 90_000);

  test('a member whose release reaches the attempt limit is finished failed/preparation_stalled at that release', () => withBrain(async ({ engine, config, sources }) => {
    const rows = await admitGroup(engine, config, sources[0]!, 'limit', 3, 'ordered');
    await engine.executeRaw(`UPDATE persistence_requests SET preparation_attempts=1 WHERE id=$1::uuid`, [rows[1]!.id]);
    const release = Promise.withResolvers<void>();
    const attempts = new Map<string, number>();
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, hangingPreparer(sources, new Set([rows[1]!.id]), release.promise, attempts),
      { hostId: config.hostId, concurrency: 1, pollMs: 50, renewalIntervalMs: 20, phaseMs: 2_000, preparationMs: 80,
        preparationBudgets: { maxAttempts: 2, ceilingMs: 60_000 }, onError: () => {} });
    try {
      consumer.start();
      await waitFor(async () => (await getWriteRequestById(engine, rows[1]!.id))?.state === 'failed', { timeoutMs: 15_000 });
      const failed = (await getWriteRequestById(engine, rows[1]!.id))!;
      expect(failed).toMatchObject({ error_code: 'preparation_stalled', preparation_attempts: 2 });
      expect(failed.error_detail).toMatchObject({ origin: 'preparation_stall', attempts: 2, limit: 2 });
      await waitFor(async () => (await getWriteRequestById(engine, rows[0]!.id))?.state === 'committed', { timeoutMs: 15_000 });
      expect((await stateOf(engine, [rows[2]!]))[0]).toEqual({ state: 'queued', reason: 'group_member_waiting', attempts: 0, error: null });
      release.resolve();
    } finally { release.resolve(); await consumer.stop(); }
  }), 90_000);

  test('under lanes, laneFallback releases the live members as waiting and keeps the expired member\'s preparation_deadline', () => withBrain(async ({ engine, config, sources }) => {
    const run = randomUUID();
    const worktreeId = sources[0]!.binding.worktree_id;
    // A predecessor that is still queued makes laneFallback release the group so the predecessor runs first.
    const predecessor = await admitWrite(engine, admission(config, sources[1]!, 'lanes/predecessor', 'predecessor body'));
    await engine.executeRaw(`UPDATE persistence_requests SET worktree_id=NULL,source_id=$2,source_incarnation=$3::uuid WHERE id=$1::uuid`, [predecessor.id, 'group-deadline-other', sources[1]!.incarnation]);
    const rows = await admitGroup(engine, config, sources[0]!, 'lanes', 3, 'ordered', { lane: run, after: predecessor.request_id });
    openLanes(worktreeId, run, 2, null);
    const release = Promise.withResolvers<void>();
    const attempts = new Map<string, number>();
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, hangingPreparer(sources, new Set([rows[2]!.id]), release.promise, attempts),
      { hostId: config.hostId, concurrency: 1, pollMs: 50, renewalIntervalMs: 20, phaseMs: 2_000, preparationMs: 80,
        preparationBudgets: { maxAttempts: 5, ceilingMs: 60_000 }, onError: () => {} });
    try {
      // The predecessor stays queued on its own (database-only) root while the group is exercised.
      (consumer as unknown as { rootRetryAfter: Map<string, number> }).rootRetryAfter.set(`db:${sources[1]!.incarnation}`, Date.now() + 60_000);
      consumer.start();
      await waitFor(async () => (await getWriteRequestById(engine, rows[2]!.id))?.blocked_reason === 'preparation_deadline', { timeoutMs: 15_000 });
      await waitFor(async () => (await stateOf(engine, rows.slice(0, 2))).every(s => s.state === 'queued'), { timeoutMs: 15_000, label: 'laneFallback releases the live prefix' });
      const states = await stateOf(engine, rows);
      expect(states[0]).toEqual({ state: 'queued', reason: 'group_member_waiting', attempts: 0, error: null });
      expect(states[1]).toEqual({ state: 'queued', reason: 'group_member_waiting', attempts: 0, error: null });
      expect(states[2]).toEqual({ state: 'queued', reason: 'preparation_deadline', attempts: 1, error: null });
    } finally { release.resolve(); await consumer.stop(); await closeLaneRun(run, 1_000); }
  }), 90_000);

  test('the expired-claim sweep charges only the members whose dispatch was marked (the kill case)', () => withBrain(async ({ engine, config, sources }) => {
    const rows = await admitGroup(engine, config, sources[0]!, 'kill', 6, 'ordered');
    const release = Promise.withResolvers<void>();
    const attempts = new Map<string, number>();
    // Every dispatched member hangs: wave one (members 0-3) is marked preparing, members 4 and 5 are claimed but never dispatched.
    const owner = new PersistenceConsumer(engine, { engine: 'postgres' }, hangingPreparer(sources, new Set(rows.map(row => row.id)), release.promise, attempts),
      { hostId: config.hostId, concurrency: 1, pollMs: 60_000, renewalIntervalMs: 60_000, phaseMs: 2_000, preparationMs: 60_000,
        preparationBudgets: { maxAttempts: 5, ceilingMs: 120_000 }, onError: () => {} });
    const sweeper = new PersistenceConsumer(engine, { engine: 'postgres' }, async row => prepared(row as never, sources),
      { hostId: config.hostId, concurrency: 1, pollMs: 60_000, phaseMs: 2_000, onError: () => {} });
    try {
      owner.start();
      await waitFor(() => [0, 1, 2, 3].every(i => attempts.get(rows[i]!.id) === 1), { timeoutMs: 15_000, label: 'the first wave is dispatched' });
      const stamps = await engine.executeRaw<{ slug: string; phase: string | null; own: boolean }>(`SELECT slug,claim_phase->>'phase' AS phase,
        claim_phase->>'token'=execution_token::text AS own FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence`, [rows.map(row => row.id)]);
      expect(stamps.map(s => [s.phase, s.own])).toEqual([['preparing', true], ['preparing', true], ['preparing', true], ['preparing', true], [null, null], [null, null]]);
      // The owner dies (its renewals never run again); the leases lapse and another consumer's sweep reclaims them.
      await engine.executeRaw(`UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])`, [rows.map(row => row.id)]);
      (sweeper as unknown as { rootRetryAfter: Map<string, number> }).rootRetryAfter.set(rows[0]!.worktree_id!, Date.now() + 60_000);
      await sweeper.tick();
      const states = await stateOf(engine, rows);
      expect(states.map(s => [s.state, s.attempts])).toEqual([['queued', 1], ['queued', 1], ['queued', 1], ['queued', 1], ['queued', 0], ['queued', 0]]);
    } finally { release.resolve(); await owner.stop(); await sweeper.stop(); }
  }), 90_000);
});
