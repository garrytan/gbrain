/**
 * #7147: a one-shot read verb through a transaction-mode pooler pays one
 * network round trip per statement, so startup statements are the wall clock
 * of every `gbrain entity` / `gbrain get` call. This pins the statements a cold
 * read spends on the config table and on managed-writer maintenance, counted
 * at the socket by the wire trace (`GBRAIN_SQL_TRACE`), never in milliseconds.
 *
 * Protects: a read verb reads the config table through one snapshot per phase
 * (startup, then the context build and the operation) instead of one
 * statement per key, skips the
 * retired-marker cleanup a read never depends on, and shows the pooler banner
 * once per database. Regressions it catches: a new per-key `getConfig` on the
 * read path outside a snapshot, the cleanup running for reads again, or the
 * banner printing on every call. Existing budget tests cover page writes and
 * imports, not CLI read startup. The second half pins the statements the
 * follow-up folded: one config snapshot shared by startup and the read, one
 * sources read, the custody row without a table probe, the search-statistics
 * guard as one statement, and a two-connection pool for a one-shot read.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../helpers/cli-spawn.ts';
import { readSqlTrace, type StatementRecord } from '../helpers/statement-counter.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeDatabase = hasDatabase() ? describe : describe.skip;
const BANNER = 'Prepared statements and statement pipelining disabled';

function poolerUrl(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('prepare', 'false');
  return url.toString();
}

let home: string;

async function tracedRead(args: string[], name: string): Promise<{ stderr: string; statements: StatementRecord[] }> {
  const trace = join(home, `${name}.ndjson`);
  const r = await runCli(args, { home, cwd: home, timeoutMs: 90_000, env: { GBRAIN_SQL_TRACE: trace } });
  expect(r.exitCode, r.stderr).toBe(0);
  return { stderr: r.stderr, statements: readSqlTrace(trace).filter(s => s.kind === 'execute' || s.kind === 'simple' || s.kind === 'describe') };
}

/** Config-table statements, leaving out the pool's connection check (db.ts checkPoolAndLoadSharedTypes reads the schema version with it). */
const configStatements = (statements: StatementRecord[]) =>
  statements.filter(s => /\bFROM\s+config\b/i.test(s.sql) && !s.sql.includes('server_version_num'));

describeDatabase('cold read verb startup through a transaction pooler (#7147)', () => {
  beforeAll(async () => {
    await setupDB();
    await getEngine().putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example works at Acme Example.', timeline: '',
    });
    home = mkdtempSync(join(tmpdir(), 'gbrain-cold-read-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: poolerUrl(), embedding_disabled: true }));
  });
  afterAll(async () => {
    await teardownDB();
    rmSync(home, { recursive: true, force: true });
  });

  test('the pooler banner prints on the first call only', async () => {
    const first = await tracedRead(['entity', 'Alice Example'], 'banner-1');
    expect(first.stderr).toContain(BANNER);
    const second = await tracedRead(['entity', 'Alice Example'], 'banner-2');
    expect(second.stderr).not.toContain(BANNER);
  }, 180_000);

  for (const args of [['entity', 'Alice Example'], ['get', 'people/alice-example']]) {
    test(`gbrain ${args[0]}: config reads come from snapshots, and no retired-marker cleanup runs`, async () => {
      const { statements } = await tracedRead(args, `budget-${args[0]}`);
      const config = configStatements(statements);
      expect(config.length, config.map(s => s.sql).join('\n')).toBeLessThanOrEqual(2);
      expect(statements.filter(s => s.sql.includes('persistence_topology_changes'))).toEqual([]);
    }, 120_000);
  }

  /**
   * #7147 follow-up: each statement below was a round trip every cold read paid. A read shares one config snapshot
   * between startup and the operation (one bulk read, no per-key read), reads the sources table once for tier 4,
   * tier 5.5 and the federated set, reads the graduation custody row without a to_regclass probe first, and opens at
   * most two pooled connections. Each assertion fails on the base branch.
   */
  const sql = (s: StatementRecord) => s.sql.replace(/\s+/g, ' ').trim();
  const show = (rows: StatementRecord[]) => rows.map(sql).join('\n');
  for (const args of [['search', 'Acme'], ['query', 'who works at Acme'], ['get', 'people/alice-example'], ['entity', 'Alice Example'], ['recall', 'Alice Example']]) {
    test(`gbrain ${args[0]}: one config read, one sources read, one custody read, two connections`, async () => {
      const { statements } = await tracedRead(args, `folded-${args[0]}`);
      const config = configStatements(statements);
      expect(config.map(sql), show(config)).toEqual(["SELECT key, value FROM config WHERE NOT starts_with(key, 'brainstorm.domain_bank.prefixes:')"]);
      const sources = statements.filter(s => /\bFROM\s+sources\b/i.test(s.sql) && !/\bJOIN\s+sources\b/i.test(s.sql) && /^\s*SELECT\s+id\b/i.test(s.sql));
      expect(sources.length, show(sources)).toBe(1);
      expect(statements.filter(s => s.sql.includes("to_regclass('persistence_graduation')"))).toEqual([]);
      expect(statements.filter(s => /\bFROM\s+persistence_graduation\b/.test(s.sql)).length).toBe(1);
      expect(statements.filter(s => s.sql.includes('persistence_topology_changes'))).toEqual([]);
      const connects = readSqlTrace(join(home, `folded-${args[0]}.ndjson`)).filter(s => s.kind === 'connect');
      expect(connects.length).toBeLessThanOrEqual(2);
    }, 120_000);
  }

  test('gbrain search: the search-statistics guard is one statement', async () => {
    const { statements } = await tracedRead(['search', 'Acme'], 'folded-statistics');
    const probes = statements.filter(s => s.sql.includes('pg_stats') || /reltuples::float8 AS reltuples FROM pg_class WHERE oid = 'pages'/.test(s.sql) || s.sql.includes('pg_statistic_ext'));
    expect(probes.length, show(probes)).toBe(1);
  }, 120_000);

  test('GBRAIN_POOL_SIZE still sizes a one-shot read pool', async () => {
    const trace = join(home, 'pool-size-1.ndjson');
    const r = await runCli(['search', 'Acme'], { home, cwd: home, timeoutMs: 90_000, env: { GBRAIN_SQL_TRACE: trace, GBRAIN_POOL_SIZE: '1' } });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(readSqlTrace(trace).filter(s => s.kind === 'connect').length).toBe(1);
  }, 120_000);
});
