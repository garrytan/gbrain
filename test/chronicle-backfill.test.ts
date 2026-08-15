/**
 * v0.42.x — Life Chronicle (#2390) backfill op (Phase A.8).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const mkCtx = (): OperationContext => ({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext);
const LONG = 'B'.repeat(120);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'chronicle_extract'`);
  await engine.executeRaw(`DELETE FROM pages WHERE type IN ('meeting','diary')`);
});

describe('chronicle_backfill op', () => {
  test('dry-run counts eligible meetings without enqueuing', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    await engine.putPage('life/diary/d1', { type: 'diary', title: 'd1', compiled_truth: LONG }); // excluded
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), { dry_run: true }) as { eligible: number; enqueued: number };
    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(0);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(Number(jobs[0].n)).toBe(0);
  });

  test('enqueues one chronicle_extract per eligible meeting', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), {}) as { eligible: number; enqueued: number; errors: unknown[] };
    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(2);
    expect(r.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(Number(jobs[0].n)).toBe(2);
  });
});
