/**
 * #4482 — doctor's extract_health treated EXPECTED budget/deadline cap stops
 * as extraction failures: extract-conversation-facts recorded
 * halted=budget_exhausted and propose-takes folded budget/deadline/global-
 * error into one halt_delta, so a brain whose backlog is simply bigger than
 * one run's per-source budget WARN'd "halt rate > 10%" under completely
 * normal, self-resolving operation — indistinguishable from a provider/auth
 * failure.
 *
 * Fix shape (per the issue's acceptance criteria):
 *  - migration adds an orthogonal `expected_limit_count` to extract_rollup_7d;
 *  - `classifyRunStop` (shared, pure) splits cap-only stops from error halts;
 *  - both extractors write cap stops as expected_limit_delta, errors as
 *    halt_delta;
 *  - doctor's failure rate excludes caps (they join the denominator as
 *    successful partial runs) while cap-hits stay observable per-kind;
 *  - old rows (expected_limit_count=0 default) keep today's semantics.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { upsertExtractRollup, classifyRunStop } from '../src/core/extract/rollup-writer.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('classifyRunStop (#4482)', () => {
  test('clean completion', () => {
    expect(classifyRunStop({})).toEqual({
      round_completed_delta: 1, halt_delta: 0, expected_limit_delta: 0,
    });
  });

  test('budget cap only → expected limit, NOT a halt', () => {
    expect(classifyRunStop({ budget_exhausted: true })).toEqual({
      round_completed_delta: 0, halt_delta: 0, expected_limit_delta: 1,
    });
  });

  test('deadline cap only → expected limit, NOT a halt', () => {
    expect(classifyRunStop({ deadline_hit: true })).toEqual({
      round_completed_delta: 0, halt_delta: 0, expected_limit_delta: 1,
    });
  });

  test('global error → halt, unchanged from today', () => {
    expect(classifyRunStop({ error: true })).toEqual({
      round_completed_delta: 0, halt_delta: 1, expected_limit_delta: 0,
    });
  });

  test('cap AND error → halt wins (an error is present)', () => {
    expect(classifyRunStop({ budget_exhausted: true, error: true })).toEqual({
      round_completed_delta: 0, halt_delta: 1, expected_limit_delta: 0,
    });
  });
});

describe('extract_rollup_7d.expected_limit_count (#4482)', () => {
  test('halt reasons increment atomically and omitted reasons reconcile as unknown', async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d');
    await upsertExtractRollup(engine, {
      kind: 'atoms', source_id: 'default', halt_delta: 1, halt_reason: 'provider_auth',
    });
    await upsertExtractRollup(engine, { kind: 'atoms', source_id: 'default', halt_delta: 1 });
    await upsertExtractRollup(engine, {
      kind: 'atoms', source_id: 'default', halt_delta: 2, halt_reason: 'provider_auth',
    });
    const [row] = await engine.executeRaw<{
      halt_count: number; halt_reasons: Record<string, number> | string;
    }>(`SELECT halt_count, halt_reasons FROM extract_rollup_7d WHERE kind='atoms'`);
    const reasons = typeof row!.halt_reasons === 'string'
      ? JSON.parse(row!.halt_reasons) as Record<string, number>
      : row!.halt_reasons;
    expect(Number(row!.halt_count)).toBe(4);
    expect(reasons).toEqual({ provider_auth: 3, unknown: 1 });
    expect(Object.values(reasons).reduce((sum, count) => sum + Number(count), 0)).toBe(Number(row!.halt_count));
  });

  test('a pre-v166 brain without halt_reasons still records the counters', async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d');
    await engine.executeRaw('ALTER TABLE extract_rollup_7d DROP COLUMN halt_reasons');
    try {
      const res = await upsertExtractRollup(engine, {
        kind: 'atoms', source_id: 'default', halt_delta: 1, halt_reason: 'provider_auth',
      });
      expect(res.ok).toBe(true);
      const [row] = await engine.executeRaw<{ halt_count: number }>(
        `SELECT halt_count FROM extract_rollup_7d WHERE kind='atoms'`,
      );
      expect(Number(row!.halt_count)).toBe(1);
    } finally {
      await engine.executeRaw(
        `ALTER TABLE extract_rollup_7d ADD COLUMN IF NOT EXISTS halt_reasons JSONB NOT NULL DEFAULT '{}'::jsonb`,
      );
      await engine.executeRaw('DELETE FROM extract_rollup_7d');
    }
  });

  test('migration added the column and the writer records the delta', async () => {
    const res = await upsertExtractRollup(engine, {
      kind: 'facts.conversation',
      source_id: 'default',
      expected_limit_delta: 1,
    });
    expect(res.ok).toBe(true);
    const rows = await engine.executeRaw<{ expected_limit_count: number; halt_count: number }>(
      `SELECT expected_limit_count, halt_count FROM extract_rollup_7d
        WHERE kind = 'facts.conversation' AND source_id = 'default'`);
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.expected_limit_count)).toBe(1);
    expect(Number(rows[0]!.halt_count)).toBe(0);
  });

  test('doctor: cap-only stops do NOT raise the failure warning; error halts still do', async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d');
    // Kind A: 5 runs, ALL stopped at the expected budget cap. Normal
    // backlog-bigger-than-budget operation — must not warn.
    for (let i = 0; i < 5; i++) {
      await upsertExtractRollup(engine, {
        kind: 'facts.conversation', source_id: 'default', expected_limit_delta: 1,
      });
    }
    let check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('ok');

    // Kind B: real error halts past the 10% threshold — still warns.
    await upsertExtractRollup(engine, {
      kind: 'takes.proposed', source_id: 'default', halt_delta: 1,
    });
    await upsertExtractRollup(engine, {
      kind: 'takes.proposed', source_id: 'default', round_completed_delta: 1,
    });
    check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('takes.proposed');
    expect(check.message).not.toContain('facts.conversation');
  });

  test('caps join the failure-rate denominator (errors amid many caps stay proportionate)', async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d');
    // 1 error halt + 19 cap stops = 5% failure rate → below the 10% bar.
    await upsertExtractRollup(engine, { kind: 'facts.conversation', source_id: 'default', halt_delta: 1 });
    for (let i = 0; i < 19; i++) {
      await upsertExtractRollup(engine, { kind: 'facts.conversation', source_id: 'default', expected_limit_delta: 1 });
    }
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('ok');
    const kinds = (check.details as { kinds: Array<Record<string, unknown>> }).kinds;
    const kind = kinds.find(k => k.kind === 'facts.conversation')!;
    // Cap-hits stay observable as a capacity signal.
    expect(Number(kind.expected_limit_count)).toBe(19);
  });
});
