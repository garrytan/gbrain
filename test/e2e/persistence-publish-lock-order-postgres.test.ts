/**
 * Publication lock order against brain-row administration on Postgres.
 *
 * Every journal write (admission, recovery reservation, publication,
 * completion) writes `persistence_requests` or `persistence_effects`, whose
 * protocol triggers read the `persistence_brain` row FOR SHARE. Worktree
 * claims and source topology changes lock that row FOR UPDATE first, then
 * worktrees, sources and the persistence counters. A write that locked its
 * source or counters before the trigger's brain read inverts that order: the
 * topology change waits for the write's counters while the write waits for the
 * brain row. Each declared persistence transaction therefore takes the brain
 * row FOR SHARE first (protocol.ts `declareDurablePersistence`).
 *
 * The first case forces the interleaving: a real topology change pauses right
 * after its brain lock, an ordinary put_page runs until it blocks behind it,
 * then the topology change continues and must never wait on another session:
 * what queued behind it took the brain row before any other row. The second
 * case races ordinary writes against claims and topology changes while
 * sampling `pg_blocking_pids` for two sessions waiting on each other, and
 * requires no such cycle, no deadlock (40P01), and every write and change
 * committed, at the production 1 s `lock_timeout`. Lock timeouts (55P03) are
 * logged, not failed: a starved runner can hold a lock past 1 s without any
 * inversion, and the writer retries.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
const note = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${body}\n`;

interface Scope { label: 'topology' | 'writer'; onBrainLocked?: (pid: number) => Promise<void> }
const scope = new AsyncLocalStorage<Scope>();
const failures: Record<string, number> = {};
const proto = PostgresEngine.prototype as unknown as { executeRaw: (...args: unknown[]) => Promise<unknown> };
const original = proto.executeRaw;

beforeAll(() => {
  proto.executeRaw = async function (this: unknown, ...args: unknown[]) {
    const current = scope.getStore();
    try {
      const result = await original.apply(this, args);
      const hook = current?.onBrainLocked;
      if (hook && /FROM persistence_brain WHERE singleton=1 FOR UPDATE/.test(String(args[0]))) {
        current.onBrainLocked = undefined;
        const [{ pid }] = await original.call(this, 'SELECT pg_backend_pid() AS pid') as Array<{ pid: number }>;
        await hook(pid);
      }
      return result;
    } catch (error) {
      const code = String((error as { code?: string }).code);
      if (code === '40P01' || code === '55P03') {
        const key = `${current?.label ?? 'writer'}:${code}`;
        failures[key] = (failures[key] ?? 0) + 1;
      }
      throw error;
    }
  };
});
afterAll(() => { proto.executeRaw = original; });

function resetFailures(): void { for (const key of Object.keys(failures)) delete failures[key]; }

async function writer(engine: BrainEngine) {
  const registration = await registerLocalWriter(engine, 'cli');
  return async (slug: string, content: string) => {
    const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'put_page',
      { slug, content, request_id: randomUUID(), source_id: 'default' },
      { remote: false, config: { engine: 'postgres' }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } }));
    return { isError: response.isError === true, text: (response.content[0] as { text: string }).text };
  };
}

async function deadlocks(monitor: ReturnType<typeof postgres>, engine: BrainEngine): Promise<number> {
  const [{ name }] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
  const [row] = await monitor`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=${name}`;
  return Number(row?.n ?? 0);
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise(r => setTimeout(r, 20));
  }
  return undefined;
}

const settle = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }));

describeE2E('publication lock order vs brain-row administration (Postgres)', () => {
  let monitor: ReturnType<typeof postgres>;
  beforeAll(() => { monitor = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false }); });
  afterAll(async () => { await monitor.end(); });

  test('a write queued behind a paused topology change holds nothing the change needs, so the change never waits on it and both commit', () => managedBrain(async ({ engine, root }) => {
    resetFailures();
    const put = await writer(engine);
    expect((await put('notes/seed', note('Seed', 'seed'))).isError).toBe(false);
    const before = await deadlocks(monitor, engine);
    const rounds = 3;
    const outcomes: Array<{ topology: string; write: string; topologyWaitedOn: string[] }> = [];
    for (let round = 0; round < rounds; round++) {
      const probe = join(root, '..', `probe-${round}`); mkdirSync(probe);
      let resume!: () => void; const resumed = new Promise<void>(r => { resume = r; });
      let held!: (pid: number) => void; const brainHeld = new Promise<number>(r => { held = r; });
      const topology = settle(scope.run({ label: 'topology', onBrainLocked: async pid => { held(pid); await resumed; } },
        () => runManagedSourceLifecycle(engine, { operation: 'add', sourceId: `probe-${round}`, path: probe })));
      const pid = await brainHeld;
      const write = settle(scope.run({ label: 'writer' }, () => put(`notes/during-${round}`, note(`During ${round}`, `written during topology ${round}`))));
      await waitFor(async () => (await monitor`SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`).length ? true : undefined, 5000);
      // Let every statement the write reaches queue up behind the paused change, then watch what the change waits on.
      await new Promise(r => setTimeout(r, 300));
      resume();
      let done = false;
      const settled = Promise.all([topology, write]).finally(() => { done = true; });
      const blockers = new Set<string>();
      while (!done) {
        for (const row of await monitor`SELECT a.query FROM pg_stat_activity a WHERE a.pid = ANY(pg_blocking_pids(${pid}::int))`) {
          blockers.add(String(row.query).replace(/\s+/g, ' ').slice(0, 200));
        }
        await new Promise(r => setTimeout(r, 10));
      }
      const [t, w] = await settled;
      outcomes.push({
        topology: t.ok ? 'committed' : `${(t.error as { code?: string }).code ?? ''} ${t.error.message}`,
        write: w.ok ? (w.value.isError ? `error ${w.value.text.slice(0, 160)}` : 'committed') : `${w.error.message}`,
        topologyWaitedOn: [...blockers],
      });
    }
    const observed = { outcomes, deadlocks: await deadlocks(monitor, engine) - before, failures: { ...failures } };
    console.log('[lock-order paused topology]', JSON.stringify(observed));
    // Whatever queued behind the change holds nothing it needs: once resumed, it never waits on another session.
    expect(outcomes.flatMap(o => o.topologyWaitedOn)).toEqual([]);
    expect(Object.keys(observed.failures).filter(key => !key.startsWith('writer:55P03'))).toEqual([]);
    expect(observed.deadlocks).toBe(0);
    expect(outcomes.every(o => o.topology === 'committed' && o.write === 'committed')).toBe(true);
  }, { databaseUrl: process.env.DATABASE_URL }), 120_000);

  test('ordinary writes racing claims and topology changes never wait on each other in a cycle; every write and change commits', () => managedBrain(async ({ engine, root }) => {
    resetFailures();
    const put = await writer(engine);
    expect((await put('notes/seed', note('Seed', 'seed'))).isError).toBe(false);
    const before = await deadlocks(monitor, engine);
    const [{ name }] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    let stop = false; let sampling = true;
    // Two sessions each waiting on the other is the inversion itself; a 1 s lock_timeout on a starved runner is not.
    const cycles = new Set<string>();
    const sampler = (async () => {
      while (sampling) {
        const rows = await monitor`SELECT pid, pg_blocking_pids(pid) AS blockers, left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 120) AS query
          FROM pg_stat_activity WHERE datname=${name} AND cardinality(pg_blocking_pids(pid)) > 0`;
        const waits = new Map(rows.map(row => [Number(row.pid), { blockers: (row.blockers as number[]).map(Number), query: String(row.query) }]));
        for (const [pid, wait] of waits) for (const blocker of wait.blockers) {
          if (waits.get(blocker)?.blockers.includes(pid)) cycles.add([wait.query, waits.get(blocker)!.query].sort().join(' <-> '));
        }
        await new Promise(r => setTimeout(r, 20));
      }
    })();
    const topologyResults: string[] = [];
    const topology = (async () => {
      for (let i = 0; !stop && i < 12; i++) {
        const dir = join(root, '..', `race-${i}`); mkdirSync(dir);
        const steps: Array<() => Promise<unknown>> = [
          () => runManagedSourceLifecycle(engine, { operation: 'add', sourceId: `race-${i}` }),
          () => runManagedSourceLifecycle(engine, { operation: 'claim', sourceId: `race-${i}`, path: dir }),
          () => runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: `race-${i}` }),
        ];
        for (const step of steps) {
          const result = await settle(scope.run({ label: 'topology' }, step));
          topologyResults.push(result.ok ? 'committed' : String((result.error as { code?: string }).code ?? result.error.message));
        }
      }
    })();
    const writes: Array<Promise<{ isError: boolean; text: string }>> = [];
    for (let wave = 0; wave < 6; wave++) {
      const batch = Array.from({ length: 6 }, (_, i) => scope.run({ label: 'writer' }, () => put(`notes/race-${wave}-${i}`, note(`Race ${wave} ${i}`, `body ${wave} ${i}`))));
      writes.push(...batch);
      await Promise.all(batch);
    }
    stop = true;
    await topology;
    sampling = false;
    await sampler;
    const results = await Promise.all(writes);
    const observed = {
      writes: results.length, writeErrors: results.filter(r => r.isError).map(r => /"code": "([a-z_]+)"/.exec(r.text)?.[1] ?? r.text.slice(0, 160)),
      topology: topologyResults.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {}),
      deadlocks: await deadlocks(monitor, engine) - before, lockTimeouts: { ...failures }, cycles: [...cycles],
    };
    console.log('[lock-order race]', JSON.stringify(observed));
    expect(observed.cycles).toEqual([]);
    expect(observed.deadlocks).toBe(0);
    expect(observed.writeErrors).toEqual([]);
    expect(Object.keys(observed.topology)).toEqual(['committed']);
  }, { databaseUrl: process.env.DATABASE_URL }), 240_000);
});
