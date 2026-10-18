/**
 * #6696 (A3): the capacity check reads days-to-exhaustion from a full 7-day
 * aggregate, so a cap at 76% that the current rate fills within 30 days
 * warns (it read ok at the old 80% line); a burst followed by idle days still
 * counts and is flagged; a history younger than 7 days divides by its age.
 * Both backends.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkPersistenceCapacity } from '../src/commands/doctor/checks/persistence-capacity.ts';
import { readCapacityForecast } from '../src/core/persistence/capacity-forecast.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
/** 70 admissions (plus one 8 days old unless `history` is false), in time order, the i-th newest created `ageDays(i)` days ago, against a principal id cap of 1,000 with 760 already used. */
async function seed(engine: BrainEngine, ageDays: (i: number) => number, history = true) {
  const requests = await requestFixture(engine);
  const ids: string[] = [];
  const ages: number[] = [];
  // An admission older than the window, so the history spans the full seven days.
  if (history) { ids.push((await requests.admit('old')).id); ages.push(8); }
  for (let i = 0; i < 70; i++) { ids.push((await requests.admit(`p${i}`)).id); ages.push(ageDays(69 - i)); }
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`UPDATE persistence_requests r SET created_at=now()-(t.age*interval '1 day') FROM unnest($1::uuid[],$2::float8[]) AS t(id,age) WHERE r.id=t.id`,
      [ids, ages]);
    await tx.executeRaw("UPDATE persistence_counters SET lifetime_ids=760 WHERE key LIKE 'principal:%'");
  });
  await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
}
const principalIds = async (engine: BrainEngine) => (await readCapacityForecast(engine)).rows.find(r => r.scope.startsWith('principal:') && r.resource === 'lifetime_ids')!;

for (const kind of testBackends()) {
  describe(`capacity forecast ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-forecast-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 120_000);

    check('76% used at a 10/day burn warns with days to exhaustion and the one-year command', async engine => {
      await seed(engine, i => i * 0.1 + 0.05);
      const row = await principalIds(engine);
      expect(row).toMatchObject({ used: 760, limit: 1000, pct: 76, status: 'warn', spike_day: null });
      expect(row.per_day_7d).toBe(10);
      expect(row.days_to_exhaustion).toBe(24);
      expect(row.basis).toBe('aggregate_7d');
      const doctor = await checkPersistenceCapacity(engine);
      expect(doctor.status).toBe('warn');
      expect(doctor.message).toContain('about 24 day(s) left at the 7-day rate');
      expect((doctor.details as { commands: string[] }).commands).toEqual([`gbrain config set persistence.limits.principal_lifetime_ids ${760 + 10 * 365}`]);
      expect(doctor.fix).toMatchObject({ argv: ['gbrain', 'config', 'set', 'persistence.limits.principal_lifetime_ids', String(760 + 10 * 365)], actor: 'host_admin' });
    });

    check('a burst followed by idle days still counts toward the rate and is flagged as a spike', async engine => {
      await seed(engine, i => i === 0 ? 6.9 : 3 + i * 0.0001);
      const row = await principalIds(engine);
      expect(row.spike_day).not.toBeNull();
      expect(row.per_day_7d).toBe(10);
      expect(row.status).toBe('warn');
    });

    check('a history younger than seven days divides by its age, not by seven', async engine => {
      await seed(engine, i => i * 0.0285, false);
      const row = await principalIds(engine);
      expect(row.window_days).toBeCloseTo(1.97, 1);
      expect(row.basis).toStartWith('aggregate_1.9');
      expect(row.basis).toEndWith('d_short_history');
      expect(row.status).toBe('fail');
      expect((await checkPersistenceCapacity(engine)).status).toBe('fail');
    });

    check('a history over 10,000 rows with an early burst is counted in full', async engine => {
      const requests = await requestFixture(engine);
      const template = await requests.admit('template');
      const columns = (await engine.executeRaw<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
        WHERE table_name='persistence_requests' AND table_schema=current_schema() AND column_name NOT IN ('id','sequence','request_id','client_request_id','created_at')`)).map(c => c.column_name);
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        // The template is the oldest row (eight days), so the history spans the full window.
        await tx.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '8 days' WHERE id=$1::uuid", [template.id]);
        // 10,000 admissions six days ago (a bulk catch-up), then 499 more spread over the last day.
        for (const [count, age] of [[10_000, '6 days'], [499, '12 hours']] as const) {
          await tx.executeRaw(`INSERT INTO persistence_requests(${columns.join(',')},request_id,created_at)
            SELECT ${columns.map(c => `t.${c}`).join(',')},gen_random_uuid(),now()-interval '${age}'
            FROM persistence_requests t, generate_series(1,$2) WHERE t.id=$1::uuid`, [template.id, count]);
        }
      });
      const row = await principalIds(engine);
      expect(row.per_day_7d).toBe(Math.round(10_499 / 7));
      expect(row.max_day_7d).toBeGreaterThanOrEqual(10_000);
      expect(row.spike_day).not.toBeNull();
    });

    check('receipts admitted before reservations counted their intent are reported in basis', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('legacy');
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_requests SET state='failed',completed_at=now(),intent=jsonb_build_object('body',repeat('x',100000)) WHERE id=$1::uuid`, [admitted.id]);
      });
      const bytes = (await readCapacityForecast(engine)).rows.find(r => r.scope.startsWith('principal:') && r.resource === 'terminal_bytes')!;
      expect(bytes.under_reserved_receipts).toBe(1);
      expect(bytes.basis).toContain(':legacy_under_reserved');
      const light = (await readCapacityForecast(engine, { light: true })).rows.find(r => r.scope.startsWith('principal:') && r.resource === 'terminal_bytes')!;
      expect(light.reclaimable_bytes).toBeUndefined();
    });

    check('a quiet brain far from its caps is ok', async engine => {
      await requestFixture(engine).then(r => r.admit('one'));
      expect((await checkPersistenceCapacity(engine)).status).toBe('ok');
    });
  });
}
