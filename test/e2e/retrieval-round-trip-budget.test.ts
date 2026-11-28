/**
 * GBRA-156: round trips one cold CLI read pays on Postgres, counted at the
 * socket by the env-gated wire trace (src/core/sql-trace.ts). On a pooled
 * brain every round trip costs the pooler RTT, so the count is the cold-path
 * latency that a CI runner can measure without noise: at 40 ms RTT, a cold
 * search on v0.60.328.0 paid about 113 round trips (4.3 s) against 55 for the
 * same search in a running `gbrain serve`
 * (scripts/bench/retrieval-scale/run.ts --trace).
 *
 * Counted: `execute` and `simple` records (statements) and `connect`
 * records. `describe` records are the extra round trip a statement pays the
 * first time a connection prepares it; which connection runs a statement is
 * not deterministic, so they are reported, not budgeted.
 *
 * Budgets sit about 10% above the counts measured when they were set. Lower
 * one in the change that removes round trips; raising one is a reviewer-
 * visible act that names what the new round trips buy.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { readSqlTrace } from '../helpers/statement-counter.ts';
import { seedPage } from '../helpers/keyword-paging-fixture.ts';

const CLI = join(import.meta.dir, '../../src/cli.ts');
/**
 * Measured on v0.60.333.0 (after #7169) with no provider keys (keyword search): search 59, get 17, recall 35.
 * Search is 67 since the exact capped retrieval-coverage counts (capped-count-exact): the held-pages count now runs
 * under COVERAGE_COUNT_TIMEOUT_MS, so it is BEGIN + SET LOCAL statement_timeout, the statement and COMMIT: two more
 * wire records than the one unbounded statement it replaced (65). The three are sent in one pipelined batch on their
 * own connection, so no round trip is added to the search's wall time. Measured 67 on two cold runs.
 * search +1 (GST-4029, sync 21): `search.long_page_unit` defaults to `section`, so a search with a non-conversation hit
 * runs the one long-page size preflight that buys section delivery: selectLongPages' `SELECT p.id,
 * char_length(...) AS chars, octet_length(...) AS bytes FROM pages p WHERE p.id = ANY($1)` (search/evidence-delivery.ts).
 * Search hits carry no page size, so it cannot be skipped without one. Measured on Postgres in sync 21 (merged tree, fresh
 * database, no provider keys): search 68, get 14, recall 26. Search's 68 is the 67 above plus that one read, so its budget
 * is the measurement. Get and recall measure well under their 19 and 38 on this trunk (typed members replaced raw reads
 * before sync 21); sync 21 changed neither path, so those two budgets are left for the change that claims the saving.
 */
const BUDGET: Record<string, number> = { search: 68, get: 19, recall: 38 };

const run = process.env.DATABASE_URL ? describe : describe.skip;
let home = '';
let close: () => Promise<void> = async () => {};

async function coldRoundTrips(args: string[]): Promise<{ trips: number; describes: number; code: number; stderr: string }> {
  const trace = join(home, `trace-${args[0]}-${Date.now()}.jsonl`);
  const env: Record<string, string> = { ...process.env as Record<string, string>, GBRAIN_HOME: home, GBRAIN_SQL_TRACE: trace, GBRAIN_NO_UPDATE_CHECK: '1', GBRAIN_TELEMETRY: '0' };
  for (const key of ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DATABASE_URL', 'GBRAIN_DATABASE_URL']) delete env[key];
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: 'ignore', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  const records = readSqlTrace(trace);
  return {
    trips: records.filter(r => r.kind === 'execute' || r.kind === 'simple' || r.kind === 'connect').length,
    describes: records.filter(r => r.kind === 'describe').length,
    code,
    stderr,
  };
}

run('cold CLI read round trips on Postgres', () => {
  beforeAll(async () => {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    close = isolated.close;
    for (let i = 0; i < 12; i++) await seedPage(isolated.engine, `notes/orbital-ledger-${i}`, `Orbital ledger entry ${i}: the quasar survey moved to week ${i}.`, { title: `Orbital Ledger ${i}` });
    await isolated.engine.disconnect();
    home = mkdtempSync(join(tmpdir(), 'gbrain-rt-budget-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: isolated.databaseUrl }));
  }, 300_000);

  afterAll(async () => {
    await close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  for (const [verb, args] of [
    ['search', ['search', 'quasar survey', '--json']],
    ['get', ['get', 'notes/orbital-ledger-3']],
    ['recall', ['recall', 'quasar survey', '--json']],
  ] as const) {
    test(`${verb} stays within its round-trip budget`, async () => {
      await coldRoundTrips([...args]);
      const measured = await coldRoundTrips([...args]);
      console.log(`[round-trips] ${verb}: ${measured.trips} (+${measured.describes} describe)`);
      expect(measured.code, measured.stderr.slice(-2000)).toBe(0);
      expect(measured.trips).toBeGreaterThan(0);
      expect(measured.trips).toBeLessThanOrEqual(BUDGET[verb]!);
    }, 120_000);
  }

  // GST-2762: every page holds both words, so the first page is short and the keyless any-word fill runs its lookup. A search whose all-words match is empty runs the same any-word retry from the main keyword arm, so with the fill asking only for the retry the two cost the same round trips.
  test('the any-word fill costs no more round trips than the any-word retry it runs', async () => {
    await coldRoundTrips(['search', 'quasar survey', '--json']);
    const filled = await coldRoundTrips(['search', 'quasar survey', '--json']);
    const retried = await coldRoundTrips(['search', 'quasar telescope', '--json']);
    console.log(`[round-trips] search with the fill: ${filled.trips}, search with the retry only: ${retried.trips}`);
    expect(filled.code, filled.stderr.slice(-2000)).toBe(0);
    expect(retried.code, retried.stderr.slice(-2000)).toBe(0);
    expect(filled.trips).toBeLessThanOrEqual(retried.trips);
  }, 120_000);
});
