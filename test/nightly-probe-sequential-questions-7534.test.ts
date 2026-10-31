/**
 * #7534: the nightly probe's judge batch runs one question at a time. Every
 * judge call reserves its worst case against the run cap before it settles,
 * so three questions in flight held nine worst-case judge reservations at
 * once, and a cap that pays for the whole probe sequentially refused judges
 * before they reached the provider. Each question's three judges still run
 * together, and the cap still bounds the run.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCrossModalBatchForProbe } from '../src/core/cycle/nightly-probe-adapters.ts';
import type { NightlyProbeModelRoutes } from '../src/core/cycle/nightly-probe-routes.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, withBudgetTracker, type ChatResult } from '../src/core/ai/gateway.ts';
import { BudgetTracker, type BudgetEstimate, type BudgetReservation } from '../src/core/budget/budget-tracker.ts';
import { reservationCostUsd } from '../src/core/budget/reservation-cost.ts';

const JUDGES = ['anthropic:claude-haiku-4-5', 'anthropic:claude-sonnet-4-6', 'anthropic:claude-opus-4-7'];
const ROUTES: NightlyProbeModelRoutes = {
  reader: { model: JUDGES[0]!, source: 'tier_config' },
  extractor: { model: JUDGES[0]!, source: 'tier_config' },
  slots: { A: JUDGES[0], B: JUDGES[1], C: JUDGES[2] },
};
const QUESTIONS = 4;

let dir: string;
let calls: string[];
let inFlight = 0;
let peakInFlight = 0;

class MeasuringTracker extends BudgetTracker {
  refused = 0;
  override reserve(estimate: BudgetEstimate): BudgetReservation | undefined {
    try {
      return super.reserve(estimate);
    } catch (err) {
      this.refused++;
      throw err;
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'probe-7534-'));
  calls = [];
  inFlight = 0;
  peakInFlight = 0;
  configureGateway({ env: {} });
  __setChatTransportForTests(async (opts) => {
    calls.push(opts.model!);
    peakInFlight = Math.max(peakInFlight, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, 15));
    inFlight--;
    const text = JSON.stringify({ scores: { correctness: { score: 9, feedback: 'ok' }, directness: { score: 9, feedback: 'ok' } }, overall: 9, improvements: [] });
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model!, providerId: 'anthropic' } satisfies ChatResult;
  });
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  rmSync(dir, { recursive: true, force: true });
});

test('#7534: a cap that pays for one question\'s judges at a time judges every question; each question\'s judges run together', async () => {
  const batchPath = join(dir, 'lme.jsonl');
  writeFileSync(batchPath, Array.from({ length: QUESTIONS }, (_, i) =>
    JSON.stringify({ question_id: `q${i}`, question: `Where did alice-example live in year ${i}?`, hypothesis: 'widget-co', answer: 'widget-co' })).join('\n') + '\n');

  // The worst case one question's three judges reserve, measured on an uncapped run of one question.
  const probe = new BudgetTracker({ label: 'measure' });
  const measured: number[] = [];
  const reserve = probe.reserve.bind(probe);
  probe.reserve = (estimate: BudgetEstimate) => {
    measured.push(reservationCostUsd(estimate.modelId, estimate.kind, estimate.estimatedInputTokens, estimate.maxOutputTokens)!);
    return reserve(estimate);
  };
  const one = join(dir, 'one.jsonl');
  writeFileSync(one, JSON.stringify({ question_id: 'q', question: 'Where did alice-example live in year 0?', hypothesis: 'widget-co', answer: 'widget-co' }) + '\n');
  await withBudgetTracker(probe, () => runCrossModalBatchForProbe({ batchPath: one, summaryPath: join(dir, 'one.json'), maxUsd: 100, modelRoutes: ROUTES }));
  expect(measured).toHaveLength(3);
  const oneQuestion = measured.reduce((a, b) => a + b, 0);

  calls = [];
  peakInFlight = 0;
  const tracker = new MeasuringTracker({ label: 'nightly_quality_probe', maxCostUsd: oneQuestion * 1.5 });
  const { summary } = await withBudgetTracker(tracker, () =>
    runCrossModalBatchForProbe({ batchPath, summaryPath: join(dir, 'summary.json'), maxUsd: oneQuestion * 1.5, modelRoutes: ROUTES }));
  expect(tracker.refused).toBe(0);
  expect(calls).toHaveLength(QUESTIONS * 3);
  expect(summary.error_count).toBe(0);
  expect(peakInFlight).toBe(3);
});
