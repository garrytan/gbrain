/**
 * The env-gated SQL trace (src/core/sql-trace.ts, docs/eval/managed-sync-catchup.md)
 * records one row per database round trip at the socket: tagged templates,
 * `unsafe` with parameters (its unprepared describe round trip included),
 * simple-protocol transaction control and the connection handshake, each
 * attributed to the process label and the server backend pid.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { traceSqlOptions } from '../../src/core/sql-trace.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const url = process.env.DATABASE_URL;
const run = url ? test : test.skip;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-sql-trace-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

run('records each round trip with its statement, kind, label and backend pid', async () => {
  assertSafeE2eDatabaseUrl(url!);
  const file = join(dir, 'trace.jsonl');
  await withEnv({ GBRAIN_SQL_TRACE: file, GBRAIN_SQL_TRACE_LABEL: 'e2e-trace' }, async () => {
    const sql = postgres(url!, traceSqlOptions({ max: 1, onnotice: () => {} } as Record<string, unknown>, 'test') as Parameters<typeof postgres>[1]);
    try {
      const [{ pid }] = await sql`SELECT pg_backend_pid() AS pid`;
      await sql.unsafe('SELECT $1::int AS n', [1]);
      await sql.unsafe('SELECT $1::int AS n', [2]);
      await sql.begin(tx => tx.unsafe('SELECT 1 AS one'));
      const [{ app }] = await sql`SELECT current_setting('application_name') AS app`;
      expect(app).toBe(`gbrain:e2e-trace:${process.pid}:test`);
      await Bun.sleep(1200);
      const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; sql: string; backend: number; label: string; pool: string; ms: number });
      expect(rows.every(r => r.label === 'e2e-trace' && r.pool === 'test')).toBe(true);
      expect(rows[0]).toMatchObject({ kind: 'connect', sql: '<connect>' });
      expect(rows.filter(r => r.kind !== 'connect').every(r => r.backend === Number(pid))).toBe(true);
      const unsafe = rows.filter(r => r.sql === 'SELECT $1::int AS n').map(r => r.kind);
      // The second unprepared run reuses the parameter types the pool described (shared_types), so it skips the describe.
      expect(unsafe).toEqual(['describe', 'execute', 'execute']);
      expect(rows.filter(r => /^(begin|commit)$/.test(r.sql.trim())).map(r => r.sql.trim())).toEqual(['begin', 'commit']);
      expect(rows.some(r => r.kind === 'simple' && r.sql === 'SELECT 1 AS one')).toBe(true);
      expect(rows.every(r => r.ms >= 0)).toBe(true);
    } finally { await sql.end(); }
  });
});
