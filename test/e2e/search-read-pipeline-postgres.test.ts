/**
 * GBRA-156: a search read transaction sends its settings and its read behind BEGIN, before BEGIN's answer, on a
 * direct (pipelining) pool too, so each scoped search read costs one round trip instead of two. The pooler case
 * (transaction_pipeline behind transaction-mode PgBouncer) is test/e2e/pgbouncer-transaction-pipeline-6930.test.ts.
 *
 * Reads the socket trace (GBRAIN_SQL_TRACE): a statement sent before BEGIN's answer arrived was pipelined, a client
 * decision rather than a timing. Regression that fails it: the driver awaited BEGIN's answer before running the body.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { seedPage } from '../helpers/keyword-paging-fixture.ts';
import { readSqlTrace, type StatementRecord } from '../helpers/statement-counter.ts';
import { withEnv } from '../helpers/with-env.ts';

const run = process.env.DATABASE_URL ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-search-read-pipeline-'));
const trace = join(dir, 'trace.jsonl');
let databaseUrl = '';
let close: () => Promise<void> = async () => {};

const end = (r: StatementRecord) => r.t + (r.ms ?? 0);

run('search read transactions pipeline their body behind BEGIN (direct pool)', () => {
  beforeAll(async () => {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    for (let i = 0; i < 6; i++) await seedPage(isolated.engine, `notes/orbital-ledger-${i}`, `Orbital ledger entry ${i}: the quasar survey.`, { title: `Orbital Ledger ${i}` });
    await isolated.engine.disconnect();
    databaseUrl = isolated.databaseUrl;
    close = isolated.close;
  }, 300_000);

  afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await close(); });

  test('the title arm\'s settings and statement go out before BEGIN\'s answer, on BEGIN\'s connection', async () => {
    let rows = 0;
    await withEnv({ GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'search-read-direct' }, async () => {
      const engine = new PostgresEngine();
      await engine.connect({ engine: 'postgres', database_url: databaseUrl, poolSize: 1 });
      try {
        // The first call also describes each statement's parameters; the second is the one measured.
        await engine.searchTitles('orbital ledger', { requireSafeChunks: true, excludePrivate: true });
        rows = (await engine.searchTitles('orbital ledger', { requireSafeChunks: true, excludePrivate: true })).length;
      } finally { await engine.disconnect(); }
    });
    await Bun.sleep(1200);
    const records = readSqlTrace(trace).filter(r => (r as { label?: string }).label === 'search-read-direct' && r.kind !== 'connect').sort((a, b) => a.t - b.t);
    // GBRA-156: a search read transaction opens read-only, so no write can commit inside it.
    const measured = records.slice(records.findLastIndex(r => /^begin read only$/i.test(r.sql)));
    const begin = measured[0]!;
    expect(begin.sql).toMatch(/^begin read only$/i);
    const settings = measured.find(r => /^SELECT set_config\('jit'/.test(r.sql))!;
    const title = measured.find(r => /WITH top_pages AS/.test(r.sql))!;
    expect(rows).toBeGreaterThan(0);
    expect([settings.conn, title.conn]).toEqual([begin.conn, begin.conn]);
    expect(settings.t < end(begin)).toBe(true);
    expect(title.t < end(begin)).toBe(true);
  }, 60_000);
});
