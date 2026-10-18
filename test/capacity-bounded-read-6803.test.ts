/**
 * #6803 C4: capacity reads with caller-bounded waits and an honest cache (both backends).
 *
 * - A status read or receipt that waits past its deadline gets `unknown› for that call only, while the
 *   /metrics reader on the same shared fetch still gets the snapshot, and the cache stays good.
 * - A fetch that timed out (a cancelled statement) is never cached: the next caller fetches again.
 * - A pause that continues across a caller timeout or a timed-out fetch emits no false clear and no
 *   second pause notice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __resetCapacityNoticesForTests, cachedCapacitySnapshot, CAPACITY_SNAPSHOT_TTL_MS, capacityNotices,
  capacitySnapshotWithin } from '../src/core/persistence/capacity-snapshot.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const setIds = (engine: BrainEngine, used: number) => engine.transaction(async tx => {
  await declarePersistenceProtocol(tx);
  await tx.executeRaw("UPDATE persistence_counters SET lifetime_ids=$1 WHERE key LIKE 'principal:%'", [used]);
});
const codes = (notices: Array<{ code: string }>) => notices.map(n => n.code);

/** The engine with the snapshot's counter read delayed by `delayMs›, or failing once as a cancelled statement. */
function controlled(engine: BrainEngine) {
  const state = { delayMs: 0, cancelNext: false, fetches: 0 };
  const proxy = new Proxy(engine, {
    get(target, key) {
      if (key === 'executeRaw') {
        return async (sql: string, params?: unknown[], opts?: unknown) => {
          if (/FROM persistence_counters/.test(sql)) {
            state.fetches++;
            if (state.cancelNext) {
              state.cancelNext = false;
              throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
            }
            if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
          }
          return target.executeRaw(sql, params, opts as never);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BrainEngine;
  return { engine: proxy, state };
}

for (const kind of testBackends()) {
  describe(`#6803 bounded capacity reads (${kind})`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-6803-capacity-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    beforeEach(() => __resetCapacityNoticesForTests());
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 120_000);

    check('a read that waits past its deadline is unknown for that call only; /metrics gets the snapshot and the cache stays good', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
      await setIds(engine, 900);
      const { engine: slow, state } = controlled(engine);
      state.delayMs = 800;
      const t0 = 4_000_000_000_000;
      const metrics = cachedCapacitySnapshot(slow, t0);
      const started = Date.now();
      const receipt = await capacitySnapshotWithin(slow, Date.now() + 100, t0 + 1);
      expect(receipt.status).toBe('unknown');
      expect(Date.now() - started).toBeLessThan(700);
      expect(await capacityNotices(slow, { throttle: true, now: t0 + 1, deadlineAt: Date.now() + 50 })).toEqual([]);
      const shared = await metrics;
      expect(shared.status).toBe('ok');
      expect(shared.low.map(row => row.resource)).toEqual(['lifetime_ids']);
      state.delayMs = 0;
      expect(await capacitySnapshotWithin(slow, Date.now() + 100, t0 + 2)).toBe(shared);
      expect(codes(await capacityNotices(slow, { throttle: true, now: t0 + 2, deadlineAt: Date.now() + 100 }))).toContain('write_capacity_low');
      expect(state.fetches).toBe(1);
    });

    check('a fetch that timed out is not cached: the next caller fetches again', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      const { engine: flaky, state } = controlled(engine);
      const t0 = 4_100_000_000_000;
      state.cancelNext = true;
      expect((await cachedCapacitySnapshot(flaky, t0)).status).toBe('unknown');
      expect((await cachedCapacitySnapshot(flaky, t0 + 1)).status).toBe('ok');
      expect(state.fetches).toBe(2);
    });

    check('a pause that continues across a caller timeout or a timed-out fetch is neither cleared nor announced again', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
      await engine.setConfig('persistence.capacity.warn_days', '0'); await engine.setConfig('persistence.capacity.fail_days', '0');
      await setIds(engine, 820);
      const { engine: slow, state } = controlled(engine);
      let now = 4_200_000_000_000;
      const step = () => (now += CAPACITY_SNAPSHOT_TTL_MS);
      expect(codes(await capacityNotices(slow, { throttle: false, now: step() }))).toEqual(['write_capacity_low', 'write_capacity_backpressure']);
      state.cancelNext = true;
      expect(await capacityNotices(slow, { throttle: false, now: step() })).toEqual([]);
      state.delayMs = 800;
      expect(await capacityNotices(slow, { throttle: false, now: step(), deadlineAt: Date.now() + 50 })).toEqual([]);
      state.delayMs = 0;
      expect(codes(await capacityNotices(slow, { throttle: false, now: step() }))).toEqual(['write_capacity_low']);
    });
  });
}
