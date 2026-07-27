/**
 * Test: `checkSourceConfigShape` (#2829 — source config string-scalar re-wrapping).
 *
 * Pure-helper surface — the check only consumes `engine.executeRaw`, so a
 * structurally-typed mock satisfies the contract (same pattern as
 * `doctor-child-orphans.test.ts`). No PGLite spin-up required.
 */

import { describe, test, expect } from 'bun:test';
import { checkSourceConfigShape } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/** Build a structurally-typed BrainEngine whose executeRaw returns per-SQL results. */
function makeMockEngine(handler: (sql: string) => Promise<unknown[]>): BrainEngine {
  return {
    executeRaw: handler,
  } as unknown as BrainEngine;
}

describe('checkSourceConfigShape (#2829)', () => {
  test('all configs are objects → status:ok', async () => {
    const engine = makeMockEngine(async () => []);
    const result = await checkSourceConfigShape(engine);
    expect(result.name).toBe('source_config_shape');
    expect(result.status).toBe('ok');
    expect(result.message).toContain('JSON objects');
  });

  test('non-object configs → warn naming affected sources + repair hint', async () => {
    const engine = makeMockEngine(async () => [
      { id: 'default', typ: 'string' },
      { id: 'wiki', typ: 'string' },
    ]);
    const result = await checkSourceConfigShape(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('2 source(s)');
    expect(result.message).toContain('default (string)');
    expect(result.message).toContain('wiki (string)');
    expect(result.message).toContain('#2829');
    // Paste-ready repair SQL is part of the hint.
    expect(result.message).toContain('UPDATE sources SET config');
  });

  test('detection query targets the exact jsonb_typeof predicate', async () => {
    let captured = '';
    const engine = makeMockEngine(async (sql: string) => {
      captured = sql;
      return [];
    });
    await checkSourceConfigShape(engine);
    expect(captured).toContain('jsonb_typeof(config) AS typ');
    expect(captured).toContain("WHERE jsonb_typeof(config) <> 'object'");
  });

  test('engine error → warn, never a false ok', async () => {
    const engine = makeMockEngine(async () => {
      throw new Error('relation "sources" does not exist');
    });
    const result = await checkSourceConfigShape(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Check failed');
  });
});
