import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PERSISTENCE_SYNC_RUN_INDEXES, PERSISTENCE_SCHEMA_STATEMENTS } from '../src/core/persistence/schema.ts';
import { readRequestIndexStates } from '../src/core/persistence/checkpoint-validation.ts';
import { requestGrowthCheck, requestIndexesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { runRepair, resolveRepairScope, REPAIR_KINDS } from '../src/core/repair/core.ts';
import { repairForCheck } from '../src/core/repair/registry.ts';
import { requestIndexesRepair } from '../src/core/repair/request-indexes.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { v151 } from '../src/core/schema-migrations/v151-durable-concurrent-persistence.ts';

// #5762: the request indexes, their rebuild command and the two doctor checks on PGLite.

const NAMES = PERSISTENCE_SYNC_RUN_INDEXES.map(index => index.name);
let engine: PGLiteEngine;
const ctx = () => ({ engine, config: { engine: 'pglite' }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('#5762 the indexes are in the PGLite blob and v151, and filtered out of the Postgres blob', () => {
  // test-reads-source-ok[structural]: the generated blobs are the artifact under test; the plan requires the names absent from the Postgres blob and present in PGLite's.
  const postgresBlob = readFileSync('src/core/schema-embedded.generated.ts', 'utf8');
  const pgliteBlob = readFileSync('src/core/pglite-schema.generated.ts', 'utf8');
  // test-reads-source-ok[structural]: src/schema.sql is the generated Postgres blob source; the index must never be built during blob replay.
  const schemaSql = readFileSync('src/schema.sql', 'utf8');
  for (const name of NAMES) {
    expect(postgresBlob).not.toContain(name);
    expect(schemaSql).not.toContain(name);
    expect(pgliteBlob).toContain(name);
    expect(v151.sql).toContain(name);
  }
  for (const index of PERSISTENCE_SYNC_RUN_INDEXES) expect(PERSISTENCE_SCHEMA_STATEMENTS).toContain(index.sql);
});

test('#5762 gbrain repair request-indexes rebuilds a dropped index inline on PGLite; a second run is a no-op; --all includes it', async () => {
  expect(REPAIR_KINDS).toContain('request-indexes');
  expect(repairForCheck('persistence_request_indexes')?.kind).toBe('request-indexes');
  expect(WAVE_CHECKS.find(spec => spec.id === 'persistence_request_indexes')).toMatchObject({ resolution: 'repair', registration: 'wave' });
  expect((await requestIndexesCheck(engine)).status).toBe('ok');
  await engine.executeRaw(`DROP INDEX ${NAMES[1]}`);
  const doctor = await requestIndexesCheck(engine);
  expect(doctor).toMatchObject({ status: 'warn', details: { count: 1, repair: 'request-indexes', docs: 'docs/guides/repair.md#request-indexes' } });
  expect(doctor.message).toBe(`${NAMES[1]} is missing: managed sync checkpoints can time out on a large request table. Rebuild on the brain host: gbrain repair request-indexes --apply`);
  const scope = await resolveRepairScope(engine);
  expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: false })).toMatchObject({ affected: 1, sample: [`(brain):${NAMES[1]}`], cost: { lifetime_ids: 0, embedding_pages: 0 } });
  expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ applied: 1, complete: true });
  expect((await readRequestIndexStates(engine)).map(index => index.state)).toEqual(['valid', 'valid']);
  expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ affected: 0, applied: 0 });
}, 60_000);

test('persistence_request_growth reports rows, the 7-day rate, lifetime-id use and the exhaustion date, and warns under 90 days with the filled command', async () => {
  const ok = await requestGrowthCheck(engine);
  expect(ok).toMatchObject({ name: 'persistence_request_growth', status: 'ok', details: { rows_exact: true, window_days: 7 } });
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'");
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
      intent_bytes,terminal_reservation,state,created_at)
    SELECT 'local_cli','growth-example',gen_random_uuid(),'submit_job','default',$1::uuid,'p-'||g,'d','{}'::jsonb,1,16384,'committed',now()-(g||' minutes')::interval
    FROM generate_series(1,700) g`, [source.incarnation]);
  await engine.executeRaw(`INSERT INTO persistence_counters(key,lifetime_ids) VALUES('principal:local_cli:growth-example',9000)
    ON CONFLICT(key) DO UPDATE SET lifetime_ids=EXCLUDED.lifetime_ids`);
  await engine.setConfig('persistence.limits.principal_lifetime_ids', '10000');
  try {
    const warn = await requestGrowthCheck(engine);
    expect(warn.status).toBe('warn');
    const scope = (warn.details!.scopes as Array<Record<string, unknown>>).find(row => row.scope === 'principal:local_cli:growth-example')!;
    expect(scope).toMatchObject({ lifetime_ids: 9000, limit: 10000, admissions_in_window: 700, per_day: 100, days_to_exhaustion: 10,
      config_key: 'persistence.limits.principal_lifetime_ids', window_days: 7 });
    const command = (warn.details!.commands as string[])[0];
    expect(command).toMatch(/^gbrain config set persistence\.limits\.principal_lifetime_ids \d+$/);
    expect(Number(command.split(' ').pop())).toBeGreaterThanOrEqual(20_000);
    expect(warn.message).toContain(`principal:local_cli:growth-example admits 100/day over the last 7 day(s) and reaches persistence.limits.principal_lifetime_ids=10000 (9000 used) around ${scope.exhaustion_date}`);
    expect(warn.message).toContain(`Run on the brain host: ${command} — then verify with gbrain doctor --json (check persistence_request_growth).`);
    // A second warning principal shares the same key: one command, with the largest value either needs.
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,
        intent_bytes,terminal_reservation,state,created_at)
      SELECT 'local_cli','growth-other',gen_random_uuid(),'submit_job','default',$1::uuid,'q-'||g,'d','{}'::jsonb,1,16384,'committed',now()-(g||' minutes')::interval
      FROM generate_series(1,70) g`, [source.incarnation]);
    await engine.executeRaw("INSERT INTO persistence_counters(key,lifetime_ids) VALUES('principal:local_cli:growth-other',9990)");
    const both = await requestGrowthCheck(engine);
    const commands = both.details!.commands as string[];
    expect(commands).toHaveLength(1);
    expect(Number(commands[0].split(' ').pop())).toBeGreaterThanOrEqual(Number(command.split(' ').pop()));
  } finally {
    await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_lifetime_ids'");
    await engine.executeRaw("DELETE FROM persistence_requests WHERE principal_id IN ('growth-example','growth-other')");
    await engine.executeRaw("DELETE FROM persistence_counters WHERE key IN ('principal:local_cli:growth-example','principal:local_cli:growth-other')");
  }
}, 60_000);

test('#5762 every new check and refusal docs anchor resolves', () => {
  const repair = readFileSync('docs/guides/repair.md', 'utf8');
  const refusals = readFileSync('docs/guides/write-refusals.md', 'utf8');
  for (const anchor of ['request-indexes', 'request-growth']) expect(repair).toContain(`<a id="${anchor}"></a>`);
  expect(refusals).toContain('<a id="checkpoint-validation-timeout"></a>');
});
