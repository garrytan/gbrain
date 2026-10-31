import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCrossModalBatchForProbe } from '../src/core/cycle/nightly-probe-adapters.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, withBudgetTracker } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

test('all three questions retain three judges within the run cap as completed reservations settle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b336-probe-reservations-'));
  const models = ['acme-local:judge-a', 'acme-local:judge-b', 'acme-local:judge-c'];
  const pricingOverrides = Object.fromEntries(models.map(model => [model, { input: 1, output: 100 }]));
  const tracker = new BudgetTracker({ label: 'nightly-regression', maxCostUsd: 1.4, capSource: 'user', pricingOverrides });
  let calls = 0;
  const text = JSON.stringify({ scores: { CORRECTNESS: { score: 10 }, DIRECTNESS: { score: 10 } }, improvements: [] });
  configureGateway({ chat_model: models[0], env: {} });
  __setChatTransportForTests(async opts => {
    calls++;
    // Keep each question's three reservations outstanding long enough to
    // detect the former nine-call admission burst through the real tracker.
    await new Promise(resolve => setTimeout(resolve, 20));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model!, providerId: 'acme-local' };
  });
  try {
    const batchPath = join(dir, 'questions.jsonl');
    writeFileSync(batchPath, [1, 2, 3].map(n => JSON.stringify({ question_id: `q${n}`, question: 'Where?', hypothesis: 'widget-co', answer: 'widget-co' })).join('\n') + '\n');
    const result = await withEnv({ GBRAIN_HOME: dir }, () => withBudgetTracker(tracker, () => runCrossModalBatchForProbe({
      batchPath, summaryPath: join(dir, 'summary.json'), maxUsd: 1.4,
      modelRoutes: { reader: { model: models[0]!, source: 'tier_config' }, extractor: { model: models[0]!, source: 'tier_config' },
        slots: { A: models[0], B: models[1], C: models[2] } },
    })));
    expect(calls).toBe(9);
    expect(result.summary.pass_count).toBe(3);
    expect(result.summary.panel?.slot_scored_questions).toEqual([3, 3, 3]);
    expect(tracker.snapshot().cumulativeCostUsd).toBeLessThan(1.4);
  } finally {
    __setChatTransportForTests(null); resetGateway();
    const trash = join(homedir(), '.Trash'); mkdirSync(trash, { recursive: true });
    renameSync(dir, join(trash, `b336-probe-test-${randomUUID()}`));
  }
});
