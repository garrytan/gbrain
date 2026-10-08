import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ABANDONED_STOP_GRACE_MS, PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { PreparationDeadlineError } from '../src/core/persistence/bounded-reads.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { admitWrite, getWriteRequestById, WRITE_PROGRESS_SQL } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { acquireWorktree } from '../src/core/persistence/ownership.ts';
import { admission, assertCommittedSnapshot, assertConservation, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { awaitWrite, disposePersistenceConsumer, registerMutationPreparer, startPersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-consumer-scheduling-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 5105, schedules: 0, operations: 0,
  sourceIds: ['consumer-scheduling', 'consumer-scheduling-other'], principalIds: [randomUUID()],
};
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let engine: PGLiteEngine;

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('simultaneous bounded waiters retain one unresolved receipt read until settlement', async () => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  let reads = 0;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === WRITE_PROGRESS_SQL) { reads++; return release.promise; }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const row = { id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest;
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => waitForWrite(proxy, row, { engine: 'pglite' }, 100)));
    expect(results.every(value => value === row)).toBe(true);
    expect(reads).toBe(1);
    await waitForWrite(proxy, row, { engine: 'pglite' }, 100);
    expect(reads).toBe(1);
  } finally {
    release.resolve([]);
    await disposePersistenceConsumer(proxy);
  }
}), 5000);

test('shutdown drains an uncancellable receipt read without scheduling another', async () => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  let reads = 0, stopped = false;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === WRITE_PROGRESS_SQL) { reads++; return release.promise; }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const row = { id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest;
  const waiter = waitForWrite(proxy, row, { engine: 'pglite' }, 500);
  try {
    await waitFor(() => reads === 1);
    const stopping = disposePersistenceConsumer(proxy).then(() => { stopped = true; });
    await Bun.sleep(30);
    expect(stopped).toBe(false);
    release.resolve([]);
    await stopping;
    await waiter;
    expect(reads).toBe(1);
  } finally { release.resolve([]); await waiter; await disposePersistenceConsumer(proxy); }
}), 5000);

test.each(['queued', 'committed'] as const)('coalesced receipt reads preserve each result while the first waiter is %s', firstState => withEnv(env, async () => {
  const rows = Array.from({ length: 2 }, () => ({ id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest));
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === WRITE_PROGRESS_SQL) {
        await Bun.sleep(20);
        return [{ ...rows.find(row => row.id === params?.[0]), state: params?.[0] === rows[0].id ? firstState : 'committed' }];
      }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  try {
    const results = await Promise.all(rows.map(row => waitForWrite(proxy, row, { engine: 'pglite' }, 1000)));
    expect(results.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(results.map(row => row.state)).toEqual([firstState, 'committed']);
  } finally { await disposePersistenceConsumer(proxy); }
}), 5000);

test('a stalled receipt read does not hide another request that already committed', async () => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  const rows = Array.from({ length: 2 }, () => ({ id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest));
  let entered = false;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === WRITE_PROGRESS_SQL) {
        if (params?.[0] === rows[0].id) { entered = true; return release.promise; }
        return [{ ...rows[1], state: 'committed' }];
      }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const stalled = waitForWrite(proxy, rows[0], { engine: 'pglite' }, 1000);
  try {
    await waitFor(() => entered);
    const found = await waitForWrite(proxy, rows[1], { engine: 'pglite' }, 250);
    expect(found.id).toBe(rows[1].id);
    expect(found.state).toBe('committed');
  } finally { release.resolve([]); await disposePersistenceConsumer(proxy); await stalled; }
}), 5000);

test.each([false, true])('a shorter receipt waiter cannot abort another caller\'s read (same ID=%s)', sameId => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  const row = { id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest;
  const other = sameId ? row : { ...row, id: randomUUID(), request_id: randomUUID() };
  let ownerSignal: AbortSignal | undefined;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'kind') return 'postgres';
    if (key === 'executeRaw') return async (...args: Parameters<typeof engine.executeRaw>) => {
      if (args[0] === WRITE_PROGRESS_SQL) {
        if (args[1]?.[0] === row.id) ownerSignal = args[2]?.signal;
        return release.promise;
      }
      return target.executeRaw(...args);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'postgres' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const owner = waitForWrite(proxy, row, { engine: 'postgres' }, 1000);
  try {
    await waitFor(() => ownerSignal !== undefined);
    expect(await waitForWrite(proxy, other, { engine: 'postgres' }, 100)).toBe(other);
    expect(ownerSignal!.aborted).toBe(false);
  } finally { release.resolve([]); await disposePersistenceConsumer(proxy); await owner; }
}), 5000);

test('distinct stalled receipt reads stay capped and shutdown drains every retained read', async () => withEnv(env, async () => {
  const releases = Array.from({ length: 4 }, () => Promise.withResolvers<never[]>());
  let reads = 0, stopped = false;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === WRITE_PROGRESS_SQL) {
        const release = releases[reads++];
        expect(release).toBeDefined();
        return release.promise;
      }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const rows = Array.from({ length: 20 }, () => ({ id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest));
  try {
    expect(await Promise.all(rows.map(row => waitForWrite(proxy, row, { engine: 'pglite' }, 100)))).toEqual(rows);
    expect(reads).toBe(4);
    await waitForWrite(proxy, rows.at(-1)!, { engine: 'pglite' }, 100);
    expect(reads).toBe(4);
    const stopping = disposePersistenceConsumer(proxy).then(() => { stopped = true; });
    for (const release of releases.slice(0, -1)) release.resolve([]);
    await Bun.sleep(30);
    expect(stopped).toBe(false);
    releases.at(-1)!.resolve([]);
    await stopping;
    expect(stopped).toBe(true);
    expect(reads).toBe(4);
  } finally { for (const release of releases) release.resolve([]); await disposePersistenceConsumer(proxy); }
}), 5000);

// #6278: this pair pins the pre-deadline behaviour (a preparer that ignores its signal stays `running` past the budget) and
// runs verbatim with the `preparation_deadlines` switch off; the switch-on variants follow it.
for (const cooperates of [true, false]) test(`preparation deadline retains tracking and fences late results (cooperative=${cooperates})`, async () => withEnv({ ...env, GBRAIN_PREPARATION_DEADLINES: '0' }, async () => {
  resetWriteSwitches();
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], `deadline-${cooperates}`, 'deadline body'));
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  let aborted = false;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current, _c, signal?: AbortSignal) => {
    attempts++;
    signal?.addEventListener('abort', () => { aborted = true; if (cooperates) release.resolve(); }, { once: true });
    await release.promise;
    if (cooperates) signal?.throwIfAborted();
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60_000, preparationMs: 50 });
  try {
    consumer.start();
    await waitFor(() => attempts === 1);
    await Bun.sleep(150);
    expect(aborted).toBe(true);
    expect(attempts).toBe(1);
    if (!cooperates) {
      expect(consumer.status().active_preparations).toBe(1);
      expect((await getWriteRequestById(engine, row.id))?.state).toBe('running');
    }
    release.resolve();
    await waitFor(() => consumer.status().active_preparations === 0);
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
    await assertConservation(engine);
  } finally {
    release.resolve();
    await consumer.stop();
    resetWriteSwitches();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 5000);

/**
 * #6278, switch on: the budget releases the claim whether or not the preparer honours its signal. The non-cooperative
 * preparer's request is back in the queue at the budget with `preparation_deadline` and one counted attempt while the
 * abandoned preparation still runs (the #5373 root barrier holds, so the root is not claimed again until it settles);
 * its late result never publishes and the counters conserve.
 */
for (const cooperates of [true, false]) test(`preparation deadline releases the claim at the budget and counts the attempt (cooperative=${cooperates}, #6278)`, async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], `deadline-switch-on-${cooperates}`, 'deadline body'));
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  let aborted = false;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current, _c, signal?: AbortSignal) => {
    attempts++;
    signal?.addEventListener('abort', () => { aborted = true; if (cooperates) release.resolve(); }, { once: true });
    await release.promise;
    if (cooperates) signal?.throwIfAborted();
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60_000, preparationMs: 50, preparationBudgets: { maxAttempts: 5, ceilingMs: 60_000 } });
  try {
    consumer.start();
    await waitFor(() => attempts === 1);
    await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'queued', { timeoutMs: 2_000, label: 'the budget releases the claim' });
    expect(aborted).toBe(true);
    expect(attempts).toBe(1);
    const released = await getWriteRequestById(engine, row.id);
    expect(released).toMatchObject({ state: 'queued', blocked_reason: 'preparation_deadline', preparation_attempts: 1 });
    if (!cooperates) {
      // The preparer still runs: the slot is free, the root is still blocked by it, nothing is re-claimed meanwhile.
      await Bun.sleep(150);
      expect(consumer.status()).toMatchObject({ active_preparations: 0, abandoned_preparations: 1, restart_required: false, outlived_ceiling: [] });
      expect(attempts).toBe(1);
      expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    }
    release.resolve();
    await waitFor(() => consumer.status().abandoned_preparations === 0);
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
    await assertConservation(engine);
  } finally {
    release.resolve();
    await consumer.stop();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 5000);

test('an abandoned preparation past the hard ceiling frees its root, pins the counter at the limit and the next claim fails preparation_stalled (#6278)', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const stuck = await admitWrite(engine, admission(config, sources[0], 'ceiling/stuck', 'stuck body'));
  const behind = await admitWrite(engine, admission(config, sources[0], 'ceiling/behind', 'behind body'));
  const never = Promise.withResolvers<ReturnType<typeof prepared>>();
  const attempts: string[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current) => {
    attempts.push(current.id);
    return current.id === stuck.id ? never.promise : prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 20, preparationMs: 30, preparationBudgets: { maxAttempts: 3, ceilingMs: 200 }, onError: () => {} });
  try {
    consumer.start();
    await waitFor(async () => (await getWriteRequestById(engine, stuck.id))?.blocked_reason === 'preparation_deadline', { timeoutMs: 2_000 });
    // Until the ceiling the root waits on the zombie: the write behind it is not claimed.
    expect((await getWriteRequestById(engine, behind.id))?.state).toBe('queued');
    expect(attempts).toEqual([stuck.id]);
    await waitFor(() => consumer.status().restart_required, { timeoutMs: 2_000, label: 'the ceiling passes and the zombie is isolated' });
    expect(consumer.status().outlived_ceiling).toEqual([expect.objectContaining({ request_id: stuck.request_id, operation: 'put_page', step: null, waiting_on: 'unknown' })]);
    await waitFor(async () => (await getWriteRequestById(engine, stuck.id))?.preparation_attempts === 3, { timeoutMs: 2_000, label: 'the overrun pins the counter at the limit' });
    // At the zombie cap this process claims nothing more; a process that still claims it finishes it without preparing again.
    await Bun.sleep(100);
    expect(attempts).toEqual([stuck.id]);
    const fresh = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current) => { attempts.push(current.id); return prepared(current, sources); },
      { hostId: config.hostId, pollMs: 20, preparationBudgets: { maxAttempts: 3 }, onError: () => {} });
    try {
      fresh.start();
      await waitFor(async () => (await getWriteRequestById(engine, stuck.id))?.state === 'failed', { timeoutMs: 3_000, label: 'the next claim fails it preparation_stalled' });
      const failed = (await getWriteRequestById(engine, stuck.id))!;
      expect(failed).toMatchObject({ state: 'failed', error_code: 'preparation_stalled', preparation_attempts: 3 });
      expect(failed.error_message).toContain('persistence.max_preparation_attempts (3)');
      expect(failed.error_detail).toMatchObject({ origin: 'preparation_stall', attempts: 3, limit: 3, stage: 'preparation' });
      await waitFor(async () => (await getWriteRequestById(engine, behind.id))?.state === 'committed', { timeoutMs: 3_000, label: 'the root moves on' });
      expect(attempts.filter(id => id === stuck.id)).toHaveLength(1);
    } finally { await fresh.stop(); }
    never.resolve(prepared(stuck, sources));
    await waitFor(() => consumer.status().outlived_ceiling.length === 0);
    expect(await engine.readPageSnapshot(stuck.slug, { sourceId: stuck.source_id })).toBeNull();
    await assertConservation(engine);
  } finally {
    never.resolve(prepared(stuck, sources));
    await consumer.stop();
    for (const row of [stuck, behind]) await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id).catch(() => {});
  }
}), 15_000);

test('the release that brings the counter to the limit finishes the request failed/preparation_stalled, and a waiting put_page caller receives it (#6278)', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'limit/foreground', 'poisoned body'));
  let attempts = 0;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, _current, _c, signal?: AbortSignal) => {
    attempts++;
    // Honours cancellation but never finishes inside its budget: the reporter's cooperative shape.
    return new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { hostId: config.hostId, pollMs: 20, preparationMs: 30, preparationBudgets: { maxAttempts: 2 }, onError: () => {} });
  try {
    consumer.start();
    const waited = await awaitWrite(engine, row, { engine: 'pglite' }, { waitMs: 5_000 });
    expect(waited.kind).toBe('terminal');
    expect(waited.row).toMatchObject({ state: 'failed', error_code: 'preparation_stalled', preparation_attempts: 2 });
    expect(attempts).toBe(2);
    expect(waited.row.error_message).toContain('submit the write again with a new request_id');
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
    await assertConservation(engine);
  } finally { await disposePersistenceConsumer(engine); await consumer.stop(); }
}), 10_000);

/**
 * #6278 (plan item 1.4): a bounded read the server ended inside the budget (a session `lock_timeout` shorter than the budget)
 * reports the deadline itself. Protects: the consumer handles it as the deadline, never as the preparer's own failure: the
 * claim is released `preparation_deadline` and charged, the release that reaches the limit finishes the request
 * `failed`/`preparation_stalled`, and no `storage_error` receipt is written. Fails when the catch path releases it uncharged
 * (`consumer_stopping`) or writes a terminal receipt from the raw error.
 */
test('a server-reported deadline inside the budget is a charged preparation_deadline release, then preparation_stalled at the limit (#6278)', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'server-deadline/foreground', 'bounded body'));
  let attempts = 0;
  const second = Promise.withResolvers<void>();
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, _current, _c, _signal, clock) => {
    if (++attempts === 2) await second.promise;
    if (clock) clock.step = 'origin_check';
    throw new PreparationDeadlineError('origin_check', '55P03', Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
  }, { hostId: config.hostId, pollMs: 20, preparationMs: 5_000, preparationBudgets: { maxAttempts: 2 }, onError: () => {} });
  try {
    consumer.start();
    // The first attempt's release was charged (inside the budget, so only the error could have reported the deadline).
    await waitFor(() => attempts === 2, { timeoutMs: 3_000 });
    expect(await getWriteRequestById(engine, row.id)).toMatchObject({ state: 'running', preparation_attempts: 1 });
    second.resolve();
    const waited = await awaitWrite(engine, row, { engine: 'pglite' }, { waitMs: 5_000 });
    expect(waited.kind).toBe('terminal');
    expect(waited.row).toMatchObject({ state: 'failed', error_code: 'preparation_stalled', preparation_attempts: 2 });
    expect(waited.row.error_message).toContain('step origin_check');
    expect(attempts).toBe(2);
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
    await assertConservation(engine);
  } finally { second.resolve(); await disposePersistenceConsumer(engine); await consumer.stop(); }
}), 10_000);

test('a stopping consumer gives abandoned preparations a bounded grace instead of waiting forever (#6278)', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'stop/abandoned', 'abandoned body'));
  const never = Promise.withResolvers<ReturnType<typeof prepared>>();
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => never.promise,
    { hostId: config.hostId, pollMs: 60_000, preparationMs: 30, preparationBudgets: { maxAttempts: 5, ceilingMs: 60_000 } });
  try {
    consumer.start();
    await waitFor(async () => (await getWriteRequestById(engine, row.id))?.blocked_reason === 'preparation_deadline', { timeoutMs: 2_000 });
    expect(consumer.status().abandoned_preparations).toBe(1);
    const started = performance.now();
    await consumer.stop();
    expect(performance.now() - started).toBeLessThan(ABANDONED_STOP_GRACE_MS + 2_000);
    expect(performance.now() - started).toBeGreaterThanOrEqual(ABANDONED_STOP_GRACE_MS - 50);
    never.resolve(prepared(row, sources));
    await Bun.sleep(50);
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
  } finally {
    never.resolve(prepared(row, sources));
    await consumer.stop();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id).catch(() => {});
  }
}), 15_000);

test('an edit_page preparation shares the preparation deadline (#5616)', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'edit-page-deadline', 'edited body', 0, { operation: 'edit_page' }));
  const release = Promise.withResolvers<void>();
  let aborted = false;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current, _c, signal?: AbortSignal) => {
    signal?.addEventListener('abort', () => { aborted = true; release.resolve(); }, { once: true });
    await release.promise;
    signal?.throwIfAborted();
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60_000, preparationMs: 50 });
  try {
    consumer.start();
    await waitFor(() => aborted);
    await waitFor(() => consumer.status().active_preparations === 0);
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
  } finally {
    release.resolve();
    await consumer.stop();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 5000);

test('publication entering before the preparation deadline keeps its protected terminal outcome', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'publication-wins', 'protected body'));
  let entered = false;
  const release = Promise.withResolvers<void>();
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current) => {
    const mutation = prepared(current, sources);
    return { ...mutation, apply: async tx => { entered = true; await release.promise; return mutation.apply(tx); } };
  }, { hostId: config.hostId, pollMs: 60_000, preparationMs: 50 });
  try {
    consumer.start();
    await waitFor(() => entered);
    await Bun.sleep(100);
    release.resolve();
    await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed');
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
    await assertConservation(engine);
  } finally { release.resolve(); await consumer.stop(); }
}), 5000);

test.each([false, true])('a synchronous late preparation cannot outrun its delayed abort timer (reject=%s)', reject => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], `synchronous-deadline-${reject}`, 'unpublished body'));
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current) => {
    const until = performance.now() + 60;
    while (performance.now() < until) {}
    if (reject) throw new DOMException('Synthetic late abort', 'AbortError');
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60000, preparationMs: 20 });
  try {
    await consumer.tick();
    await waitFor(() => consumer.status().active_preparations === 0);
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
  } finally { await consumer.stop(); await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id); }
}), 5000);

test('shutdown does not finish while an abort-ignoring preparer remains active', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'stop-ignoring-abort', 'unpublished body'));
  const release = Promise.withResolvers<void>();
  let aborted = false, entered = false, stopped = false;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current, _cfg, signal) => {
    entered = true;
    signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    await release.promise;
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60_000 });
  try {
    consumer.start(); await waitFor(() => entered);
    const stop = consumer.stop().then(() => { stopped = true; });
    await Bun.sleep(50);
    expect(aborted).toBe(true); expect(stopped).toBe(false);
    expect(consumer.status().active_preparations).toBe(1);
    release.resolve(); await stop;
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
  } finally { release.resolve(); await consumer.stop(); await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id); }
}), 5000);

test('an immediate wake-up during an active tick is retained until that tick finishes', async () => {
  const release = Promise.withResolvers<void>();
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { throw new Error('No writes in scheduler probe'); },
    { hostId: config.hostId, pollMs: 60_000 });
  const scheduler = consumer as unknown as { doTick(): Promise<void>; schedule(ms: number): void };
  let ticks = 0;
  scheduler.doTick = async () => { if (++ticks === 1) await release.promise; };
  try {
    const active = consumer.tick();
    scheduler.schedule(0);
    await Bun.sleep(25);
    expect(ticks).toBe(1);
    release.resolve();
    await active;
    await waitFor(() => ticks === 2, { timeoutMs: 5_000 });
  } finally {
    release.resolve();
    await consumer.stop();
  }
});

test('process-local diagnostic errors never retain arbitrary driver codes or messages', async () => {
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { throw new Error('No preparation'); },
    { hostId: config.hostId, onError: () => {} });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {
    throw Object.assign(new Error('PRIVATE_DRIVER_MESSAGE'), { code: 'PRIVATE_DRIVER_CODE' });
  };
  try {
    await consumer.tick();
    expect(consumer.status().last_error?.code).toBe('storage_error');
    expect(JSON.stringify(consumer.status())).not.toContain('PRIVATE_');
  } finally { await consumer.stop(); }
});

test('an uncancellable PGLite scheduler phase stays observed and awaited through stop', async () => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  let entered = false, stopped = false;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (...args: Parameters<typeof engine.executeRaw>) => {
      if (String(args[0]).startsWith('SELECT brain_id,enabled,to_jsonb(persistence_brain)')) {
        expect(args[2]?.signal).toBeUndefined();
        entered = true; return release.promise;
      }
      return target.executeRaw(...args);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = new PersistenceConsumer(proxy, { engine: 'pglite' }, async () => { throw new Error('No late preparation'); },
    { hostId: config.hostId, phaseMs: 20 });
  try {
    const tick = consumer.tick();
    await waitFor(() => entered && consumer.status().phase?.deadline_exceeded === true);
    expect(consumer.status().phase?.name).toBe('refresh_roots');
    const stopping = consumer.stop().then(() => { stopped = true; });
    await Bun.sleep(40);
    expect(stopped).toBe(false);
    expect(consumer.status().phase?.deadline_exceeded).toBe(true);
    release.resolve([]); await tick; await stopping;
    expect(consumer.status().phase).toBeNull();
  } finally { release.resolve([]); await consumer.stop(); }
}), 5000);

for (const outcome of ['committed', 'failed'] as const) test(`a ${outcome} write preempts idle polling and drains the next FIFO request`, async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const first = await admitWrite(engine, admission(config, sources[0], `first-${outcome}`, 'first body'));
  const second = await admitWrite(engine, admission(config, sources[0], `second-${outcome}`, 'second body'));
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, row) => {
    started.push(row.id);
    if (row.id === first.id) {
      await release.promise;
      if (outcome === 'failed') throw new Error('Permanent fixture failure');
    }
    return prepared(row, sources);
  }, { hostId: config.hostId, concurrency: 1, pollMs: 60_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(() => started.length === 1);
    await consumer.tick();
    expect(started).toEqual([first.id]);
    release.resolve();
    await waitFor(async () => (await getWriteRequestById(engine, second.id))?.state === 'committed',
      { timeoutMs: 5_000, label: 'completion wake-up must not wait for the idle poll' });
    expect(started).toEqual([first.id, second.id]);
    const terminal = (await getWriteRequestById(engine, first.id))!;
    expect(terminal.state).toBe(outcome);
    if (outcome === 'committed') await assertCommittedSnapshot(engine, terminal);
    else expect(await engine.readPageSnapshot(first.slug, { sourceId: config.sourceIds[0] })).toBeNull();
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, second.id))!);
    await assertConservation(engine);
    expect(errors).toEqual([]);
  } finally {
    release.resolve();
    await consumer.stop();
    for (const row of [first, second]) await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

test('stopping while preparation is active does not schedule another queued write', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const first = await admitWrite(engine, admission(config, sources[0], 'stop-first', 'first body'));
  const second = await admitWrite(engine, admission(config, sources[0], 'stop-second', 'second body'));
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, row) => {
    started.push(row.id);
    await release.promise;
    return prepared(row, sources);
  }, { hostId: config.hostId, concurrency: 1, pollMs: 60_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(() => started.length === 1);
    await consumer.tick();
    const stopped = consumer.stop();
    release.resolve();
    await stopped;
    await consumer.tick();
    expect(started).toEqual([first.id]);
    expect((await getWriteRequestById(engine, first.id))?.state).toBe('queued');
    expect((await getWriteRequestById(engine, second.id))?.state).toBe('queued');
    expect(consumer.status()).toMatchObject({ accepting: false, active_preparations: 0 });
    expect(errors).toEqual([]);
    await assertConservation(engine);
  } finally {
    release.resolve();
    await consumer.stop();
    for (const row of [first, second]) await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

for (const reason of ['locked root', 'retryable preparation'] as const) test(`${reason} keeps idle backoff instead of spinning on immediate wake-ups`, async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'blocked', 'blocked body'));
  const lock = reason === 'locked root' ? await acquireWorktree(sources[0].binding) : undefined;
  if (reason === 'locked root') expect(lock).not.toBeNull();
  let attempts = 0;
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, current) => {
    attempts++;
    if (reason === 'retryable preparation') throw Object.assign(new Error('Retryable fixture failure'), { code: '40001' });
    return prepared(current, sources);
  }, { hostId: config.hostId, concurrency: 1, pollMs: 60_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(() => attempts > 0 && consumer.status().active_preparations === 0);
    await Bun.sleep(100);
    expect(attempts).toBe(1);
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    expect(errors).toEqual([]);
  } finally {
    await consumer.stop();
    await lock?.release();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

for (const reason of ['locked root', 'retryable preparation'] as const) test(`healthy completions preserve ${reason} backoff on another root`, async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const suffix = reason.replaceAll(' ', '-');
  const blocked = await admitWrite(engine, admission(config, sources[0], `mixed-blocked-${suffix}`, 'blocked body'));
  const healthy = await Promise.all(Array.from({ length: 3 }, (_, i) =>
    admitWrite(engine, admission(config, sources[1], `mixed-healthy-${suffix}-${i}`, `healthy body ${i}`))));
  const lock = reason === 'locked root' ? await acquireWorktree(sources[0].binding) : undefined;
  if (reason === 'locked root') expect(lock).not.toBeNull();
  let attempts = 0;
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, row) => {
    if (row.id === blocked.id) {
      attempts++;
      if (reason === 'retryable preparation') throw Object.assign(new Error('Retryable fixture failure'), { code: '40001' });
    }
    return prepared(row, sources);
  }, { hostId: config.hostId, concurrency: 2, pollMs: 60_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(async () => (await Promise.all(healthy.map(row => getWriteRequestById(engine, row.id))))
      .every(row => row?.state === 'committed'), { timeoutMs: 5_000 });
    await waitFor(() => consumer.status().active_preparations === 0);
    expect(attempts).toBe(1);
    expect((await getWriteRequestById(engine, blocked.id))?.state).toBe('queued');
    for (const row of healthy) await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
    await assertConservation(engine);
    expect(errors).toEqual([]);
  } finally {
    await consumer.stop();
    await lock?.release();
    for (const row of [blocked, ...healthy]) await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

test('a retryable root becomes eligible again after its backoff expires', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'retry-expiry', 'retry body'));
  const attempts: number[] = [];
  const errors: unknown[] = [];
  const pollMs = 200;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, current) => {
    attempts.push(Date.now());
    if (attempts.length === 1) throw Object.assign(new Error('Retryable fixture failure'), { code: '40001' });
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 5_000 });
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(pollMs);
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
    await assertConservation(engine);
    expect(errors).toEqual([]);
  } finally {
    await consumer.stop();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

// #5373: claim loss during preparation. The renewal statement is the one renewWriteClaim sends.
const RENEWAL_SQL_MARK = 'claim_expires_at=now()+';
function interceptRenewals(onRenewal: (id: string, token: string) => Promise<unknown> | undefined): () => void {
  const direct = engine.executeRawDirect.bind(engine);
  (engine as unknown as { executeRawDirect: unknown }).executeRawDirect = (sql: string, params?: unknown[]) =>
    (sql.includes(RENEWAL_SQL_MARK) ? onRenewal(String(params?.[0]), String(params?.[1])) : undefined) ?? direct(sql, params);
  return () => { (engine as unknown as { executeRawDirect: unknown }).executeRawDirect = direct; };
}
const pageBody = async (slug: string, sourceId: string) => (await engine.readPageSnapshot(slug, { sourceId }))?.page.compiled_truth ?? null;

test('a renewal stuck past its deadline frees the slot, keeps the root until the abandoned preparation ends, then retries cleanly', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const stuck = await admitWrite(engine, admission(config, sources[0], 'claim-lease/stuck', 'fresh body'));
  const elsewhere = await admitWrite(engine, admission(config, sources[1], 'claim-lease/elsewhere', 'elsewhere body'));
  const firstAttempt = Promise.withResolvers<ReturnType<typeof prepared>>();
  const hungRenewal = Promise.withResolvers<never[]>();
  const attempts: string[] = [];
  let firstToken: string | undefined;
  const restore = interceptRenewals((_id, token) => token === firstToken ? hungRenewal.promise : undefined);
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, row) => {
    attempts.push(row.id);
    if (row.id !== stuck.id) return prepared(row, sources);
    if (firstToken) return prepared(row, sources);
    firstToken = row.execution_token!;
    return firstAttempt.promise;
  }, { hostId: config.hostId, concurrency: 1, pollMs: 20, renewalIntervalMs: 5, phaseMs: 40, onError: () => {} });
  try {
    consumer.start();
    await waitFor(() => firstToken !== undefined, { timeoutMs: 5_000 });
    await waitFor(async () => (await getWriteRequestById(engine, stuck.id))?.state === 'queued',
      { timeoutMs: 5_000, label: 'the stuck renewal loses the claim and the request goes back to the queue' });
    expect((await getWriteRequestById(engine, stuck.id))?.blocked_reason).toBe('claim_lost');
    expect(consumer.holds(stuck.id)).toBe(false);
    await waitFor(async () => (await getWriteRequestById(engine, elsewhere.id))?.state === 'committed',
      { timeoutMs: 5_000, label: 'the freed slot serves another root' });
    await Bun.sleep(200);
    expect(attempts.filter(id => id === stuck.id)).toHaveLength(1);
    expect((await getWriteRequestById(engine, stuck.id))?.state).toBe('queued');

    firstAttempt.resolve(prepared({ ...stuck, intent: { ...stuck.intent, content: 'stale body' } }, sources));
    await waitFor(async () => (await getWriteRequestById(engine, stuck.id))?.state === 'committed',
      { timeoutMs: 5_000, label: 'the root is released and the request is retried' });
    expect(attempts.filter(id => id === stuck.id)).toHaveLength(2);
    expect(await pageBody('claim-lease/stuck', sources[0].id)).toBe('fresh body');

    let stopped = false;
    const stopping = consumer.stop().then(() => { stopped = true; });
    await Bun.sleep(60);
    expect(stopped).toBe(false);
    hungRenewal.resolve([]);
    await stopping;
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, stuck.id))!);
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, elsewhere.id))!);
    await assertConservation(engine);
  } finally {
    firstAttempt.resolve(prepared(stuck, sources));
    hungRenewal.resolve([]);
    await consumer.stop();
    restore();
    for (const row of [stuck, elsewhere]) await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id).catch(() => {});
  }
}), 20_000);

test('a claim another consumer took over is left alone, and the abandoned preparation never publishes', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'claim-lease/taken', 'our body'));
  const ours = Promise.withResolvers<ReturnType<typeof prepared>>();
  let preparing = false;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { preparing = true; return ours.promise; },
    { hostId: config.hostId, concurrency: 1, pollMs: 60_000, renewalIntervalMs: 5, phaseMs: 1_000, onError: () => {} });
  const takeover = randomUUID();
  try {
    consumer.start();
    await waitFor(() => preparing, { timeoutMs: 5_000 });
    await engine.executeRaw(`UPDATE persistence_requests SET execution_token=$2::uuid WHERE id=$1::uuid`, [row.id, takeover]);
    await waitFor(() => !consumer.holds(row.id) && consumer.status().active_preparations === 0,
      { timeoutMs: 5_000, label: 'the renewal sees the takeover and the consumer lets go' });
    const after = await getWriteRequestById(engine, row.id);
    expect([after?.state, after?.execution_token]).toEqual(['running', takeover]);

    ours.resolve(prepared(row, sources));
    await Bun.sleep(100);
    expect(await pageBody('claim-lease/taken', sources[0].id)).toBeNull();
    const theirs = await publishMutation(engine, after!, prepared({ ...after!, intent: { ...after!.intent, content: 'their body' } }, sources), config.hostId);
    expect(theirs.state).toBe('committed');
    await consumer.stop();
    expect(await pageBody('claim-lease/taken', sources[0].id)).toBe('their body');
  } finally {
    ours.resolve(prepared(row, sources));
    await consumer.stop();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id).catch(() => {});
  }
}), 20_000);

test('healthy renewals during a long preparation keep the claim: one attempt, committed, no claim loss', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'claim-lease/healthy', 'healthy body'));
  const renewed: string[] = [];
  const restore = interceptRenewals(id => { renewed.push(id); return undefined; });
  let attempts = 0;
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, current) => {
    attempts++;
    await Bun.sleep(120);
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60_000, renewalIntervalMs: 10, phaseMs: 2_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 5_000 });
    expect(attempts).toBe(1);
    expect(renewed.filter(id => id === row.id).length).toBeGreaterThanOrEqual(3);
    expect((await getWriteRequestById(engine, row.id))?.blocked_reason ?? null).not.toBe('claim_lost');
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
    await assertConservation(engine);
    expect(errors).toEqual([]);
  } finally {
    await consumer.stop();
    restore();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id).catch(() => {});
  }
}), 20_000);

test('a local waiter wakes an idle owner for a claim-only tick instead of waiting for the next poll', async () => withEnv(env, async () => {
  const ticks: boolean[] = [];
  const consumer = startPersistenceConsumer(engine, { engine: 'pglite' });
  const internals = consumer as unknown as { opts: { pollMs?: number }; doTick(afterProgress: boolean): Promise<void> };
  internals.opts.pollMs = 60_000;
  internals.doTick = async afterProgress => { ticks.push(afterProgress); };
  const row = { id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest;
  try {
    await waitFor(() => ticks.length === 1);
    await Bun.sleep(20);
    const waiter = waitForWrite(engine, row, { engine: 'pglite' }, 200);
    await waitFor(() => ticks.length === 2, { timeoutMs: 1000 });
    expect(ticks[1]).toBe(true);
    await waiter;
  } finally { await disposePersistenceConsumer(engine); }
}), 5000);

/** #5984 (CEO-A7, DX-A3): classified waits with an in-process completion handoff. */
function countingProxy(target: PGLiteEngine, onRead?: (sql: string, params?: unknown[]) => unknown) {
  const counts = { progress: 0, full: 0 };
  const proxy = new Proxy(target, { get(base, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: unknown) => {
      if (sql === WRITE_PROGRESS_SQL) counts.progress++;
      // Only the waiter's own reads count; publication itself reads its receipt (clearResolvedRecovery).
      if (sql === 'SELECT * FROM persistence_requests WHERE id=$1::uuid' && new Error().stack?.includes('awaitWrite')) counts.full++;
      const replaced = onRead?.(sql, params);
      if (replaced !== undefined) return replaced;
      return base.executeRaw(sql, params as unknown[], opts as never);
    };
    const value = Reflect.get(base, key);
    return typeof value === 'function' ? value.bind(base) : value;
  } });
  return { proxy, counts };
}

test('a write this process publishes resolves from the consumer handoff with zero request reads', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  registerMutationPreparer('test_wait_handoff', async (_e, row) => { await Bun.sleep(400); return prepared(row, sources); });
  const { proxy, counts } = countingProxy(engine);
  startPersistenceConsumer(proxy, { engine: 'pglite' });
  try {
    await Bun.sleep(300);
    const row = await admitWrite(engine, admission(config, sources[0], 'wait-handoff', 'handoff body', 0, { operation: 'test_wait_handoff' }));
    const before = { ...counts };
    const started = performance.now();
    const waited = await awaitWrite(proxy, row, { engine: 'pglite' }, { waitMs: 10_000 });
    expect(performance.now() - started).toBeGreaterThan(300);
    expect(waited.kind).toBe('terminal');
    expect(waited.row).toEqual((await getWriteRequestById(engine, row.id))!);
    expect(waited.row.state).toBe('committed');
    expect(counts).toEqual(before);
  } finally { await disposePersistenceConsumer(proxy); }
}), 15_000);

test('a write another consumer publishes resolves through progress polling with the full terminal row', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'wait-cross-process', 'cross body'));
  const { proxy, counts } = countingProxy(engine);
  const local = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (local as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const other = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current) => prepared(current, sources), { hostId: config.hostId });
  try {
    const waiting = awaitWrite(proxy, row, { engine: 'pglite' }, { waitMs: 10_000 });
    other.start();
    const waited = await waiting;
    expect(waited.kind).toBe('terminal');
    expect(waited.row).toEqual((await getWriteRequestById(engine, row.id))!);
    expect(waited.row.intent).toEqual(row.intent);
    expect(counts.progress).toBeGreaterThan(0);
    expect(counts.full).toBe(1);
  } finally { await other.stop(); await disposePersistenceConsumer(proxy); }
}), 15_000);

test('an authentication failure during a wait is classified, not reported as still pending', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'wait-auth-failure', 'auth body'));
  const { proxy, counts } = countingProxy(engine, sql => {
    if (sql === WRITE_PROGRESS_SQL) throw Object.assign(new Error('password authentication failed for user "example"'), { code: '28P01' });
  });
  (startPersistenceConsumer(proxy, { engine: 'pglite' }) as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  try {
    const started = performance.now();
    const waited = await awaitWrite(proxy, row, { engine: 'pglite' }, { waitMs: 5000 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(waited).toMatchObject({ kind: 'read_failed', request_id: row.request_id, reason: 'auth_failed', transient: false, attempts: 1 });
    expect(counts.progress).toBe(1);
  } finally {
    await disposePersistenceConsumer(proxy);
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 10_000);

test('repeated connection resets during a wait are classified with their attempt count', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'wait-connection-reset', 'reset body'));
  const { proxy, counts } = countingProxy(engine, sql => {
    if (sql === WRITE_PROGRESS_SQL) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  });
  (startPersistenceConsumer(proxy, { engine: 'pglite' }) as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  try {
    const waited = await awaitWrite(proxy, row, { engine: 'pglite' }, { waitMs: 1200 });
    expect(waited).toMatchObject({ kind: 'read_failed', request_id: row.request_id, reason: 'conn_dropped', transient: true });
    expect(waited.kind === 'read_failed' && waited.attempts).toBe(counts.progress);
    expect(counts.progress).toBeGreaterThan(2);
    expect(waited.row.state).toBe('queued');
  } finally {
    await disposePersistenceConsumer(proxy);
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 10_000);

test('a recovery-blocked pending head is classified as blocked with its request ID and inspection command', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'wait-recovery-blocked', 'blocked body'));
  await engine.executeRaw("UPDATE persistence_requests SET blocked_reason='recovery_required' WHERE id=$1::uuid", [row.id]);
  (startPersistenceConsumer(engine, { engine: 'pglite' }) as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  try {
    const waited = await awaitWrite(engine, row, { engine: 'pglite' }, { waitMs: 600 });
    expect(waited).toMatchObject({ kind: 'blocked', request_id: row.request_id, cause: 'recovery_required',
      command: `gbrain sources writer status ${sources[0].id} --json` });
    expect(await waitForWrite(engine, row, { engine: 'pglite' }, 100)).toMatchObject({ id: row.id, state: 'queued', blocked_reason: 'recovery_required' });
  } finally {
    await disposePersistenceConsumer(engine);
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 10_000);
