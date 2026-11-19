/**
 * #7112: every statement that normalizes `sources.config` used the SQL/JSON `IS JSON` predicate, and the doctor and
 * repair-jsonb damage probes used pg_input_is_valid(); both are Postgres 16+, so on Postgres 15 each of those statements
 * was a syntax error (42601) and managed sync could never publish its checkpoint. gbrain_try_jsonb (schema.sql, v263)
 * replaces both on every supported server. It also closes a hole IS JSON left open: text that is valid json but not
 * valid jsonb (a \\u0000 escape) passed the predicate and then failed the cast, so the guarded UPDATE raised anyway.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetDreamBreakerKey, DREAM_BREAKER_RESETS_KEY } from '../src/core/cycle/dream-breaker.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { repairJsonb } from '../src/commands/repair-jsonb.ts';
import * as db from '../src/core/db.ts';

const SOURCE = 'cfg-7112';
const NUL_OBJECT = '{"label":"\\u0000"}';

for (const kind of testBackends()) describe(`portable jsonb guard (${kind})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  let databaseUrl = '';
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close, databaseUrl } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT (id) DO NOTHING', [SOURCE]);
  }, 120_000);
  afterAll(async () => { await close?.(); });

  async function configAfterPatch(stored: string): Promise<Record<string, unknown>> {
    await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [SOURCE, stored]);
    expect(await engine.updateSourceConfig(SOURCE, { patched: true })).toBe(true);
    const [row] = await engine.executeRaw<{ config: Record<string, unknown> | string }>('SELECT config FROM sources WHERE id=$1', [SOURCE]);
    return typeof row!.config === 'string' ? JSON.parse(row!.config) : row!.config;
  }

  test('gbrain_try_jsonb parses valid jsonb and returns NULL for anything the jsonb cast refuses', async () => {
    const [row] = await engine.executeRaw<Record<string, unknown>>(
      `SELECT gbrain_try_jsonb('{"a":[1,"x"]}')::text AS object, gbrain_try_jsonb('"s"')::text AS scalar, gbrain_try_jsonb('[INFO] fetch complete') AS log_line,
              gbrain_try_jsonb($1) AS nul_escape, gbrain_try_jsonb(NULL) AS null_input`, [NUL_OBJECT]);
    expect(JSON.parse(row!.object as string)).toEqual({ a: [1, 'x'] });
    expect(JSON.parse(row!.scalar as string)).toBe('s');
    expect(row!.log_line).toBeNull();
    expect(row!.nul_escape).toBeNull();
    expect(row!.null_input).toBeNull();
  });

  test('a config merge unwraps a double-encoded object, merges array fragments and keeps going past unparseable text', async () => {
    expect(await configAfterPatch(JSON.stringify(JSON.stringify({ federated: true })))).toEqual({ federated: true, patched: true });
    expect(await configAfterPatch(JSON.stringify([{ a: 1 }, JSON.stringify({ b: 2 }), 'junk']))).toEqual({ a: 1, b: 2, patched: true });
    expect(await configAfterPatch(JSON.stringify('[INFO] not json'))).toEqual({ patched: true });
  });

  test('a double-encoded config that is json but not jsonb no longer fails the merge', async () => {
    expect(await configAfterPatch(JSON.stringify(NUL_OBJECT))).toEqual({ patched: true });
  });

  test('a dream-breaker reset over a stored value that is json but not jsonb starts a fresh map', async () => {
    await engine.executeRaw('INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [DREAM_BREAKER_RESETS_KEY, NUL_OBJECT]);
    await resetDreamBreakerKey(engine, 'synthesize:cfg-7112');
    const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [DREAM_BREAKER_RESETS_KEY]);
    expect(Object.keys(JSON.parse(row!.value))).toEqual(['synthesize:cfg-7112']);
  });

  if (kind === 'postgres') test('repair-jsonb refuses on a database without gbrain_try_jsonb instead of reporting 0 rows', async () => {
    const engineConfig = { engine: 'postgres' as const, database_url: databaseUrl };
    try {
      expect((await repairJsonb({ dryRun: true, engineConfig })).total_repaired).toBe(0);
      await engine.executeRaw('DROP FUNCTION gbrain_try_jsonb(text)');
      await expect(repairJsonb({ dryRun: true, engineConfig })).rejects.toThrow(/gbrain_try_jsonb[\s\S]*(?:foresights|gbrain) apply-migrations/);
    } finally {
      await db.disconnect();
    }
  });
});

describe('#7112: shipped SQL parses on every supported Postgres (15+)', () => {
  // Postgres 16+ syntax and functions: SQL/JSON predicates, constructors and query functions, ANY_VALUE, the error-safe
  // input functions, and MERGE ... RETURNING (17). PGLite runs Postgres 17 and CI's E2E lanes Postgres 16, so neither sees them fail.
  // The predicate is matched in upper case only, so English text such as "is not JSON" in an error message is not SQL.
  const PG16_PREDICATE = /\bIS\s+(?:NOT\s+)?JSON\b/;
  const PG16_FUNCTION = /\b(?:pg_input_is_valid|pg_input_error_info|JSON_ARRAY|JSON_OBJECT|JSON_ARRAYAGG|JSON_OBJECTAGG|JSON_SCALAR|JSON_SERIALIZE|JSON_EXISTS|JSON_QUERY|JSON_VALUE|JSON_TABLE|ANY_VALUE)\s*\(|\bMERGE\s+INTO\b[\s\S]{0,2000}?\bRETURNING\b/i;
  const pg16Only = (sql: string) => PG16_PREDICATE.test(sql) || PG16_FUNCTION.test(sql);
  const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1').replace(/^\s*--.*$/gm, '');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|sql)$/.test(name) ? [path] : [];
    });
  }

  test('src/ holds no Postgres 16+ only SQL', () => {
    const offenders = files('src').filter(path => pg16Only(stripComments(readFileSync(path, 'utf8'))));
    expect(offenders).toEqual([]);
  });

  test('the guard catches the statement #7112 shipped', () => {
    expect(pg16Only(stripComments("AND (value #>> '{}') IS JSON\n"))).toBe(true);
    expect(pg16Only(stripComments("CASE WHEN config.value IS JSON OBJECT THEN"))).toBe(true);
    expect(pg16Only(stripComments("AND pg_input_is_valid(x, 'jsonb')"))).toBe(true);
    expect(pg16Only(stripComments('// unlike IS JSON\nSELECT 1'))).toBe(false);
    expect(pg16Only(stripComments("throw new Error('the reply is not JSON')"))).toBe(false);
  });
});
