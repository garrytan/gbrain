/**
 * #7542: `cycle.grade_takes.auto_resolve.enabled` is the operator opt-in the
 * grade_takes phase documents (src/core/cycle/grade-takes.ts,
 * skills/conventions/calibration.md).
 *
 * Protects: with the key on, the scheduled phase applies a verdict at or above
 * the 0.95 confidence threshold to the take; unset (the default) or off, every
 * verdict stays review-only; the threshold is unchanged.
 * Fails when: the phase or the cycle ignores the key, so the documented opt-in
 * never resolves a take.
 * Why new: grade-takes tests pass `autoResolve` directly, so nothing ran the
 * config path the cycle uses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runPhaseGradeTakes, type EvidenceRetrieverFn, type JudgeFn } from '../src/core/cycle/grade-takes.ts';

const KEY = 'cycle.grade_takes.auto_resolve.enabled';
let engine: PGLiteEngine;
let n = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM take_grade_cache');
  await engine.executeRaw('DELETE FROM takes');
  await engine.executeRaw('DELETE FROM config WHERE key = $1', [KEY]);
});

const seedTake = async () => {
  const page = await engine.putPage(`notes/auto-resolve-${++n}`, { type: 'note', title: 'Auto resolve', compiled_truth: 'Seed page.', timeline: '' });
  await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'acme-example ships by 2020', kind: 'bet' as const, holder: 'alice-example', weight: 0.6, since_date: '2019-01-01' }]);
};
const ctx = (): OperationContext => ({ engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'default' });
const grade = async (confidence: number) => {
  const judge: JudgeFn = async () => ({ verdict: 'correct', confidence, reasoning: 'stub' });
  const evidenceRetriever: EvidenceRetrieverFn = async () => 'evidence';
  const result = await runPhaseGradeTakes(ctx(), { judge, evidenceRetriever, model: 'anthropic:claude-sonnet-4-6' });
  const [take] = await engine.executeRaw<{ resolved_quality: string | null }>('SELECT resolved_quality FROM takes');
  return { details: result.details as Record<string, unknown>, quality: take!.resolved_quality };
};

describe('grade_takes reads cycle.grade_takes.auto_resolve.enabled (#7542)', () => {
  test('unset: the verdict is review-only and the take stays unresolved', async () => {
    await seedTake();
    const { details, quality } = await grade(0.99);
    expect(details.auto_resolve).toBe(false);
    expect(details.auto_applied).toBe(0);
    expect(quality).toBeNull();
  });

  test('false: the verdict is review-only', async () => {
    await engine.setConfig(KEY, 'false');
    await seedTake();
    const { details, quality } = await grade(0.99);
    expect(details.auto_applied).toBe(0);
    expect(quality).toBeNull();
  });

  test('true: a verdict at or above 0.95 resolves the take', async () => {
    await engine.setConfig(KEY, 'true');
    await seedTake();
    const { details, quality } = await grade(0.97);
    expect(details.auto_resolve).toBe(true);
    expect(details.auto_resolve_threshold).toBe(0.95);
    expect(details.auto_applied).toBe(1);
    expect(quality).toBe('correct');
  });

  test('true: a verdict below 0.95 stays review-only', async () => {
    await engine.setConfig(KEY, 'true');
    await seedTake();
    const { details, quality } = await grade(0.9);
    expect(details.auto_applied).toBe(0);
    expect(quality).toBeNull();
  });

  test('the scheduled cycle carries the key into the phase', async () => {
    const phase = async () => (await runCycle(engine, { brainDir: null, phases: ['grade_takes'] } as never)).phases.find(p => p.phase === 'grade_takes')!;
    expect((await phase()).details).toMatchObject({ auto_resolve: false });
    await engine.setConfig(KEY, 'true');
    expect((await phase()).details).toMatchObject({ auto_resolve: true, auto_resolve_threshold: 0.95 });
  });
});
