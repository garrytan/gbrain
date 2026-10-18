/**
 * B5 benefit-gate harness (evals/pinned-questions/benefit-gate.ts), offline
 * only: the seeded workload is byte-identical per seed, the lifecycle
 * accounting adds up (pinned = pin + every refresh attempt + delivered read
 * tokens), the break-even read count follows the formula, the pinned arm
 * never serves a superseded value, and a paid run refuses without --yes and
 * a sufficient --max-usd. No network; paid runs are scheduled by the parent.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { estimatePlan, generateWorkload, offlineArms, runGate, workloadHash } from '../evals/pinned-questions/benefit-gate.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';

describe('pinned-question benefit gate (offline plumbing)', () => {
  test('the workload is deterministic per seed and corrections change gold values', () => {
    const a = generateWorkload(7, 3, 3);
    expect(workloadHash(a)).toBe(workloadHash(generateWorkload(7, 3, 3)));
    expect(workloadHash(a)).not.toBe(workloadHash(generateWorkload(8, 3, 3)));
    expect(a.batches[0]!.every(w => w.kind === 'create')).toBe(true);
    expect(a.batches.slice(1).flat().every(w => w.kind === 'correct')).toBe(true);
  });

  test('lifecycle dollars add up, the pinned arm never serves a superseded value, break-even follows the formula', async () => {
    const workload = generateWorkload(11, 2, 3);
    const report = await runGate({ workload, readsPerWrite: 2, answerModel: MODEL, readerModel: MODEL, ...offlineArms(MODEL, MODEL) });
    const [pinned, query, think] = report.arms;
    expect(report.arms.map(a => a.arm)).toEqual(['pinned', 'query_reader', 'think']);
    for (const a of report.arms) expect(a.reads).toBe(2 * 3 * 2);
    expect(pinned!.stale_wrong).toBe(0);
    expect(pinned!.usd).toBeCloseTo(report.pinned_breakdown.pin_and_refresh_usd + report.pinned_breakdown.read_usd, 9);
    expect(report.pinned_breakdown.refresh_attempts).toBeGreaterThanOrEqual(2);
    expect(report.pinned_breakdown.pin_and_refresh_usd).toBeGreaterThan(0);
    const perQuery = query!.usd / query!.reads;
    const perPinnedRead = report.pinned_breakdown.read_usd / pinned!.reads;
    expect(report.break_even_reads).toBe(perQuery > perPinnedRead ? Math.ceil(report.pinned_breakdown.pin_and_refresh_usd / (perQuery - perPinnedRead)) : null);
    expect(think!.usd).toBeGreaterThan(0);
  }, 120_000);

  test('--plan estimates without spending; --run refuses without --yes and a covering --max-usd', async () => {
    const plan = estimatePlan(generateWorkload(42), MODEL, MODEL);
    expect(plan.reads).toBe(12);
    expect(plan.est_usd[10]).toBeGreaterThan(plan.est_usd[1]!);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'evals', 'pinned-questions', 'benefit-gate.ts'), '--run', '--max-usd', '0.01'],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    expect(await proc.exited).toBe(3);
    expect(await new Response(proc.stderr).text()).toContain('Refusing a paid run');
  }, 60_000);
});
