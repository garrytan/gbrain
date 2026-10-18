/** Protects SQLSTATE + exact object compatibility and non-retrying failure diagnostics.
 * Driver-shaped errors cover metadata variants unavailable from one local backend; a
 * wrapped error without a SQLSTATE is accepted only on the exact PostgreSQL diagnostic.
 * Real SQL errors/old schemas are exercised in extract-rollup-schema-errors.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkSyncFreshness, computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readRecordedHaltReasons7d, upsertExtractRollup } from '../src/core/extract/rollup-writer.ts';
import { isMissingSchemaObject } from '../src/core/utils.ts';

let real: PGLiteEngine;
beforeAll(async () => { real = new PGLiteEngine(); await real.connect({}); await real.initSchema(); }, 60_000);
afterAll(async () => { await real.disconnect(); });

function throwingEngine(error: unknown): BrainEngine {
  return { executeRaw: async () => { throw error; } } as unknown as BrainEngine;
}

test('reader propagates non-schema errors and contradictory missing-column identities', async () => {
  for (const fields of [
    { code: '42501', message: 'permission denied for halt_reasons diagnostic' },
    { code: '22P02', message: 'invalid input syntax for integer: "halt_reasons"' },
    { code: '42703', message: 'column r.other_halt_reasons does not exist' },
    { code: '42703', message: 'column r.halt_reasons does not exist', column_name: 'other' },
    { code: '42703', message: 'column r.halt_reasons does not exist', column: 'other' },
    { code: '42703', message: 'column r.halt_reasons does not exist', column_name: 'halt_reasons', column: 'other' },
    { message: 'permission denied for column halt_reasons' },
    { code: '08006', message: 'column r.halt_reasons does not exist' },
  ]) {
    const error = Object.assign(new Error(fields.message), fields);
    await expect(readRecordedHaltReasons7d(throwingEngine(error))).rejects.toBe(error);
    expect((await computeExtractHealthCheck(throwingEngine(error))).status).toBe('warn');
  }
});

test('reader accepts exact driver metadata and PostgreSQL/PGLite missing-column messages', async () => {
  for (const fields of [
    { code: '42703', message: 'column r.halt_reasons does not exist' },
    { code: '42703', message: 'column "halt_reasons" does not exist', column: 42 },
    { code: '42703', message: 'localized diagnostic', column_name: 'halt_reasons' },
    { code: '42703', message: 'localized diagnostic', column: 'halt_reasons' },
    { message: 'column r.halt_reasons does not exist' },
    { message: 'column "halt_reasons" of relation "extract_rollup_7d" does not exist' },
  ]) {
    expect((await readRecordedHaltReasons7d(throwingEngine(Object.assign(new Error(fields.message), fields)))).size).toBe(0);
  }
});

test('doctor only treats the exact missing rollup relation as old schema', async () => {
  for (const fields of [
    { code: '42P01', message: 'relation "extract_rollup_7d" does not exist', expected: 'ok' },
    { code: '42P01', message: 'localized diagnostic', table_name: 'extract_rollup_7d', expected: 'ok' },
    { code: '42P01', message: 'relation "other_extract_rollup_7d" does not exist', expected: 'warn' },
    { code: '42P01', message: 'relation "extract_rollup_7d" does not exist', table_name: 'other', expected: 'warn' },
    { code: '42P01', message: 'relation "extract_rollup_7d" does not exist', table: 'other', expected: 'warn' },
    { code: '22P02', message: 'invalid input syntax for integer: "no such table"', expected: 'warn' },
    { code: '42501', message: 'relation "extract_rollup_7d" does not exist', expected: 'warn' },
  ] as const) {
    expect((await computeExtractHealthCheck(throwingEngine(Object.assign(new Error(fields.message), fields)))).status).toBe(fields.expected);
  }
});

test('writer does not downgrade or retry a real error mentioning an old column', async () => {
  for (const column of ['expected_limit_count', 'halt_reasons']) {
    let calls = 0;
    const error = Object.assign(new Error(`permission denied for ${column} diagnostic`), { code: '42501' });
    const engine = { executeRaw: async () => { if (++calls === 1) throw error; return []; } } as unknown as BrainEngine;
    expect(await upsertExtractRollup(engine, { kind: `denied-${column}`, source_id: 'default', halt_delta: 1 })).toEqual({ ok: false, error: error.message });
    expect(calls).toBe(1);
  }
});

test('doctor does not retry an aggregate failure that only mentions expected_limit_count', async () => {
  let calls = 0;
  const engine = { executeRaw: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('permission denied for expected_limit_count'), { code: '42501' });
    return [];
  } } as unknown as BrainEngine;
  expect((await computeExtractHealthCheck(engine)).status).toBe('warn');
  expect(calls).toBe(1);
});

test('isMissingSchemaObject needs the named object and the matching SQLSTATE', () => {
  const err = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message)), fields);
  expect(isMissingSchemaObject(err({ code: '42P01', message: 'relation "persistence_worktrees" does not exist' }), 'table', ['persistence_brain', 'persistence_worktrees'])).toBe(true);
  expect(isMissingSchemaObject(err({ code: '42P01', message: 'relation "public.extract_rollup_7d" does not exist' }), 'table', 'extract_rollup_7d')).toBe(true);
  expect(isMissingSchemaObject(err({ message: 'relation "extract_rollup_7d" does not exist' }), 'table', 'extract_rollup_7d')).toBe(true);
  expect(isMissingSchemaObject(err({ code: '42P01', message: 'relation "pages" does not exist' }), 'table', 'extract_rollup_7d')).toBe(false);
  expect(isMissingSchemaObject(err({ code: '42703', message: 'relation "extract_rollup_7d" does not exist' }), 'table', 'extract_rollup_7d')).toBe(false);
  expect(isMissingSchemaObject(err({ code: '42P01', message: 'relation "extract_rollup_7d" does not exist' }), 'column', 'extract_rollup_7d')).toBe(false);
  expect(isMissingSchemaObject(err({ message: 'something about extract_rollup_7d does not exist yet' }), 'table', 'extract_rollup_7d')).toBe(false);
  expect(isMissingSchemaObject('relation "extract_rollup_7d" does not exist', 'table', 'extract_rollup_7d')).toBe(false);
});

test('sync freshness surfaces real errors from the owned-content probe instead of skipping it', async () => {
  await real.executeRaw(`INSERT INTO sources (id, name, local_path, last_sync_at) VALUES ('w17-fresh', 'w17-fresh', '/tmp/w17-fresh', now())`);
  const failing = (error: Error) => new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== 'executeRaw') return Reflect.get(target, prop, receiver);
      return async (sql: string, params?: unknown[]) => {
        if (sql.includes('persistence_source_bindings')) throw error;
        return target.executeRaw(sql, params as never);
      };
    },
  }) as BrainEngine;
  const denied = Object.assign(new Error('role "gbrain_reader" does not exist'), { code: '42704' });
  const deniedCheck = await checkSyncFreshness(failing(denied));
  expect(deniedCheck.message).toContain('role "gbrain_reader" does not exist');
  const missing = Object.assign(new Error('relation "persistence_worktrees" does not exist'), { code: '42P01' });
  const oldCheck = await checkSyncFreshness(failing(missing));
  expect(oldCheck.message).not.toContain('Could not');
});
