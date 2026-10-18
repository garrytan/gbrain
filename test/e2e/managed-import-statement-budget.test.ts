/**
 * #6712 PR 3 (L6): the Postgres twin of test/managed-import-statement-budget.test.ts.
 * One whole managed import of a YC-shaped page at 0.5x, 1x and 2x, counted at
 * the socket by the env-gated wire trace (src/core/sql-trace.ts): `execute` and
 * `simple` records are statements; `describe` records (the extra round trip a
 * statement pays the first time a connection sees it) are reported, not
 * budgeted. On Postgres the page publishes through publishGroup (a group of one
 * on the consumer's lane), with its effects queued in the same transaction.
 *
 * Protects: every statement in the page's publication transaction runs the same
 * number of times at every size except the chunked set-based inserts (at most
 * one per 500 rows); the transaction stays within its budget; no statement text
 * runs per row or per code reference anywhere in the sync.
 * Fails when: a per-row statement enters the import, a chunked insert loses its
 * batching, or the publication transaction grows past its budget.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readSqlTrace, type StatementRecord } from '../helpers/statement-counter.ts';
import { byText, chunkOf, CHUNKED, PAGE_SLUG, prepareManagedImport, publicationOf } from '../helpers/managed-import-budget.ts';
import type { YcShapedPage } from '../helpers/yc-shaped-page.ts';
import { withEnv } from '../helpers/with-env.ts';

/** About 10% over the measured publication transaction at 1x (#6712 L6 measured 67 on Postgres; 317 before code references were batched). */
const PUBLICATION_BUDGET = 74;
const PER_ROW_CEILING = 40;
const SIZES = [0.5, 1, 2] as const;

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-budget-pg-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

type Measured = { page: YcShapedPage; records: StatementRecord[]; publication: StatementRecord[] };
const runs = new Map<number, Promise<Measured>>();
function measured(scale: number): Promise<Measured> {
  const cached = runs.get(scale);
  if (cached) return cached;
  const run = measure(scale);
  runs.set(scale, run);
  return run;
}
async function measure(scale: number): Promise<Measured> {
  // One file for every size: the trace buffers process-wide and flushes into the first file it was given.
  const trace = join(home, 'trace.jsonl');
  return withEnv({ GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'import-budget', GBRAIN_HOME: join(home, `home-${scale}`) }, async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 6);
    const sourceId = `budget-${String(scale).replace('.', '-')}`;
    try {
      const { page, run } = await prepareManagedImport(pg.engine, home, sourceId, scale);
      const started = performance.timeOrigin + performance.now();
      const result = await run();
      const ended = performance.timeOrigin + performance.now();
      expect(result.status).toBe('synced');
      expect((await pg.engine.getPage(PAGE_SLUG, { sourceId }))?.slug).toBe(PAGE_SLUG);
      await disposePersistenceConsumer(pg.engine);
      // The trace flushes every second and at exit; wait until the publication's commit has landed.
      for (let i = 0; ; i++) {
        const records = readSqlTrace(trace).filter(record => record.t >= started && record.t <= ended);
        try { return { page, records, publication: publicationOf(records) }; }
        catch (error) { if (i >= 50) throw error; }
        await Bun.sleep(100);
      }
    } finally {
      await disposePersistenceConsumer(pg.engine);
      await pg.close();
    }
  });
}

const d = hasDatabase() ? describe : describe.skip;
d('managed import statement budget (Postgres)', () => {
  test('the publication transaction runs every statement the same number of times at every size, except bounded chunks', async () => {
    const [small, large] = [await measured(0.5), await measured(2)];
    const smallCounts = byText(small.publication), largeCounts = byText(large.publication);
    for (const text of new Set([...smallCounts.keys(), ...largeCounts.keys()])) {
      const chunk = chunkOf(text);
      if (chunk) {
        for (const run of [small, large]) expect(byText(run.publication).get(text) ?? 0).toBeLessThanOrEqual(Math.ceil(chunk.rows(run.page) / chunk.rowsPerChunk));
        continue;
      }
      expect({ text, count: largeCounts.get(text) ?? 0 }).toEqual({ text, count: smallCounts.get(text) ?? 0 });
    }
    for (const chunk of CHUNKED) expect([...largeCounts.keys()].some(text => chunk.pattern.test(text))).toBe(true);
  }, 300_000);

  test('the publication transaction stays within its budget at 1x', async () => {
    const { publication } = await measured(1);
    const statements = publication.filter(record => record.kind === 'execute' || record.kind === 'simple');
    expect(statements.length).toBeLessThanOrEqual(PUBLICATION_BUDGET);
  }, 300_000);

  test('no statement runs per row or per code reference anywhere in the import', async () => {
    for (const scale of SIZES) {
      const { records, page } = await measured(scale);
      expect(page.codeRefs.length * 2).toBeGreaterThan(PER_ROW_CEILING);
      const hot = [...byText(records)].filter(([text, count]) => !chunkOf(text) && count >= PER_ROW_CEILING);
      expect(hot).toEqual([]);
    }
  }, 300_000);
});
