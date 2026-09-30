/**
 * Engine-sql executor contract, no database (refactor wave 1, C9).
 *
 * - `sqlFragment` renders byte-identical text and the same bound values as
 *   the postgres.js tagged template it replaces (rendered by postgres.js's own
 *   vendored serializer through the recording fake), including nested
 *   fragments, trusted text and empty fragments (EO8).
 * - The Postgres adapter drives `runUnsafe` with `{ prepare: true, simple:
 *   false }` for converted statements (zero-param included), keeps master's
 *   raw paths (`executeRaw` counts the `raw` gauge, `unsafe` uses default
 *   driver options) and never touches the gauge otherwise (EO2 / EO9).
 * - `engineSql` is resolved per call, so a transaction clone runs on the
 *   transaction lane (EO1).
 * - Brands: a plain executor is not a ScopedRead / LegacyUnscopedRead
 *   (typecheck fixture, EO4).
 */

import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql } from '../src/core/engine-sql/fragment.ts';
import { jsonbParam, type SqlExecutor } from '../src/core/engine-sql/executor.ts';
import { scopedRead, unscopedExecutor, type LegacyUnscopedRead, type ScopedRead } from '../src/core/engine-sql/brands.ts';
import { makeFakeSql, paramShape } from './helpers/fake-postgres-sql.ts';
import { CheckoutGauge, type GaugeKind } from '../src/core/pool-gauge.ts';

class RecordingGauge extends CheckoutGauge {
  acquired: Partial<Record<GaugeKind, number>> = {};
  override acquire(kind: GaugeKind): void {
    this.acquired[kind] = (this.acquired[kind] ?? 0) + 1;
    super.acquire(kind);
  }
}

function fakeEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine() as any;
  engine._sql = fake.sql;
  engine._connectionStyle = 'instance';
  const gauge = new RecordingGauge();
  engine.checkoutGauge = gauge;
  return { engine, fake, gauge, exec: () => engine.engineSql as SqlExecutor };
}

describe('sqlFragment renders exactly what the postgres.js tagged template sent', () => {
  test('nested fragments, trusted text, empty fragments and repeated values', async () => {
    const fake = makeFakeSql();
    const sql = fake.sql;
    const ids = ['src-a', 'src-b'];
    const prefix = 'people/%';
    const order = 'p.updated_at DESC';
    for (const withPrefix of [true, false]) {
      const tagged = sql`
        SELECT p.slug FROM pages p
         WHERE p.source_id = ANY(${ids}::text[])
           ${withPrefix ? sql`AND p.slug LIKE ${prefix} ESCAPE '\\'` : sql``}
           AND p.deleted_at IS NULL ${sql`AND p.type = ${'person'}`}
         ORDER BY ${sql.unsafe(order)}
         LIMIT ${10}
      `;
      await tagged;
      const fragment = sqlFragment`
        SELECT p.slug FROM pages p
         WHERE p.source_id = ANY(${ids}::text[])
           ${withPrefix ? sqlFragment`AND p.slug LIKE ${prefix} ESCAPE '\\'` : sqlFragment``}
           AND p.deleted_at IS NULL ${sqlFragment`AND p.type = ${'person'}`}
         ORDER BY ${trustedSql(order)}
         LIMIT ${10}
      `;
      const recorded = fake.statements().at(-1)!;
      const rendered = renderFragment(fragment);
      expect(rendered.text).toBe(recorded.text);
      expect(rendered.params).toEqual(recorded.params);
    }
  });

  test('joinFragments numbers placeholders across parts', () => {
    const joined = joinFragments([sqlFragment`a = ${1}`, sqlFragment`b = ${2} AND c = ${3}`, sqlFragment`d`], ' AND ');
    expect(renderFragment(joined)).toEqual({ text: 'a = $1 AND b = $2 AND c = $3 AND d', params: [1, 2, 3] });
    expect(renderFragment(joinFragments([], ', '))).toEqual({ text: '', params: [] });
  });
});

describe('Postgres adapter driver options (EO2 / EO6 / EO9)', () => {
  test('converted statements: prepare:true, simple:false (zero-param included), no gauge', async () => {
    const { fake, gauge, exec } = fakeEngine();
    await exec().query('SELECT 1');
    await exec().query('SELECT $1::int AS v', [1]);
    await exec().run(sqlFragment`SELECT ${'x'}::text AS v`);
    expect(fake.statements().map((s) => ({ via: s.via, opts: s.unsafeOptions, lane: s.lane }))).toEqual([
      { via: 'unsafe', opts: { cancelFence: false, prepare: true, simple: false }, lane: 'pool' },
      { via: 'unsafe', opts: { cancelFence: false, prepare: true, simple: false }, lane: 'pool' },
      { via: 'unsafe', opts: { cancelFence: false, prepare: true, simple: false }, lane: 'pool' },
    ]);
    expect(gauge.acquired).toEqual({});
  });

  test('executeRaw keeps master executeRaw options and counts the raw gauge; unsafe keeps driver defaults', async () => {
    const { engine, fake, gauge, exec } = fakeEngine();
    await exec().executeRaw('SELECT $1::int AS v', [1]);
    await exec().unsafe('SELECT $1::int AS v', [1]);
    await exec().unsafe('SELECT 1', []);
    await engine.executeRaw('SELECT $1::int AS v', [1]);
    const masterExecuteRaw = { cancelFence: false, prepare: false, simple: false };
    expect(fake.statements().map((s) => s.unsafeOptions)).toEqual([
      masterExecuteRaw,
      { prepare: false, simple: false },
      { prepare: false, simple: true },
      masterExecuteRaw,
    ]);
    expect(gauge.acquired).toEqual({ raw: 2 });
    expect(engine.getPoolDiagnostics().tracked).toEqual(new CheckoutGauge().snapshot());
  });

  test('envelope carries rows and the driver count as affectedRows', async () => {
    const fake = makeFakeSql(() => [{ a: 1 }, { a: 2 }]);
    const engine = new PostgresEngine() as any;
    engine._sql = fake.sql;
    engine._connectionStyle = 'instance';
    const res = await (engine.engineSql as SqlExecutor).query('UPDATE t SET a = a RETURNING a');
    expect([...res.rows]).toEqual([{ a: 1 }, { a: 2 }]);
    expect(res.affectedRows).toBe(2);
  });

  test('jsonbParam binds as sql.json (OID 3802) on Postgres', async () => {
    const { fake, exec } = fakeEngine();
    await exec().query('SELECT $1::jsonb AS v', [jsonbParam({ a: 1 })]);
    const stmt = fake.statements()[0];
    expect(paramShape(stmt.params[0], stmt.types[0])).toBe('json');
  });

  test('a pre-aborted signal rejects before the statement reaches the driver', async () => {
    const { fake, exec } = fakeEngine();
    const controller = new AbortController();
    controller.abort();
    await expect(exec().query('SELECT 1', [], { signal: controller.signal })).rejects.toThrow('aborted');
    expect(fake.statements()).toEqual([]);
  });
});

describe('executor lifetime (EO1)', () => {
  test('Postgres: engineSql on a transaction clone runs on the tx lane; the root stays on the pool', async () => {
    const { engine, fake } = fakeEngine();
    await engine.transaction(async (tx: any) => {
      await (tx.engineSql as SqlExecutor).query('SELECT 1');
      await (tx.engineSql as SqlExecutor).transaction((inner) => inner.query('SELECT 2'));
    });
    await (engine.engineSql as SqlExecutor).query('SELECT 3');
    expect(fake.trace.map((t) => (t.kind === 'query' ? `${t.lane}:${t.text}` : `${t.lane}:${t.event}`))).toEqual([
      'tx:begin', 'tx:SELECT 1', 'tx>sp:savepoint', 'tx>sp:SELECT 2', 'tx>sp:savepoint-release', 'tx:commit', 'pool:SELECT 3',
    ]);
  });

  test('engineSql is a getter that builds a new adapter per access (never stored)', () => {
    for (const Engine of [PostgresEngine, PGLiteEngine]) {
      const desc = Object.getOwnPropertyDescriptor(Engine.prototype, 'engineSql');
      expect(typeof desc?.get).toBe('function');
      expect(desc?.value).toBeUndefined();
    }
    const { engine } = fakeEngine();
    expect(engine.engineSql).not.toBe(engine.engineSql);
    expect(Object.keys(engine)).not.toContain('engineSql');
  });
});

describe('RLS brands (EO4)', () => {
  function readScoped(exec: ScopedRead): string { return exec.dialect; }
  function readLegacy(exec: LegacyUnscopedRead): string { return exec.dialect; }

  test('factories brand without wrapping; a plain executor does not typecheck', () => {
    const { exec } = fakeEngine();
    const plain = exec();
    expect(readScoped(scopedRead(plain))).toBe('postgres');
    expect(readLegacy(unscopedExecutor(plain, 'test: brand fixture'))).toBe('postgres');
    // @ts-expect-error a plain SqlExecutor is not a ScopedRead (obtain via withScopedReadTransaction)
    readScoped(plain);
    // @ts-expect-error a plain SqlExecutor is not a LegacyUnscopedRead (obtain via unscopedExecutor)
    readLegacy(plain);
    // @ts-expect-error the two brands are not interchangeable
    readScoped(unscopedExecutor(plain, 'test: brand fixture'));
  });
});
