/** Protects SQLSTATE + exact object compatibility and non-retrying failure diagnostics.
 * Driver-shaped errors cover metadata variants unavailable from one local backend.
 * Real SQL errors/old schemas are exercised in extract-rollup-schema-errors.test.ts.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { readRecordedHaltReasons7d, upsertExtractRollup } from '../src/core/extract/rollup-writer.ts';

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
    { message: 'column r.halt_reasons does not exist' },
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
