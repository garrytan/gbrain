/**
 * #5984: the vendored driver shares a described statement's parameter types across
 * a pool's connections (`shared_types`, vendor/README.md). A connection running the
 * statement for the first time then skips the describe round trip, with the same
 * results; a failure forgets the shared types, and a database's own types (pgvector)
 * are never shared.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { traceSqlOptions } from '../../src/core/sql-trace.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const url = process.env.DATABASE_URL;
const run = url ? test : test.skip;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-shared-types-'));
// The trace module opens its file once per process, so every test shares it and reads its own backends' rows.
const traceFile = join(dir, 'trace.jsonl');
const table = `shared_types_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
let admin: ReturnType<typeof postgres> | undefined;

beforeAll(async () => {
  if (!url) return;
  assertSafeE2eDatabaseUrl(url);
  admin = postgres(url, { max: 1, onnotice: () => {} });
  // The pgvector case needs the extension; a fresh database (the stress gate makes one per iteration) has none yet.
  await admin.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await admin.unsafe(`CREATE TABLE ${table} (c int)`);
  await admin.unsafe(`INSERT INTO ${table} VALUES (1)`);
});
afterAll(async () => {
  await admin?.unsafe(`DROP TABLE IF EXISTS ${table}`);
  await admin?.end();
  rmSync(dir, { recursive: true, force: true });
});

const rowsOf = (rows: Iterable<unknown>) => Array.from(rows);
type TraceRow = { kind: string; sql: string; backend: number };
/** Runs `body` with two reserved connections of one traced pool; returns the trace rows by backend. */
async function traced(options: Record<string, unknown>, body: (a: postgres.ReservedSql, b: postgres.ReservedSql, sql: ReturnType<typeof postgres>) => Promise<void>) {
  let pids: number[] = [];
  await withEnv({ GBRAIN_SQL_TRACE: traceFile, GBRAIN_SQL_TRACE_LABEL: 'shared-types' }, async () => {
    const sql = postgres(url!, traceSqlOptions({ max: 2, onnotice: () => {}, ...options }, 'test') as Parameters<typeof postgres>[1]);
    try {
      const a = await sql.reserve(), b = await sql.reserve();
      try {
        pids = [Number((await a`SELECT pg_backend_pid() AS pid`)[0]!.pid), Number((await b`SELECT pg_backend_pid() AS pid`)[0]!.pid)];
        await body(a, b, sql);
      } finally { a.release(); b.release(); }
      await Bun.sleep(1200);
    } finally { await sql.end(); }
  });
  const rows = readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TraceRow);
  return { on: (index: number, text: string) => rows.filter(r => r.backend === pids[index] && r.sql === text).map(r => r.kind) };
}

const MIXED = `SELECT $1::uuid[] AS ids, $2::text::jsonb AS doc, $3::bigint AS big, $4::boolean AS flag, $5::timestamptz AS at,
  $6::bytea AS raw, $7::text AS none, $8::text AS words, $9::int AS n`;
const ids = [randomUUID(), randomUUID()], at = new Date('2026-10-07T12:34:56.789Z');
const mixed = () => [ids, JSON.stringify({ a: [1, 'two'], b: null }), '9007199254740993', true, at, Buffer.from([0, 1, 254]), null, 'naïve ☃ text', 42];

for (const prepare of [true, false]) {
  run(`a second connection runs a statement the pool described without a describe round trip, with the same results (prepare ${prepare})`, async () => {
    const results: unknown[] = [];
    const trace = await traced({ prepare }, async (a, b) => {
      results.push(await a.unsafe(MIXED, mixed() as never[]));
      results.push(await b.unsafe(MIXED, mixed() as never[]));
      results.push(await b.unsafe(MIXED, mixed() as never[]));
    });
    expect(trace.on(0, MIXED)).toEqual(['describe', 'execute']);
    expect(trace.on(1, MIXED)).toEqual(['execute', 'execute']);
    const [first, second, third] = results.map(rows => JSON.parse(JSON.stringify((rows as Record<string, unknown>[])[0], (_k, v) => typeof v === 'bigint' ? String(v) : v)));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first).toMatchObject({ ids, doc: { a: [1, 'two'], b: null }, big: '9007199254740993', flag: true, at: at.toISOString(), none: null, words: 'naïve ☃ text', n: 42 });
  });
}

run('with shared_types off, each connection describes the statement itself', async () => {
  const trace = await traced({ shared_types: false }, async (a, b) => {
    await a.unsafe('SELECT $1::int AS n', [1]);
    await b.unsafe('SELECT $1::int AS n', [2]);
  });
  expect(trace.on(0, 'SELECT $1::int AS n')).toEqual(['describe', 'execute']);
  expect(trace.on(1, 'SELECT $1::int AS n')).toEqual(['describe', 'execute']);
});

run('a statement whose shared types no longer fit fails once, then describes again and succeeds', async () => {
  const text = `SELECT c FROM ${table} WHERE c = $1`;
  await traced({ prepare: true }, async (a, b, sql) => {
    expect(rowsOf(await a.unsafe(text, ['1'], { prepare: true }))).toEqual([{ c: 1 }]);
    await admin!.unsafe(`ALTER TABLE ${table} ALTER COLUMN c TYPE text USING c::text`);
    const shared = (sql as unknown as { options: { shared_types: Map<string, number[]> } }).options.shared_types;
    expect([...shared.values()].some(types => types.length === 1 && types[0] === 23)).toBe(true);
    const failed = await b.unsafe(text, ['1'], { prepare: true }).then(() => null, (error: { code?: string }) => error);
    expect(failed).toMatchObject({ code: '42883' });
    expect(rowsOf(await b.unsafe(text, ['1'], { prepare: true }))).toEqual([{ c: '1' }]);
  });
});

run('a parameter of a database-defined type (pgvector) is never shared', async () => {
  const text = 'SELECT vector_dims($1::vector) AS dims';
  const trace = await traced({}, async (a, b) => {
    expect(rowsOf(await a.unsafe(text, ['[1,2,3]'], { prepare: true }))).toEqual([{ dims: 3 }]);
    expect(rowsOf(await b.unsafe(text, ['[1,2,3]'], { prepare: true }))).toEqual([{ dims: 3 }]);
  });
  expect(trace.on(1, text)).toEqual(['describe', 'execute']);
});

run('a new process with the saved types for this database runs its first statements without describe round trips', async () => {
  const { _resetSharedParameterTypesForTests, loadSharedParameterTypes, sharedParameterTypes } = await import('../../src/core/pg-type-cache.ts');
  const text = `SELECT count(*)::int AS n FROM ${table} WHERE c::text = $1 AND $2::bigint > 0`;
  const scope = `e2e-${randomUUID()}`;
  const runAs = async (persist: string | undefined) => {
    _resetSharedParameterTypesForTests();
    return await withEnv({ GBRAIN_HOME: dir, GBRAIN_PG_TYPE_CACHE_PERSIST: persist }, async () => {
      const store = sharedParameterTypes(url!);
      loadSharedParameterTypes(url!, '0', scope);
      const trace = await traced({ shared_types: store }, async (a) => {
        expect(rowsOf(await a.unsafe(text, ['1', '1'] as never[]))).toEqual([{ n: 1 }]);
      });
      (store as unknown as { save(): void }).save();
      return trace.on(0, text);
    });
  };
  try {
    expect(await runAs(undefined)).toEqual(['describe', 'execute']);
    expect(await runAs(undefined)).toEqual(['execute']);
    expect(await runAs('0')).toEqual(['describe', 'execute']);
  } finally {
    _resetSharedParameterTypesForTests();
  }
});
