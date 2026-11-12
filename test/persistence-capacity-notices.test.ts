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
import { renderNotice } from '../src/core/agent-output.ts';
import { readCapacityForecast } from '../src/core/persistence/capacity-forecast.ts';
import { oneYearCapacity, recommendedLimit } from '../src/core/persistence/limits.ts';
import { editRequest, freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
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
      // GST-2107: the notice rides a write that succeeded, so its last lines name a read-only check, never a cap raise for the user.
      expect(first[0]).toMatchObject({ kind: 'info', fix: { actor: 'agent', argv: ['gbrain', 'doctor', '--only', 'persistence_capacity', '--json'] } });
      expect(first[0]!.why).toContain('81%');
      expect(first[0]!.why).toContain('This notice is not a refusal');
      expect(first[0]!.why).not.toContain('config set');
      // A remote agent reads the rendered notice: over MCP its fix is the read-scope get_brain_health call, never a step to relay.
      for (const transport of ['http', 'stdio'] as const) {
        const fix = renderNotice(first[0]!, { transport, isCallable: tool => tool === 'get_brain_health', preapproved: () => true }).fix;
        expect(fix).toMatchObject({ actor: 'agent', next: 'run', mcp: { tool: 'get_brain_health' } });
      }
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

    check('the one-year value follows the 7-day mean, not a burst in the last day (GST-2107)', async engine => {
      const fixture = await requestFixture(engine);
      const ids: string[] = [];
      for (let i = 0; i < 71; i++) ids.push((await fixture.admit(`burst-${i}`)).id);
      // One admission before the window (so it spans a full 7 days), 42 spread over the six days before the last one and 28 in
      // the last hour: a mean of 10 a day, 28 in the last day.
      const ageDays = (i: number) => i === 0 ? 10 : 6.5 - Math.floor((i - 1) / 7);
      for (let i = 0; i < 43; i++) await editRequest(engine, ids[i]!, "created_at=now()-($2::double precision*interval '1 day')", [ageDays(i)]);
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '100');
      await engine.setConfig('persistence.limits.principal_terminal_bytes', '1');
      const forecast = await readCapacityForecast(engine);
      const row = (resource: string) => forecast.rows.find(r => r.scope.startsWith('principal:') && r.resource === resource)!;
      expect(row('lifetime_ids').per_day_7d).toBe(28);
      expect(row('lifetime_ids').recommended_limit).toBe(71 + 10 * 365);
      const [{ gross }] = await engine.executeRaw<{ gross: string }>('SELECT SUM(terminal_reservation)::text AS gross FROM persistence_requests');
      const used = row('terminal_bytes').used;
      const ceiling = recommendedLimit('terminal_bytes', used, 1, { perDay: Number(gross) / 7, netPerDay: Number(gross) / 7 }, forecast.retention_days);
      expect(row('terminal_bytes').recommended_limit).toBeLessThanOrEqual(ceiling);
    });

    check('after a burst the admission refusal names the same one-year value as doctor (GST-2107)', async engine => {
      await engine.setConfig('persistence.limits.principal_outstanding', '5000');
      await engine.setConfig('persistence.limits.brain_outstanding', '5000');
      const fixture = await requestFixture(engine);
      const ids: string[] = [];
      for (let i = 0; i < 1101; i++) ids.push((await fixture.admit(`dense-${i}`)).id);
      // One admission before the window, 100 over the week before the last day, then 1,000 in the last hour: the latest
      // 1,000 admissions are all burst, while the 7-day mean is 1,100 / 7 a day.
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '10 days' WHERE id=$1::uuid", [ids[0]]);
        await tx.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '2 days' WHERE id=ANY($1::uuid[])", [ids.slice(1, 101)]);
      });
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1101');
      await engine.setConfig('persistence.limits.principal_terminal_bytes', String(16 * 1024 ** 3));
      // The forecast a receipt, doctor or /metrics read in the last minute records the rates the refusal uses under its locks.
      const forecast = await readCapacityForecast(engine);
      const refusal = await fixture.admit('one-more').then(() => null, (error: { code?: string; fix?: { argv?: string[] } }) => error);
      expect(refusal).toMatchObject({ code: 'write_quota_exhausted', reason: 'lifetime_ids' });
      const doctor = forecast.rows.find(r => r.scope.startsWith('principal:') && r.resource === 'lifetime_ids')!;
      expect(doctor.recommended_limit).toBe(Math.ceil(1101 + (1100 / 7) * 365));
      expect(Number(refusal!.fix!.argv!.at(-1))).toBe(doctor.recommended_limit);
      const principal = forecast.rows.find(r => r.scope.startsWith('principal:'))!.scope;
      const terminal = forecast.rows.find(r => r.scope === principal && r.resource === 'terminal_bytes')!;
      expect(await oneYearCapacity(engine, principal, 'TerminalBytes', terminal.used, terminal.limit)).toBe(terminal.recommended_limit);
    });

    check('the one-year value counts the week\'s lifecycle changes, as doctor does (GST-2107)', async engine => {
      const fixture = await requestFixture(engine);
      for (let i = 0; i < 14; i++) await fixture.admit(`week-${i}`);
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`INSERT INTO persistence_topology_changes(principal_id,request_id,digest,operation,source_id,state,terminal_bytes)
          SELECT gen_random_uuid(),gen_random_uuid(),'d','source_add','source-a','committed',2048 FROM generate_series(1,56)`);
      });
      await engine.setConfig('persistence.limits.brain_lifetime_ids', '10');
      await engine.setConfig('persistence.limits.brain_terminal_bytes', '1');
      const forecast = await readCapacityForecast(engine);
      for (const [resource, setting] of [['lifetime_ids', 'LifetimeIds'], ['terminal_bytes', 'TerminalBytes']] as const) {
        const doctor = forecast.rows.find(r => r.scope === 'brain' && r.resource === resource)!;
        expect(await oneYearCapacity(engine, 'brain', setting, doctor.used, doctor.limit)).toBe(doctor.recommended_limit);
      }
    });

    check('a refusal under the counter locks reads at most the latest 1,000 admissions, and none after a forecast recorded the rates', async engine => {
      const fixture = await requestFixture(engine);
      for (let i = 0; i < 3; i++) await fixture.admit(`rate-${i}`);
      await engine.setConfig('persistence.limits.brain_lifetime_ids', '10');
      const reads: string[] = [];
      const counted = { ...engine, executeRaw: (sql: string, params?: unknown[]) => {
        if (/FROM persistence_requests/.test(sql)) reads.push(sql);
        return engine.executeRaw(sql, params);
      } } as unknown as BrainEngine;
      await oneYearCapacity(counted, 'brain', 'LifetimeIds', 3, 10);
      expect(reads.some(sql => sql.includes('LIMIT 1000'))).toBe(true);
      expect(reads.some(sql => /LIMIT (?!1\b|1000\b)\d+/.test(sql))).toBe(false);
      const doctor = (await readCapacityForecast(counted)).rows.find(r => r.scope === 'brain' && r.resource === 'lifetime_ids')!;
      reads.length = 0;
      expect(await oneYearCapacity(counted, 'brain', 'LifetimeIds', doctor.used, doctor.limit)).toBe(doctor.recommended_limit);
      expect(reads.some(sql => sql.includes('LIMIT 1000'))).toBe(false);
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
