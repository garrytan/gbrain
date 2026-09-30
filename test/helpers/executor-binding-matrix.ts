/**
 * E5 executor binding-matrix contract (refactor wave 1, EO18 / EO20 / O14 / E-3).
 *
 * ONE case table, run against every executor that can reach a database:
 * today `engine.executeRaw` on PGLite, direct Postgres and PgBouncer; later
 * the engine-sql dialect adapters. A later lane swaps only the
 * `ExecutorUnderTest` factory, never a case or an expectation, so the adapters
 * are proven to bind, count, fail and cancel exactly like the path they replace.
 *
 * Rules the table follows:
 * - Stored and bound values are read back through SQL-side `::text` /
 *   `jsonb_typeof` projections, so the contract pins what the DATABASE saw
 *   (binding), not how each driver decodes result columns.
 * - Where the engines differ on master, the row pins each engine family's
 *   observed outcome (`dialect difference`). A future executor must keep it.
 * - Every case increments a per-backend counter; the last test asserts the
 *   count, so a registration regression cannot pass silently.
 *
 * Callers own engine lifecycle (canonical PGLite block / e2e setupDB) and pass
 * a getter; the scratch table is created and dropped here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { messages } from '@electric-sql/pglite';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SqlExecutor } from '../../src/core/engine-sql/executor.ts';
import { isDeadlockError } from '../../src/core/migrate.ts';

export type BindingBackend = 'pglite' | 'postgres-direct' | 'pgbouncer';
type EngineFamily = 'pglite' | 'postgres';

export interface ExecutorResult {
  rows: Record<string, unknown>[];
  /** Driver-reported affected-row count; `null` when the executor cannot report one. */
  affectedRows: number | null;
}

export interface ExecutorUnderTest {
  run(sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<ExecutorResult>;
  transaction<T>(fn: (tx: ExecutorUnderTest) => Promise<T>): Promise<T>;
  /** Whether `affectedRows` is populated (EO18). The engine-sql adapters must report it on every backend. */
  reportsAffectedRows: boolean;
}

/**
 * Master's path (EO20): `engine.executeRaw`. Postgres returns a postgres.js
 * RowList carrying `.count`; PGLite's executeRaw returns `rows` only, so it
 * cannot report affectedRows and the count rows fall back to RETURNING.
 */
export function executeRawExecutor(engine: BrainEngine, family: EngineFamily): ExecutorUnderTest {
  return {
    reportsAffectedRows: family === 'postgres',
    async run(sql, params, opts) {
      const rows = await engine.executeRaw<Record<string, unknown>>(sql, params, opts);
      const count = (rows as unknown as { count?: unknown }).count;
      return { rows: [...rows], affectedRows: typeof count === 'number' ? count : null };
    },
    transaction(fn) {
      return engine.transaction((tx) => fn(executeRawExecutor(tx, family)));
    },
  };
}

/**
 * The engine-sql dialect adapters (refactor wave 1, C9). Resolves the engine's
 * `engineSql` getter on EVERY call, and `transaction` runs through
 * `engine.transaction()` so the clone's getter yields the transaction handle
 * (EO1). The adapters report `affectedRows` on every backend (EO18).
 */
export function engineSqlExecutor(engine: BrainEngine, family: EngineFamily): ExecutorUnderTest {
  const executor = () => (engine as unknown as { engineSql: SqlExecutor }).engineSql;
  return {
    reportsAffectedRows: true,
    async run(sql, params, opts) {
      const res = await executor().query<Record<string, unknown>>(sql, params, opts);
      return { rows: [...res.rows], affectedRows: res.affectedRows };
    },
    transaction(fn) {
      return engine.transaction((tx) => fn(engineSqlExecutor(tx, family)));
    },
  };
}

const TABLE = 'e5_binding_matrix';
const BIG = 9007199254740993n; // 2^53 + 1: not representable as a JS number
const INSTANT = new Date('2026-03-08T10:30:45.123Z');

interface CaseContext {
  exec: ExecutorUnderTest;
  family: EngineFamily;
}

interface MatrixCase {
  name: string;
  run(ctx: CaseContext): Promise<void>;
}

function driverErrorClass(family: EngineFamily): new (...args: never[]) => Error {
  return (family === 'pglite' ? messages.DatabaseError : postgres.PostgresError) as unknown as new (
    ...args: never[]
  ) => Error;
}

async function captureError(p: () => Promise<unknown>): Promise<unknown> {
  try {
    await p();
  } catch (err) {
    return err;
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

function expectDriverError(err: unknown, family: EngineFamily, code: string, message: string): void {
  const cls = driverErrorClass(family);
  expect(err).toBeInstanceOf(cls);
  expect((err as Error).constructor).toBe(cls);
  expect((err as { code?: unknown }).code).toBe(code);
  expect((err as Error).message).toBe(message);
}

function expectAbortError(err: unknown): void {
  expect(err).toBeInstanceOf(DOMException);
  expect((err as DOMException).name).toBe('AbortError');
  expect((err as DOMException).message).toBe('aborted');
}

async function expectCount(
  exec: ExecutorUnderTest,
  sql: string,
  params: unknown[],
  expected: { affected: number; returned?: number },
): Promise<void> {
  const res = await exec.run(sql, params);
  expect(res.rows.length).toBe(expected.returned ?? 0);
  if (exec.reportsAffectedRows) expect(res.affectedRows).toBe(expected.affected);
}

async function tableCount(exec: ExecutorUnderTest, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const res = await exec.run(`SELECT count(*)::int AS n FROM ${TABLE} WHERE ${where}`, params);
  return Number(res.rows[0]?.n);
}

const BINDING_CASES: MatrixCase[] = [
  {
    name: 'text[] binds every element verbatim (comma, quote, backslash, empty, unicode)',
    async run({ exec }) {
      const value = ['a', 'b,c', 'd"e', 'f\\g', '', 'caf\u00e9'];
      const res = await exec.run('SELECT $1::text[] AS v, cardinality($1::text[]) AS n', [value]);
      expect(res.rows).toEqual([{ v: value, n: value.length }]);
    },
  },
  {
    name: 'empty text[] binds as an empty array, not NULL',
    async run({ exec }) {
      const res = await exec.run(
        'SELECT $1::text[]::text AS v, cardinality($1::text[]) AS n, $1::text[] IS NULL AS isnull',
        [[]],
      );
      expect(res.rows).toEqual([{ v: '{}', n: 0, isnull: false }]);
    },
  },
  {
    name: 'int[] and empty int[]',
    async run({ exec }) {
      const res = await exec.run('SELECT $1::int[]::text AS v, $2::int[]::text AS e', [[1, -2, 3], []]);
      expect(res.rows).toEqual([{ v: '{1,-2,3}', e: '{}' }]);
    },
  },
  {
    name: 'real[] and empty real[]',
    async run({ exec }) {
      const res = await exec.run('SELECT $1::real[]::text AS v, $2::real[]::text AS e', [[1.5, -0.25], []]);
      expect(res.rows).toEqual([{ v: '{1.5,-0.25}', e: '{}' }]);
    },
  },
  {
    name: 'JSONB object binds from a raw JS object',
    async run({ exec }) {
      const res = await exec.run('SELECT $1::jsonb::text AS v, jsonb_typeof($1::jsonb) AS t', [
        { a: 1, b: [1, 'x'], c: null, d: { e: 'caf\u00e9' } },
      ]);
      expect(res.rows).toEqual([{ v: '{"a": 1, "b": [1, "x"], "c": null, "d": {"e": "caf\u00e9"}}', t: 'object' }]);
    },
  },
  {
    name: 'JSONB array binds from a raw JS array',
    async run({ exec }) {
      const res = await exec.run('SELECT $1::jsonb::text AS v, jsonb_typeof($1::jsonb) AS t', [[1, 'x', { k: true }]]);
      expect(res.rows).toEqual([{ v: '[1, "x", {"k": true}]', t: 'array' }]);
    },
  },
  {
    name: 'JSONB array binds through $N::text::jsonb from serialized text',
    async run({ exec }) {
      const res = await exec.run('SELECT $1::text::jsonb::text AS v, jsonb_typeof($1::text::jsonb) AS t', [
        JSON.stringify([1, 'x']),
      ]);
      expect(res.rows).toEqual([{ v: '[1, "x"]', t: 'array' }]);
    },
  },
  {
    name: 'bigint above 2^53 binds exactly through an explicit ::bigint cast',
    async run({ exec }) {
      const res = await exec.run(
        'SELECT $1::bigint::text AS v, pg_typeof($1::bigint)::text AS t, $2::bigint::text AS m',
        [BIG, -9223372036854775808n],
      );
      expect(res.rows).toEqual([{ v: '9007199254740993', t: 'bigint', m: '-9223372036854775808' }]);
    },
  },
  {
    name: 'Date binds as its UTC instant (millisecond precision)',
    async run({ exec }) {
      const res = await exec.run(
        `SELECT to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS s,
                (extract(epoch FROM $1::timestamptz) * 1000)::bigint::text AS ms`,
        [INSTANT],
      );
      expect(res.rows).toEqual([{ s: '2026-03-08T10:30:45.123', ms: String(INSTANT.getTime()) }]);
    },
  },
  {
    name: 'null binds as SQL NULL for text, jsonb and arrays',
    async run({ exec }) {
      const res = await exec.run(
        'SELECT $1::text IS NULL AS t, $2::jsonb IS NULL AS j, $3::text[] IS NULL AS a',
        [null, null, null],
      );
      expect(res.rows).toEqual([{ t: true, j: true, a: true }]);
    },
  },
  {
    name: 'boolean true and false',
    async run({ exec }) {
      const res = await exec.run('SELECT ($1::boolean)::text AS t, ($2::boolean)::text AS f', [true, false]);
      expect(res.rows).toEqual([{ t: 'true', f: 'false' }]);
    },
  },
  {
    name: 'vector literal binds as text and casts to vector',
    async run({ exec }) {
      const res = await exec.run('SELECT $1::vector::text AS v, vector_dims($1::vector) AS d', ['[1,2.5,-3]']);
      expect(res.rows).toEqual([{ v: '[1,2.5,-3]', d: 3 }]);
    },
  },
  {
    name: 'uncast params infer their type from the target columns on INSERT',
    async run({ exec }) {
      await exec.run(
        `INSERT INTO ${TABLE} (k, ta, ia, ra, j, ja, b, d, flag, v, note)
         VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10, $11)`,
        ['row-typed', ['x', 'y'], [7, 8], [0.5], { z: 1 }, JSON.stringify(['q']), BIG, INSTANT, true, '[0,1,2]', null],
      );
      const res = await exec.run(
        `SELECT ta::text AS ta, ia::text AS ia, ra::text AS ra, j::text AS j, jsonb_typeof(j) AS jt,
                ja::text AS ja, jsonb_typeof(ja) AS jat, b::text AS b,
                to_char(d AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS d,
                flag::text AS flag, v::text AS v, note IS NULL AS note_null
         FROM ${TABLE} WHERE k = $1`,
        ['row-typed'],
      );
      expect(res.rows).toEqual([
        {
          ta: '{x,y}', ia: '{7,8}', ra: '{0.5}', j: '{"z": 1}', jt: 'object', ja: '["q"]', jat: 'array',
          b: '9007199254740993', d: '2026-03-08T10:30:45.123', flag: 'true', v: '[0,1,2]', note_null: true,
        },
      ]);
    },
  },
  {
    name: 'dialect difference: an uncast JS bigint (PGLite rejects it, Postgres binds it)',
    async run({ exec, family }) {
      if (family === 'pglite') {
        const err = await captureError(() => exec.run('SELECT $1 AS v', [BIG]));
        expect((err as Error).constructor).toBe(Error);
        expect((err as Error).message).toBe('Invalid input for string type');
        return;
      }
      const res = await exec.run('SELECT $1::text AS v', [BIG]);
      expect(res.rows).toEqual([{ v: '9007199254740993' }]);
    },
  },
  {
    name: 'dialect difference: JSON.stringify into $N::jsonb (the #2339 class: Postgres stores a string scalar)',
    async run({ exec, family }) {
      const res = await exec.run('SELECT jsonb_typeof($1::jsonb) AS t', [JSON.stringify({ a: 1 })]);
      expect(res.rows).toEqual([{ t: family === 'pglite' ? 'object' : 'string' }]);
    },
  },
];

const COUNT_CASES: MatrixCase[] = [
  {
    name: 'affectedRows: INSERT ... RETURNING reports the inserted row',
    async run({ exec }) {
      await expectCount(exec, `INSERT INTO ${TABLE} (k) VALUES ($1) RETURNING k`, ['count-a'], { affected: 1, returned: 1 });
    },
  },
  {
    name: 'affectedRows: an UPDATE matching nothing reports 0 (with and without RETURNING)',
    async run({ exec }) {
      await expectCount(exec, `UPDATE ${TABLE} SET note = $1 WHERE k = $2`, ['n', 'count-none'], { affected: 0 });
      await expectCount(exec, `UPDATE ${TABLE} SET note = $1 WHERE k = $2 RETURNING k`, ['n', 'count-none'], {
        affected: 0,
      });
    },
  },
  {
    name: 'affectedRows: an UPDATE over an empty ANY($n) array reports 0',
    async run({ exec }) {
      await expectCount(exec, `UPDATE ${TABLE} SET note = $1 WHERE k = ANY($2::text[])`, ['n', []], { affected: 0 });
    },
  },
  {
    name: 'affectedRows: a conflict-skipped INSERT ... ON CONFLICT DO NOTHING reports 0',
    async run({ exec }) {
      await expectCount(exec, `INSERT INTO ${TABLE} (k) VALUES ($1) ON CONFLICT DO NOTHING`, ['count-a'], { affected: 0 });
      await expectCount(exec, `INSERT INTO ${TABLE} (k) VALUES ($1) ON CONFLICT DO NOTHING RETURNING k`, ['count-a'], {
        affected: 0,
      });
    },
  },
  {
    name: 'affectedRows: a mixed batch counts only the rows that were not conflict-skipped',
    async run({ exec }) {
      await expectCount(
        exec,
        `INSERT INTO ${TABLE} (k) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING RETURNING k`,
        [['count-a', 'count-b', 'count-c']],
        { affected: 2, returned: 2 },
      );
      expect(await tableCount(exec, 'k = ANY($1::text[])', [['count-a', 'count-b', 'count-c']])).toBe(3);
    },
  },
  {
    name: 'affectedRows: an UPDATE and a DELETE over a partially matching array',
    async run({ exec }) {
      await expectCount(exec, `UPDATE ${TABLE} SET note = $1 WHERE k = ANY($2::text[])`, ['u', ['count-b', 'count-x']], {
        affected: 1,
      });
      await expectCount(exec, `DELETE FROM ${TABLE} WHERE k = ANY($1::text[])`, [['count-b', 'count-c', 'count-y']], {
        affected: 2,
      });
      expect(await tableCount(exec, 'k = ANY($1::text[])', [['count-b', 'count-c']])).toBe(0);
    },
  },
];

const ERROR_CASES: MatrixCase[] = [
  {
    name: 'error pass-through: 23505 unique violation keeps class, code and message; executor stays usable',
    async run({ exec, family }) {
      await exec.run(`INSERT INTO ${TABLE} (k) VALUES ($1)`, ['dup']);
      const err = await captureError(() => exec.run(`INSERT INTO ${TABLE} (k) VALUES ($1)`, ['dup']));
      expectDriverError(err, family, '23505', `duplicate key value violates unique constraint "${TABLE}_pkey"`);
      expect(await tableCount(exec, 'k = $1', ['dup'])).toBe(1);
    },
  },
  {
    name: 'error pass-through: 57014 statement cancel keeps class, code and message',
    async run({ exec, family }) {
      const err = await captureError(() =>
        exec.run(
          "DO $$ BEGIN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = '57014'; END $$",
        ),
      );
      expectDriverError(err, family, '57014', 'canceling statement due to statement timeout');
    },
  },
  {
    name: 'error pass-through: a real statement_timeout inside engine.transaction (PGLite does not enforce it)',
    async run({ exec, family }) {
      const attempt = () =>
        exec.transaction(async (tx) => {
          await tx.run("SET LOCAL statement_timeout = '50ms'");
          await tx.run('SELECT pg_sleep(0.3)');
          return 'completed';
        });
      if (family === 'pglite') {
        expect(await attempt()).toBe('completed');
        return;
      }
      expectDriverError(await captureError(attempt), family, '57014', 'canceling statement due to statement timeout');
    },
  },
  {
    name: 'error pass-through: a deadlock-shaped 40P01 keeps class, code and message and satisfies isDeadlockError',
    async run({ exec, family }) {
      const sql = "DO $$ BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$";
      const err = await captureError(() => exec.run(sql));
      expectDriverError(err, family, '40P01', 'deadlock detected');
      expect(isDeadlockError(err)).toBe(true);
      const inTx = await captureError(() => exec.transaction((tx) => tx.run(sql)));
      expectDriverError(inTx, family, '40P01', 'deadlock detected');
      expect(isDeadlockError(inTx)).toBe(true);
    },
  },
  {
    name: 'error pass-through: a driver error inside engine.transaction propagates unwrapped and rolls back',
    async run({ exec, family }) {
      const err = await captureError(() =>
        exec.transaction(async (tx) => {
          await tx.run(`INSERT INTO ${TABLE} (k) VALUES ($1)`, ['tx-dup-new']);
          await tx.run(`INSERT INTO ${TABLE} (k) VALUES ($1)`, ['dup']);
        }),
      );
      expectDriverError(err, family, '23505', `duplicate key value violates unique constraint "${TABLE}_pkey"`);
      expect(await tableCount(exec, 'k = $1', ['tx-dup-new'])).toBe(0);
    },
  },
];

const ABORT_CASES: MatrixCase[] = [
  {
    name: 'abort: a pre-aborted signal rejects with AbortError before running',
    async run({ exec }) {
      const controller = new AbortController();
      controller.abort();
      expectAbortError(
        await captureError(() => exec.run(`INSERT INTO ${TABLE} (k) VALUES ($1)`, ['pre-aborted'], { signal: controller.signal })),
      );
      expect(await tableCount(exec, 'k = $1', ['pre-aborted'])).toBe(0);
    },
  },
  {
    name: 'abort: a pre-aborted signal inside engine.transaction rejects and rolls back earlier writes',
    async run({ exec }) {
      const controller = new AbortController();
      controller.abort();
      const err = await captureError(() =>
        exec.transaction(async (tx) => {
          await tx.run(`INSERT INTO ${TABLE} (k) VALUES ($1)`, ['tx-pre-aborted']);
          await tx.run('SELECT 1', [], { signal: controller.signal });
        }),
      );
      expectAbortError(err);
      expect(await tableCount(exec, 'k = $1', ['tx-pre-aborted'])).toBe(0);
    },
  },
  {
    name: 'abort: a mid-query abort inside engine.transaction rejects, rolls back, and the executor is reusable',
    async run({ exec, family }) {
      const err = await captureError(() =>
        exec.transaction(async (tx) => {
          await tx.run(`INSERT INTO ${TABLE} (k) VALUES ($1)`, ['tx-mid-abort']);
          const controller = new AbortController();
          // PGLite runs a statement synchronously inside WASM, so a timer cannot
          // fire mid-statement (and the sleep blocks the thread either way);
          // abort while the promise is pending instead.
          const seconds = family === 'pglite' ? 0.2 : 5;
          const pending = tx.run('SELECT pg_sleep($1::float8)', [seconds], { signal: controller.signal });
          if (family === 'pglite') controller.abort();
          else setTimeout(() => controller.abort(), 150);
          await pending;
        }),
      );
      if (family === 'pglite') expectAbortError(err);
      else expectDriverError(err, family, '57014', 'canceling statement due to user request');
      expect(await tableCount(exec, 'k = $1', ['tx-mid-abort'])).toBe(0);
      const after = await exec.run('SELECT $1::int + 1 AS v', [41]);
      expect(after.rows).toEqual([{ v: 42 }]);
    },
  },
];

export const EXECUTOR_BINDING_MATRIX: readonly MatrixCase[] = [
  ...BINDING_CASES,
  ...COUNT_CASES,
  ...ERROR_CASES,
  ...ABORT_CASES,
];

/**
 * Register the matrix for one backend. `getEngine` is read after the caller's
 * own beforeAll has connected; `makeExecutor` defaults to master's executeRaw path.
 */
export function defineExecutorBindingMatrix(opts: {
  backend: BindingBackend;
  getEngine: () => BrainEngine;
  makeExecutor?: (engine: BrainEngine, family: EngineFamily) => ExecutorUnderTest;
  /** Suffix naming a non-default executor in the describe title. */
  executorName?: string;
}): void {
  const family: EngineFamily = opts.backend === 'pglite' ? 'pglite' : 'postgres';
  const makeExecutor = opts.makeExecutor ?? executeRawExecutor;
  let executed = 0;
  let exec: ExecutorUnderTest;

  const title = `E5 executor binding matrix [${opts.backend}]${opts.executorName ? ` (${opts.executorName})` : ''}`;
  describe(title, () => {
    beforeAll(async () => {
      exec = makeExecutor(opts.getEngine(), family);
      await exec.run(`DROP TABLE IF EXISTS ${TABLE}`);
      await exec.run(
        `CREATE TABLE ${TABLE} (
           k text PRIMARY KEY, ta text[], ia int[], ra real[], j jsonb, ja jsonb, b bigint,
           d timestamptz, flag boolean, v vector(3), note text
         )`,
      );
    });

    afterAll(async () => {
      if (exec) await exec.run(`DROP TABLE IF EXISTS ${TABLE}`);
    });

    for (const c of EXECUTOR_BINDING_MATRIX) {
      test(c.name, async () => {
        await c.run({ exec, family });
        executed++;
      });
    }

    test(`executed all ${EXECUTOR_BINDING_MATRIX.length} matrix cases on ${opts.backend}`, () => {
      expect(executed).toBe(EXECUTOR_BINDING_MATRIX.length);
    });
  });
}
