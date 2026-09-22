import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { resetConsumerPollMsWarning, resolveConsumerPollMs } from '../src/core/persistence/service.ts';
import { admitWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { acquireWorktree } from '../src/core/persistence/ownership.ts';
import { admission, assertCommittedSnapshot, assertConservation, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

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

// GBRAIN_PERSISTENCE_POLL_MS — idle-poll interval override
//
// doTick issues several queries per tick, so the 250ms default is a standing
// query cost a resident serve pays even with an empty queue. An operator on a
// metered Postgres must be able to widen the interval without patching source.
// The rejection cases are the point of the guard, not padding: a lenient parse
// of "60s" yields 60ms — BUSIER than the default and the exact inverse of the
// operator's intent — a value past the 32-bit timer range wraps to 1ms in Bun,
// and a near-infinite one turns consumer.ts's `pollMs * 2` recovery backoff
// into Infinity, stranding a root in the retry-exclusion map. The ceiling also
// stays under waitForWrite's 5000ms budget, because nothing wakes the consumer
// on admission: a longer interval would fail synchronous writes outright
// rather than merely delay them. Everything outside the window must leave the
// built-in default untouched.
test('resolveConsumerPollMs accepts only whole milliseconds inside the supported window', async () => {
  await withEnv({ GBRAIN_PERSISTENCE_POLL_MS: undefined }, () => {
    expect(resolveConsumerPollMs()).toBeUndefined();
  });

  for (const [value, expected] of [['50', 50], ['1500', 1_500], ['3000', 3_000], [' 2000 ', 2_000]] as const) {
    await withEnv({ GBRAIN_PERSISTENCE_POLL_MS: value }, () => {
      expect(resolveConsumerPollMs()).toBe(expected);
    });
  }

  const rejected = [
    '49',                 // below the floor
    '0', '-1', '',        // nonsense
    'not-a-number',
    '60s',                // "60 seconds" must NOT become a 60ms poll
    '30000garbage',       // trailing garbage is not a number
    '1500.5',             // fractional is not a whole millisecond
    '3001',               // just past the ceiling
    '30000',              // over waitForWrite's budget: would fail writes, not slow them
    '2147483648',         // 32-bit timer overflow: Bun clamps this to 1ms
    '1'.padEnd(309, '9'), // poisons the `pollMs * 2` recovery backoff to Infinity
  ];
  for (const value of rejected) {
    resetConsumerPollMsWarning();
    await withEnv({ GBRAIN_PERSISTENCE_POLL_MS: value }, () => {
      expect(resolveConsumerPollMs()).toBeUndefined();
    });
  }
  resetConsumerPollMsWarning();
});
