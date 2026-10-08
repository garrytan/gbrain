/**
 * #6317 (B1, T1b unit half): the consumer mode machine in
 * `consumer-election.ts`, driven through its seams (the host's consumer rows,
 * the switch, the ceiling) with a stub full consumer, so every transition is
 * pinned without a database: probing settles to full when the switch is off
 * or no live owner exists, to waiter-only beside a live full resident owner
 * (the whole external surface answers inertly meanwhile); a waiter promotes
 * when its owner lapses 60 s, reports `restart_required`, carries a root
 * barrier past the ceiling or disappears, and stays put while the owner is
 * merely stale; only a promoted consumer drains back, after three healthy
 * ticks of a `full` owner, never for another promoted peer; `stop()` during
 * an unanswered probe returns and the late answer is dropped; the forced
 * own-consumer flag wins; a probe the database cannot answer falls back to a
 * full consumer with one log line; the heartbeat row carries the mode. The
 * Postgres half (real rows, a spawned `serve`) is
 * test/e2e/persistence-two-consumers-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { LANE_BUSY, type PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { DRAIN_BACK_HEALTHY_TICKS, electOwner, forceOwnConsumer, PROBE_TIMEOUT_MISSES, resetOwnConsumerForTest, WaiterOnlyConsumer } from '../src/core/persistence/consumer-election.ts';
import { CONSUMER_LAPSED_MS, CONSUMER_LIVE_MS, consumerIdentity, type ListedConsumer } from '../src/core/persistence/consumer-heartbeat.ts';

const CEILING = 600_000;

function fakeEngine(kind: 'postgres' | 'pglite' = 'postgres') {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const engine = { kind, executeRaw: async (sql: string, params: unknown[] = []) => { statements.push({ sql, params }); return []; },
    executeRawDirect: async (sql: string, params: unknown[] = []) => { statements.push({ sql, params }); return []; } } as unknown as BrainEngine;
  return { engine, statements, heartbeatModes: () => statements.filter(s => s.sql.includes('INSERT INTO persistence_consumers')).map(s => s.params[5]) };
}

function stubConsumer() {
  const calls: string[] = [];
  let stopped = false;
  const consumer = {
    start() { calls.push('start'); }, async stop() { calls.push('stop'); stopped = true; }, wake(own?: boolean) { calls.push(`wake:${own ?? false}`); },
    async tick() { calls.push('tick'); }, holds: () => false, foregroundCompletions: () => 0, async onLane() { return LANE_BUSY; },
    restartRequired: () => false, oldestRootBarrierAgeMs: () => null,
    status: () => ({ accepting: !stopped, active_preparations: 0, active_worktrees: 0, restart_required: false, from_inner: true }),
  };
  return { consumer: consumer as unknown as PersistenceConsumer, calls };
}

function row(over: Partial<ListedConsumer> = {}): ListedConsumer {
  return { host_id: 'h', pid: 4242, nonce: 'owner-nonce', pid_ns: null, kind: 'serve', mode: 'full', started_at: '2026-10-08T00:00:00Z', renewed_at: '2026-10-08T00:10:00Z',
    restart_required: false, root_barrier_age_ms: null, pool: null, host_json_path: '/owner/.gbrain/persistence/host.json', persistence_home: '/owner/.gbrain/persistence', minted_under: null,
    version: '0.60.200.0', renewed_age_ms: 1_000, age_ms: 600_000, liveness: 'live', self: false, ...over };
}

function harness(opts: { rows?: () => ListedConsumer[] | Promise<ListedConsumer[]>; switchOn?: boolean; kind?: string; engineKind?: 'postgres' | 'pglite' } = {}) {
  const fake = fakeEngine(opts.engineKind);
  const made: ReturnType<typeof stubConsumer>[] = [];
  const logs: string[] = [];
  const consumer = new WaiterOnlyConsumer(fake.engine, { engine: 'postgres' }, () => { const stub = stubConsumer(); made.push(stub); return stub.consumer; },
    { kind: opts.kind ?? 'jobs', hostId: 'h', pollMs: 1_000_000, idleMaxMs: 1_000_000, phaseMs: 200, readConsumers: async () => opts.rows ? opts.rows() : [],
      singleConsumer: async () => opts.switchOn ?? true, ceilingMs: async () => CEILING, heartbeatEveryMs: 1_000_000, log: line => logs.push(line) });
  return { consumer, made, logs, fake };
}

afterEach(() => resetOwnConsumerForTest());

describe('electOwner', () => {
  const self = consumerIdentity();
  test('a live full resident row that is not this process wins; put/cli rows, this process, wedged and stale rows do not', () => {
    expect(electOwner([row()], null, CEILING, self)?.pid).toBe(4242);
    expect(electOwner([row({ kind: 'put' })], null, CEILING, self)).toBeNull();
    expect(electOwner([row({ pid: self.pid, nonce: self.nonce })], null, CEILING, self)).toBeNull();
    expect(electOwner([row({ pid: self.pid, nonce: 'another-process-with-my-pid' })], null, CEILING, self)?.pid).toBe(self.pid);
    expect(electOwner([row({ restart_required: true })], null, CEILING, self)).toBeNull();
    expect(electOwner([row({ root_barrier_age_ms: CEILING })], null, CEILING, self)).toBeNull();
    expect(electOwner([row({ root_barrier_age_ms: CEILING - 1 })], null, CEILING, self)?.pid).toBe(4242);
    expect(electOwner([row({ renewed_age_ms: CONSUMER_LIVE_MS })], null, CEILING, self)).toBeNull();
    expect(electOwner([row({ mode: 'promoted', kind: 'sync' })], null, CEILING, self)?.kind).toBe('sync');
  });
  test('the current owner is kept while merely stale (under 60 s) and dropped once lapsed', () => {
    const current = { pid: 4242, nonce: 'owner-nonce' };
    expect(electOwner([row({ renewed_age_ms: 45_000 })], current, CEILING, self)?.pid).toBe(4242);
    expect(electOwner([row({ renewed_age_ms: CONSUMER_LAPSED_MS })], current, CEILING, self)).toBeNull();
    expect(electOwner([row({ renewed_age_ms: 45_000 }), row({ pid: 7, nonce: 'n7', kind: 'sync' })], null, CEILING, self)?.pid).toBe(7);
  });
});

describe('WaiterOnlyConsumer mode machine', () => {
  test('switch off: full on the first tick without reading the rows; the heartbeat row says full', async () => {
    let reads = 0;
    const h = harness({ switchOn: false, rows: () => { reads++; return [row()]; } });
    h.consumer.start();
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('full');
    expect(reads).toBe(0);
    expect(h.made).toHaveLength(1);
    expect(h.made[0]!.calls).toEqual(['start']);
    expect(h.fake.heartbeatModes()).toEqual(['full']);
    await h.consumer.stop();
    expect(h.made[0]!.calls).toContain('stop');
  });
  test('PGLite: full at start, no probe, no heartbeat statement', async () => {
    const h = harness({ engineKind: 'pglite', rows: () => { throw new Error('never read'); } });
    h.consumer.start();
    expect(h.consumer.mode).toBe('full');
    await h.consumer.stop();
    expect(h.fake.statements).toEqual([]);
  });
  test('no live owner: full after the probe; a put-kind row beside it is not an owner', async () => {
    const h = harness({ rows: () => [row({ kind: 'put', pid: 9 }), row({ renewed_age_ms: CONSUMER_LIVE_MS + 1 })] });
    h.consumer.start();
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('full');
    await h.consumer.stop();
  });
  test('a live full serve: waiter-only with the consumer surface answering inertly and the owner in status', async () => {
    const h = harness({ rows: () => [row()] });
    h.consumer.start();
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('waiter_only');
    expect(h.made).toHaveLength(0);
    expect(h.consumer.holds('x')).toBe(false);
    expect(h.consumer.foregroundCompletions('w')).toBe(0);
    expect(await h.consumer.onLane(async () => 'ran')).toBe(LANE_BUSY);
    expect(h.consumer.restartRequired()).toBe(false);
    h.consumer.wake(true);
    expect(h.made).toHaveLength(0);
    const status = h.consumer.status();
    expect(status).toMatchObject({ accepting: true, active_preparations: 0, active_worktrees: 0, consumer_election: { mode: 'waiter_only', kind: 'jobs', owner: { kind: 'serve', pid: 4242, nonce: 'owner-nonce' } } });
    expect(h.consumer.electedOwner()?.pid).toBe(4242);
    expect(h.fake.heartbeatModes()).toEqual([]);
    expect(h.logs.some(line => line.includes('reason=waiter_only') && line.includes('pid 4242'))).toBe(true);
    await h.consumer.stop();
    expect(h.made).toHaveLength(0);
  });
  for (const [label, lapsedRows] of [
    ['lapsed 60 s', () => [row({ renewed_age_ms: CONSUMER_LAPSED_MS })]],
    ['restart_required while its heartbeat is live', () => [row({ restart_required: true })]],
    ['a root barrier past the ceiling while its heartbeat is live', () => [row({ root_barrier_age_ms: CEILING + 1 })]],
    ['gone', () => []],
    ['no longer full', () => [row({ mode: 'waiter_only' })]],
  ] as const) {
    test(`a waiter promotes on its next tick when the owner is ${label}; the heartbeat row says promoted`, async () => {
      let rows: ListedConsumer[] = [row()];
      const h = harness({ rows: () => rows });
      h.consumer.start();
      await h.consumer.probeTick();
      expect(h.consumer.mode).toBe('waiter_only');
      rows = lapsedRows();
      await h.consumer.probeTick();
      expect(h.consumer.mode).toBe('promoted');
      expect(h.made).toHaveLength(1);
      expect(h.made[0]!.calls).toEqual(['start']);
      expect(h.fake.heartbeatModes()).toEqual(['promoted']);
      expect(h.logs.some(line => line.includes('owner_lapsed promoted_to_consumer'))).toBe(true);
      await h.consumer.stop();
    });
  }
  test('a stale owner (30-60 s) keeps its waiter; a live replacement owner is adopted without a promotion', async () => {
    let rows: ListedConsumer[] = [row()];
    const h = harness({ rows: () => rows });
    h.consumer.start();
    await h.consumer.probeTick();
    rows = [row({ renewed_age_ms: 45_000 })];
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('waiter_only');
    rows = [row({ renewed_age_ms: 45_000 }), row({ pid: 7, nonce: 'n7', kind: 'mcp' })];
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('waiter_only');
    rows = [row({ pid: 7, nonce: 'n7', kind: 'mcp' })];
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('waiter_only');
    expect(h.consumer.electedOwner()?.pid).toBe(7);
    expect(h.made).toHaveLength(0);
    await h.consumer.stop();
  });
  test('a promoted consumer drains back after three healthy ticks of a full owner, then defers again; a promoted peer never drains it back', async () => {
    let rows: ListedConsumer[] = [row()];
    const h = harness({ rows: () => rows });
    h.consumer.start();
    await h.consumer.probeTick();
    rows = [];
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('promoted');
    // Another waiter that promoted at the same time is not an elected owner: both stay promoted (doctor names the overlap).
    rows = [row({ mode: 'promoted', kind: 'sync', pid: 8, nonce: 'n8' })];
    for (let i = 0; i < DRAIN_BACK_HEALTHY_TICKS + 1; i++) await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('promoted');
    expect(h.made[0]!.calls).not.toContain('stop');
    // The elected owner recovers: two healthy ticks are not enough, the third drains back; in-flight work finishes through stop().
    rows = [row()];
    await h.consumer.probeTick(); await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('promoted');
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('waiter_only');
    expect(h.made[0]!.calls).toContain('stop');
    expect(h.consumer.electedOwner()?.pid).toBe(4242);
    // A heartbeat outage resets the count: healthy, unhealthy, healthy ticks do not add up.
    rows = [];
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('promoted');
    expect(h.made).toHaveLength(2);
    rows = [row()]; await h.consumer.probeTick(); await h.consumer.probeTick();
    rows = [row({ renewed_age_ms: CONSUMER_LAPSED_MS })]; await h.consumer.probeTick();
    rows = [row()]; await h.consumer.probeTick(); await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('promoted');
    await h.consumer.probeTick();
    expect(h.consumer.mode).toBe('waiter_only');
    await h.consumer.stop();
    expect(h.fake.heartbeatModes()).toEqual(['promoted', 'promoted']);
    expect(h.fake.statements.filter(s => s.sql.startsWith('DELETE FROM persistence_consumers'))).toHaveLength(2);
  });
  test('stop() during an unanswered probe returns cleanly and the late answer is dropped', async () => {
    const pending = Promise.withResolvers<ListedConsumer[]>();
    const h = harness({ rows: () => pending.promise });
    h.consumer.start();
    const tick = h.consumer.probeTick();
    const stopped = h.consumer.stop();
    pending.resolve([]);
    await tick;
    await stopped;
    expect(h.consumer.mode).toBe('probing');
    expect(h.made).toHaveLength(0);
    expect(h.fake.statements).toEqual([]);
  });
  test('the forced own-consumer flag: full at start, and a waiter already made promotes to full (never drains back)', async () => {
    let rows: ListedConsumer[] = [row()];
    const waiter = harness({ rows: () => rows });
    waiter.consumer.start();
    await waiter.consumer.probeTick();
    expect(waiter.consumer.mode).toBe('waiter_only');
    forceOwnConsumer('no_delegate');
    await waiter.consumer.probeTick();
    expect(waiter.consumer.mode).toBe('full');
    for (let i = 0; i < DRAIN_BACK_HEALTHY_TICKS + 1; i++) await waiter.consumer.probeTick();
    expect(waiter.consumer.mode).toBe('full');
    expect(waiter.made[0]!.calls).not.toContain('stop');
    await waiter.consumer.stop();
    const forced = harness({ rows: () => [row()] });
    forced.consumer.start();
    expect(forced.consumer.mode).toBe('full');
    await forced.consumer.stop();
  });
  test('promote() turns a waiter into a full consumer in place', async () => {
    const h = harness({ rows: () => [row()] });
    h.consumer.start();
    await h.consumer.probeTick();
    await h.consumer.promote('skew_fallback');
    expect(h.consumer.mode).toBe('full');
    expect(h.made).toHaveLength(1);
    await h.consumer.stop();
  });
  test('a probe the database cannot answer: full with one log line; a probe that times out stays probing until the third miss', async () => {
    const failing = harness({ rows: () => { throw new Error('relation "persistence_consumers" does not exist'); } });
    failing.consumer.start();
    await failing.consumer.probeTick();
    expect(failing.consumer.mode).toBe('full');
    expect(failing.logs.filter(line => line.includes('reason=probe_failed'))).toHaveLength(1);
    await failing.consumer.stop();
    const slow = harness({ rows: () => new Promise<ListedConsumer[]>(() => {}) });
    slow.consumer.start();
    for (let i = 1; i < PROBE_TIMEOUT_MISSES; i++) { await slow.consumer.probeTick(); expect(slow.consumer.mode).toBe('probing'); }
    await slow.consumer.probeTick();
    expect(slow.consumer.mode).toBe('full');
    expect(slow.logs.filter(line => line.includes('reason=probe_timeout'))).toHaveLength(1);
    await slow.consumer.stop();
  });
  test('tick() forwards to the full consumer once one exists', async () => {
    const h = harness({ switchOn: false });
    h.consumer.start();
    await h.consumer.tick();
    await h.consumer.tick(true);
    expect(h.made[0]!.calls).toEqual(['start', 'tick']);
    h.consumer.wake(true);
    expect(h.made[0]!.calls).toContain('wake:true');
    expect(h.consumer.status()).toMatchObject({ from_inner: true, consumer_election: { mode: 'full' } });
    await h.consumer.stop();
  });
});
