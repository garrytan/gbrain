/**
 * Canonical graduation digests (src/core/persistence/graduation-digest.ts).
 *
 * Protects: identical content gives identical per-batch and root digests on
 * PGLite (C collation) and on a Postgres database created with en_US.utf8,
 * including text keys that differ only by case, '-' versus '_', spaces and
 * non-ASCII; every column type gbrain uses renders canonically (jsonb,
 * vector/halfvec, timestamptz in UTC ISO, bytea hex, arrays, tsvector,
 * numeric, floats, generated columns); the root does not depend on batch size;
 * transforms change only the source side and never a key column; row filters
 * apply to both sides.
 * Fails when: a digest picks up the database collation, the session time zone
 * or float settings, or a value's driver-specific JS type.
 * Runs on PGLite; the cross-engine comparison runs when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ColumnMeta, InventoryEntry } from '../src/core/persistence/engine-graduation.types.ts';
import { canonicalRowText, digestTable, jsonbText, tableColumns } from '../src/core/persistence/graduation-digest.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

let engine: PGLiteEngine;
let pg: PostgresEngine | undefined;
let dropPostgres: (() => Promise<void>) | undefined;

const KEYS = ['Alpha', 'alpha', 'a-b', 'a_b', 'a b', 'ab', 'Zeta', 'zeta', 'é', 'e', 'ünïcode', 'Ω', '日本', 'a-c', 'a_c'];

const CREATE = `CREATE TABLE graduation_digest_probe (
  k text PRIMARY KEY, j jsonb, v vector(3), h halfvec(3), ts timestamptz, b bytea, ta text[], ia integer[], ua uuid[],
  tv tsvector, n numeric(10,4), nn numeric, r real, d double precision, dt date, bo boolean, bi bigint, si smallint, u uuid,
  g integer GENERATED ALWAYS AS (octet_length(k)) STORED)`;

async function seed(target: BrainEngine): Promise<void> {
  await target.executeRaw(CREATE);
  for (const [i, k] of KEYS.entries()) {
    await target.executeRaw(`INSERT INTO graduation_digest_probe (k,j,v,h,ts,b,ta,ia,ua,tv,n,nn,r,d,dt,bo,bi,si,u)
      VALUES ($1::text, $2::text::jsonb, $3::text::vector, $3::text::halfvec, $4::text::timestamptz, decode($5::text,'hex'), $6::text::text[],
        $7::text::integer[], $8::text::uuid[], to_tsvector('simple', $9::text), $10::text::numeric, $11::text::numeric, $12::text::real,
        $13::text::double precision, $14::text::date, $15::text::boolean, $16::text::bigint, $17::text::smallint, $18::text::uuid)`, [
      k,
      JSON.stringify({ zeta: i, a: [1, 'x', null], nested: { yy: 1.5, b: 'ü' }, [k]: true }),
      `[${i + 0.1},${-1.5e-7 * (i + 1)},${1 / 3}]`,
      `2026-10-04 12:34:56.${String(123456 + i).padStart(6, '0')}+05:30`,
      `deadbeef${i.toString(16).padStart(2, '0')}`,
      `{"x y","","NULL","q\\"t","é",${i}}`,
      `{${i},${-i},NULL}`,
      `{00000000-0000-4000-8000-${String(i).padStart(12, '0')}}`,
      `The quick brown fox ${k} jumps ${i}`,
      `${i}.5000`,
      i % 2 ? '1e20' : '-0.000001000',
      `${0.1 * (i + 1)}`,
      `${1 / (i + 3)}`,
      `2026-02-${String((i % 28) + 1).padStart(2, '0')}`,
      String(i % 2 === 0),
      String(9007199254740993n + BigInt(i)),
      String(-i),
      `00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`,
    ]);
  }
  await target.executeRaw("INSERT INTO graduation_digest_probe (k) VALUES ('all-null')");
}

const PROBE: InventoryEntry = {
  relation: 'graduation_digest_probe', kind: 'table', class: 'carry', engines: { pglite: true, postgres: true, rust: false },
  lossKind: 'user_data', transforms: [], reason: 'test probe',
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seed(engine);
  if (!process.env.DATABASE_URL) return;
  assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
  const name = `gbrain_test_digest_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'`);
  dropPostgres = async () => { await pg?.disconnect(); await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); };
  const url = new URL(process.env.DATABASE_URL); url.pathname = `/${name}`;
  pg = new PostgresEngine();
  await pg.connect({ database_url: url.toString(), poolSize: 1 });
  await pg.executeRaw('CREATE EXTENSION IF NOT EXISTS vector');
  await seed(pg);
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  await dropPostgres?.();
});

describe('canonicalRowText', () => {
  const col = (name: string, type: string): ColumnMeta => ({ name, type, category: 'U', collatable: false, generated: false });

  test('timestamptz text and Date render the same UTC ISO instant', () => {
    const columns = [col('ts', 'timestamp with time zone')];
    expect(canonicalRowText({ ts: '2026-10-04 07:04:56.12+00' }, columns)).toBe('["2026-10-04T07:04:56.12Z"]');
    expect(canonicalRowText({ ts: new Date('2026-10-04T07:04:56.120Z') }, columns)).toBe('["2026-10-04T07:04:56.12Z"]');
    expect(canonicalRowText({ ts: '2026-10-04 12:34:56+05:30' }, columns)).toBe('["2026-10-04T07:04:56Z"]');
    expect(canonicalRowText({ ts: 'infinity' }, columns)).toBe('["infinity"]');
  });

  test('jsonb objects render like jsonb text output, bytea as hex, arrays as literals, nulls as null', () => {
    expect(jsonbText({ bb: 1, a: [1, 'x', null], ccc: { z: true, y: 'ü' } })).toBe('{"a": [1, "x", null], "bb": 1, "ccc": {"y": "ü", "z": true}}');
    expect(canonicalRowText({ j: { b: 1, a: 2 } }, [col('j', 'jsonb')])).toBe(canonicalRowText({ j: '{"a": 2, "b": 1}' }, [col('j', 'jsonb')]));
    expect(canonicalRowText({ b: new Uint8Array([0xde, 0xad]) }, [col('b', 'bytea')])).toBe('["\\\\xdead"]');
    expect(canonicalRowText({ a: ['x y', '', 'NULL', null, 'q"t'] }, [col('a', 'text[]')])).toBe(JSON.stringify(['{"x y","","NULL",NULL,"q\\"t"}']));
    expect(canonicalRowText({ x: null, y: undefined, n: 12n, f: false }, [col('x', 'text'), col('y', 'text'), col('n', 'bigint'), col('f', 'boolean')]))
      .toBe('[null,null,"12","f"]');
  });
});

describe('digestTable', () => {
  test('the root is independent of batch size; batches are keyset pages in C order', async () => {
    const whole = await digestTable(engine, PROBE);
    const paged = await digestTable(engine, PROBE, { batchRows: 4 });
    expect(paged.rootSha256).toBe(whole.rootSha256);
    expect(paged.rows).toBe(KEYS.length + 1);
    expect(paged.batches.map(b => b.rows)).toEqual([4, 4, 4, 4]);
    const sorted = [...KEYS, 'all-null'].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(paged.batches.map(b => JSON.parse(b.lastKey)[0])).toEqual([sorted[3], sorted[7], sorted[11], sorted[15]]);
  });

  test('a changed value or row changes the digest; transforms apply only when asked and never to keys', async () => {
    const before = await digestTable(engine, PROBE, { batchRows: 4 });
    const transformed = { ...PROBE, transforms: [{ column: 'bo', rule: 'cleared', expression: 'NULL' }] };
    expect((await digestTable(engine, transformed, { batchRows: 4 })).rootSha256).toBe(before.rootSha256);
    const applied = await digestTable(engine, transformed, { batchRows: 4, applyTransforms: true });
    expect(applied.rootSha256).not.toBe(before.rootSha256);
    await expect(digestTable(engine, { ...PROBE, transforms: [{ column: 'k', rule: 'x', expression: "'x'" }] }, { applyTransforms: true }))
      .rejects.toThrow(/primary-key column/);
    await engine.executeRaw("UPDATE graduation_digest_probe SET nn = nn + 0 WHERE k='Zeta'");
    expect((await digestTable(engine, PROBE, { batchRows: 4 })).rootSha256).toBe(before.rootSha256);
    await engine.executeRaw("UPDATE graduation_digest_probe SET j = j || '{\"edited\": 1}' WHERE k='Zeta'");
    try {
      const edited = await digestTable(engine, PROBE, { batchRows: 4 });
      expect(edited.rootSha256).not.toBe(before.rootSha256);
      expect(edited.batches.filter((b, i) => b.sha256 !== before.batches[i]!.sha256)).toHaveLength(1);
    } finally { await engine.executeRaw("UPDATE graduation_digest_probe SET j = j - 'edited' WHERE k='Zeta'"); }
    expect((await digestTable(engine, PROBE, { batchRows: 4 })).rootSha256).toBe(before.rootSha256);
  });

  test('a row filter scopes the digest', async () => {
    const filtered = await digestTable(engine, { ...PROBE, rowFilter: "k <> 'all-null'" });
    expect(filtered.rows).toBe(KEYS.length);
  });

  test.skipIf(!process.env.DATABASE_URL)('identical content digests identically on PGLite and on an en_US.utf8 Postgres', async () => {
    const [{ collate }] = await pg!.executeRaw<{ collate: string }>('SELECT datcollate AS collate FROM pg_database WHERE datname=current_database()');
    expect(collate).toBe('en_US.utf8');
    const native = (await pg!.executeRaw<{ k: string }>('SELECT k FROM graduation_digest_probe ORDER BY k')).map(r => r.k);
    const c = (await pg!.executeRaw<{ k: string }>('SELECT k FROM graduation_digest_probe ORDER BY k COLLATE "C"')).map(r => r.k);
    expect(native).not.toEqual(c);
    expect(await tableColumns(pg!, PROBE.relation)).toEqual(await tableColumns(engine, PROBE.relation));
    for (const batchRows of [1, 4, 1000]) {
      const lite = await digestTable(engine, PROBE, { batchRows });
      const server = await digestTable(pg!, PROBE, { batchRows });
      expect(server).toEqual(lite);
    }
    await pg!.executeRaw("SET TimeZone = 'America/Los_Angeles'");
    try { expect(await digestTable(pg!, PROBE, { batchRows: 4 })).toEqual(await digestTable(engine, PROBE, { batchRows: 4 })); }
    finally { await pg!.executeRaw('RESET TimeZone'); }
  });
});
