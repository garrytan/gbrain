/**
 * #6696 (A4): pushed capacity warnings read a per-engine snapshot (at most
 * one light forecast a minute); `write_capacity_low` fires at 80% or under the
 * warn days, at most once an hour per process per scope on receipts and every
 * time unthrottled; the pause notice fires when a scope passes the background
 * pause line and again only after it clears. Both backends.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __resetCapacityNoticesForTests, cachedCapacitySnapshot, CAPACITY_NOTICE_INTERVAL_MS, CAPACITY_SNAPSHOT_TTL_MS,
  capacityNotices } from '../src/core/persistence/capacity-snapshot.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { renderCapacityMetrics } from '../src/commands/serve-http-metrics.ts';
import { NOTICE_CODES } from '../src/core/error-registry.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const setIds = (engine: BrainEngine, used: number) => engine.transaction(async tx => {
  await declarePersistenceProtocol(tx);
  await tx.executeRaw("UPDATE persistence_counters SET lifetime_ids=$1 WHERE key LIKE 'principal:%'", [used]);
});
const codes = (notices: Array<{ code: string }>) => notices.map(n => n.code);

test('the notice kinds follow the mute convention: low is muteable info, the pause is degraded', () => {
  expect(NOTICE_CODES.write_capacity_low.kind).toBe('info');
  expect(NOTICE_CODES.write_capacity_backpressure.kind).toBe('degraded');
});

for (const kind of testBackends()) {
  describe(`capacity notices ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-capacity-notices-'));
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

    check('a fresh brain carries no capacity notice', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      expect(await capacityNotices(engine, { throttle: false })).toEqual([]);
    });

    check('at 80% the receipt notice shows once an hour per scope; unthrottled outputs show it every time', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
      await engine.setConfig('persistence.capacity.background_pause_pct', '1');
      await setIds(engine, 810);
      const t0 = Date.now() + 100 * CAPACITY_SNAPSHOT_TTL_MS; // past any snapshot an earlier case left on a reused engine
      const first = await capacityNotices(engine, { throttle: true, now: t0 });
      expect(codes(first)).toEqual(['write_capacity_low']);
      expect(first[0]).toMatchObject({ kind: 'info', fix: { actor: 'host_admin', argv: ['gbrain', 'config', 'set', 'persistence.limits.principal_lifetime_ids', expect.stringMatching(/^\d+$/)] } });
      expect(first[0]!.why).toContain('81%');
      expect(await capacityNotices(engine, { throttle: true, now: t0 + 1000 })).toEqual([]);
      expect(codes(await capacityNotices(engine, { throttle: false, now: t0 + 1000 }))).toEqual(['write_capacity_low']);
      expect(codes(await capacityNotices(engine, { throttle: true, now: t0 + CAPACITY_NOTICE_INTERVAL_MS }))).toEqual(['write_capacity_low']);
    });

    check('the pause notice fires when the pause starts, and again only after it clears', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
      await engine.setConfig('persistence.capacity.warn_days', '0'); await engine.setConfig('persistence.capacity.fail_days', '0');
      let now = 2_000_000_000_000;
      const step = () => (now += CAPACITY_SNAPSHOT_TTL_MS);
      await setIds(engine, 500);
      expect(await capacityNotices(engine, { throttle: true, now: step() })).toEqual([]);
      await setIds(engine, 820);
      const started = await capacityNotices(engine, { throttle: true, now: step() });
      expect(codes(started)).toEqual(['write_capacity_low', 'write_capacity_backpressure']);
      expect(started[1]).toMatchObject({ kind: 'degraded' });
      expect(started[1]!.why).toContain('80% pause line');
      expect(codes(await capacityNotices(engine, { throttle: false, now: step() }))).toEqual(['write_capacity_low']);
      await setIds(engine, 500);
      expect(await capacityNotices(engine, { throttle: false, now: step() })).toEqual([]);
      await setIds(engine, 820);
      expect(codes(await capacityNotices(engine, { throttle: false, now: step() }))).toContain('write_capacity_backpressure');
    });

    check('a remote caller sees only the brain and its own principal, and a hidden scope is not marked shown', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
      await setIds(engine, 900);
      const now = 2_500_000_000_000; // between the cases around it, so neither reads the other's snapshot
      expect(await capacityNotices(engine, { throttle: true, now, scopes: ['brain', 'principal:oauth_client:other-example'] })).toEqual([]);
      const own = await capacityNotices(engine, { throttle: true, now });
      expect(codes(own)).toEqual(['write_capacity_low', 'write_capacity_backpressure']);
      expect(own[0]!.why).toMatch(/principal:local_cli:/);
    });

    check('writes within a minute share one snapshot; the next minute reads again', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
      const t0 = 3_000_000_000_000;
      const before = await cachedCapacitySnapshot(engine, t0);
      expect(before.low).toEqual([]);
      await setIds(engine, 900);
      expect(await cachedCapacitySnapshot(engine, t0 + CAPACITY_SNAPSHOT_TTL_MS - 1)).toBe(before);
      const after = await cachedCapacitySnapshot(engine, t0 + CAPACITY_SNAPSHOT_TTL_MS);
      expect(after.low.map(row => row.resource)).toEqual(['lifetime_ids']);
      const metrics = renderCapacityMetrics(after);
      expect(metrics).toContain('# TYPE gbrain_write_capacity_used gauge');
      expect(metrics).toMatch(/gbrain_write_capacity_used\{scope="principal:[^"]+",resource="lifetime_ids"\} 900/);
      expect(metrics).toMatch(/gbrain_write_capacity_limit\{scope="principal:[^"]+",resource="lifetime_ids"\} 1000/);
    });
  });
}
