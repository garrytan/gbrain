/**
 * #10605: the segmented-storage gate's evidence read (SEGMENTED_GATE_EVIDENCE_SQL) bounds its two request-table arms on
 * `created_at` and on `COALESCE(published_at, completed_at)` of committed receipts. With no index leading on either, every
 * read scanned the whole request table and its TOAST. The migration builds both indexes in the v179 online shape
 * (`transaction: false`, an empty `sql`, a `buildIndexOnline` handler) and the read's plan uses them on both engines.
 *
 * The migration is found by its name, never by its number: the number is confirmed at landing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { readRequestIndexStates } from '../src/core/persistence/checkpoint-validation.ts';
import { PERSISTENCE_COMMITTED_SEEN_INDEX, PERSISTENCE_REQUEST_CREATED_INDEX, PERSISTENCE_REQUEST_ONLINE_INDEXES, PERSISTENCE_SCHEMA_STATEMENTS } from '../src/core/persistence/schema.ts';
import { SEGMENTED_GATE_EVIDENCE_SQL } from '../src/core/engine-sql/writer-versions.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { runRepair, resolveRepairScope } from '../src/core/repair/core.ts';
import { requestIndexesRepair } from '../src/core/repair/request-indexes.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const INDEXES = [PERSISTENCE_REQUEST_CREATED_INDEX, PERSISTENCE_COMMITTED_SEEN_INDEX];
const migration = MIGRATIONS.find(m => m.name === 'persistence_request_window_indexes');

describe('#10605 the request window index migration module', () => {
  test('is registered once, in the online-index shape', () => {
    expect(MIGRATIONS.filter(m => m.name === 'persistence_request_window_indexes')).toHaveLength(1);
    expect(migration).toMatchObject({ idempotent: true, transaction: false, sql: '' });
    // pregate-literal: LATEST_SCHEMA_VERSION=343 master's latest before this migration, so a renumber stays above it
    expect(migration!.version).toBeGreaterThan(343);
    expect(migration!.version).toBeLessThanOrEqual(LATEST_SCHEMA_VERSION);
    expect(typeof migration!.handler).toBe('function');
  });
  test('is DDL only and leads each index on the column its arm bounds', () => {
    expect(PERSISTENCE_REQUEST_CREATED_INDEX.sql).toMatch(/ON persistence_requests\(created_at\)$/);
    expect(PERSISTENCE_COMMITTED_SEEN_INDEX.sql).toMatch(/ON persistence_requests\(\(COALESCE\(published_at,completed_at\)\)\) WHERE state='committed'$/);
    for (const index of INDEXES) expect(index.sql).not.toMatch(/ALTER TABLE|ADD COLUMN|UPDATE /i);
  });
  test('stays out of the v151 statement list (published_at arrives in v178) and is known to repair and doctor', () => {
    for (const index of INDEXES) {
      expect(PERSISTENCE_SCHEMA_STATEMENTS.some(sql => sql.includes(index.name))).toBe(false);
      expect(PERSISTENCE_REQUEST_ONLINE_INDEXES.map(i => i.name)).toContain(index.name);
    }
  });
});

for (const backend of testBackends()) describe(`[${backend}] #10605 the request window indexes on a brain`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const ctx = () => ({ engine, config: { engine: backend }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
  const states = async () => (await readRequestIndexStates(engine, INDEXES)).map(row => row.state);
  const plan = async () => JSON.stringify(await engine.executeRaw(`EXPLAIN (FORMAT JSON) ${SEGMENTED_GATE_EVIDENCE_SQL}`, [7]));

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); await closePostgres?.(); }, 60_000);

  test('a current brain has both indexes valid; the migration handler is a no-op on it', async () => {
    expect(await states()).toEqual(['valid', 'valid']);
    await migration!.handler!(engine);
    expect(await states()).toEqual(['valid', 'valid']);
  });

  test('dropped indexes are rebuilt by the migration handler and by gbrain repair request-indexes', async () => {
    for (const index of INDEXES) await engine.executeRaw(`DROP INDEX ${index.name}`);
    expect(await states()).toEqual(['missing', 'missing']);
    await migration!.handler!(engine);
    expect(await states()).toEqual(['valid', 'valid']);
    for (const index of INDEXES) await engine.executeRaw(`DROP INDEX ${index.name}`);
    const scope = await resolveRepairScope(engine);
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: false })).toMatchObject({ affected: 2 });
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ applied: 2, complete: true });
    expect(await states()).toEqual(['valid', 'valid']);
  }, 60_000);

  test('the gate evidence read walks only the window on a large request table, and scanned every receipt without the indexes', async () => {
    // 60k receipts admitted and published a year ago (most compacted, as on a long-lived brain), 20 inside the window.
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,
        intent_bytes,terminal_reservation,state,compacted,created_at,completed_at,published_at)
      SELECT 'local_cli','seed',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'seed-'||g,'d',
        CASE WHEN g>59980 THEN jsonb_build_object('kind','put_page','pad',repeat('x',2000)) END,'{}'::jsonb,1,64,'committed',g<=59980,
        CASE WHEN g>59980 THEN now()-interval '1 hour' ELSE now()-interval '400 days' END,
        CASE WHEN g>59980 THEN now()-interval '59 minutes' ELSE now()-interval '400 days' END,
        CASE WHEN g>59980 AND g%2=0 THEN now()-interval '58 minutes' WHEN g<=59980 THEN now()-interval '400 days' END
      FROM generate_series(1,60000) g`);
    await engine.executeRaw('ANALYZE persistence_requests');
    const indexed = await plan();
    for (const index of INDEXES) expect(indexed).toContain(index.name);
    expect(indexed).not.toMatch(/"Node Type":\s*"Seq Scan",[^}]*"Relation Name":\s*"persistence_requests"/);
    const rows = await engine.executeRaw<{ role: string; requests: number }>(SEGMENTED_GATE_EVIDENCE_SQL, [7]);
    expect(rows.filter(r => r.role === 'admitter').reduce((n, r) => n + Number(r.requests), 0)).toBe(20);
    expect(rows.filter(r => r.role === 'consumer').reduce((n, r) => n + Number(r.requests), 0)).toBe(20);

    for (const index of INDEXES) await engine.executeRaw(`DROP INDEX ${index.name}`);
    expect(await plan()).toMatch(/"Node Type":\s*"Seq Scan",[^}]*"Relation Name":\s*"persistence_requests"/);
    await migration!.handler!(engine);
    await engine.executeRaw('ANALYZE persistence_requests');
    const rebuilt = await plan();
    for (const index of INDEXES) expect(rebuilt).toContain(index.name);
  }, 120_000);
});
