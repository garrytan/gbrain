/**
 * #6712 PR 3 (L6): `gbrain sync status` costs a fixed number of statements
 * however many request rows the source has.
 *
 * Protects: the plain status (and the --detail status) of a source with 61,000
 * terminal write receipts sends exactly as many statements as with 1,000, and
 * the plain status stays within its round-trip budget, so its latency is
 * bounded by round trips times RTT (the 5 s target at 57 ms leaves room for
 * about 87), not by the size of the journal.
 * Fails when: a status read turns per row (or per receipt), or the plain
 * status grows past its budget.
 * Seams: the PGLite statement counter; Postgres through the wire trace in
 * test/e2e/sync-status-statement-budget-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { vacuumPersistenceQueues } from '../src/core/persistence/journal.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { countPgliteStatements, readSqlTrace, type StatementRecord } from './helpers/statement-counter.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

/** About 10% over the measured plain status (#6712 L6 measured 10 statements on PGLite, 14 on Postgres). */
const PLAIN_BUDGET = { pglite: 11, postgres: 15 } as const;
const home = mkdtempSync(join(tmpdir(), 'gbrain-status-budget-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** `rows` terminal receipts of managed imports: most committed, one in fifty failed, the newest within the last ten minutes. */
async function seed(engine: BrainEngine, sourceId: string, rows: number) {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,
      terminal_reservation,state,error_code,error_message,intent,completed_at,updated_at,admitter_version)
    SELECT 'local_cli','fixture',gen_random_uuid(),'put_page',$1,(SELECT incarnation FROM sources WHERE id=$1),'notes/n'||g,md5(g::text),'{}'::jsonb,0,0,
      CASE WHEN g % 50 = 0 THEN 'failed' ELSE 'committed' END, CASE WHEN g % 50 = 0 THEN 'storage_error' END, CASE WHEN g % 50 = 0 THEN 'fixture failure' END,
      jsonb_build_object('kind','managed_sync_import','path','notes/n'||g||'.md'),
      now() - make_interval(secs => g), now() - make_interval(secs => g), '0.60.267.0'
    FROM generate_series(1,$2::int) AS g`, [sourceId, rows]);
  // PGLite has no autovacuum: the resident owner keeps the queue's planner statistics current as it grows, so the
  // fixture does what that owner does (without statistics the --detail summary plans a nested loop over every receipt).
  await vacuumPersistenceQueues(engine);
}

for (const backend of testBackends()) {
  describe(`sync status statement budget (${backend})`, () => {
    const trace = join(home, `trace-${backend}.jsonl`);
    let engine: BrainEngine;
    let counted: <T>(run: () => Promise<T>) => Promise<StatementRecord[]>;
    const sources: string[] = [];
    beforeAll(async () => {
      await withEnv(backend === 'postgres' ? { GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'status-budget' } : {}, async () => {
        if (backend === 'pglite') {
          const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
          counted = async run => { const counter = countPgliteStatements(lite); try { await run(); } finally { counter.stop(); } return counter.records; };
        } else {
          const pg = new PostgresEngine(); await pg.connect({ database_url: requirePostgresTestDatabase(), poolSize: 1 }); await pg.initSchema(); engine = pg;
          counted = async run => {
            const started = performance.timeOrigin + performance.now();
            await run();
            const ended = performance.timeOrigin + performance.now();
            // The trace flushes every second; one more flush lands the window.
            await Bun.sleep(1200);
            return readSqlTrace(trace).filter(record => record.t >= started && record.t <= ended);
          };
        }
      });
    });
    afterAll(async () => {
      if (backend === 'postgres') for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
      await engine?.disconnect();
    });

    test('a 61,000-receipt source costs the same statements as a 1,000-receipt one, within budget', async () => {
      const statements = (records: StatementRecord[]) => records.filter(record => record.kind === 'execute' || record.kind === 'simple').length;
      const measured: Record<string, { plain: number; detail: number }> = {};
      for (const rows of [1_000, 61_000]) {
        const sourceId = `status-budget-${backend}-${rows}`;
        sources.push(sourceId);
        await seed(engine, sourceId, rows);
        const plain = await counted(() => readSyncStatus(engine, sourceId, { detail: false }));
        const detail = await counted(() => readSyncStatus(engine, sourceId, { detail: true }));
        measured[rows] = { plain: statements(plain), detail: statements(detail) };
      }
      expect(measured[61_000]).toEqual(measured[1_000]!);
      expect(measured[61_000]!.plain).toBeLessThanOrEqual(PLAIN_BUDGET[backend]);
    }, 300_000);
  });
}
