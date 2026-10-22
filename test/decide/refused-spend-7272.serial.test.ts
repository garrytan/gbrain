/** #7272: explicit provider refusals must not poison daily or enclosing budgets.
 * Own process: gateway transport/config and buffered decide store are process-wide.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests, withBudgetTracker } from '../../src/core/ai/gateway.ts';
import { runDecide } from '../../src/core/ai/decide/index.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { dailySpend, flushDecideWrites, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { rerankViaDecide } from '../../src/core/ai/decide/rerank-adapter.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { usageCostUsd } from '../../src/core/budget/reservation-cost.ts';
import { estimateContextTokens, planBatches } from '../../src/core/ai/decide/pack.ts';
import { toWireQuestion } from '../../src/core/ai/decide/providers/typesafe.ts';
import { buildStatus, cmdProbe, loadDecideState, runDecideCommand } from '../../src/commands/decide.ts';
import { decideHealthEntry } from '../../src/commands/doctor/checks/decide.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';

let engine: PGLiteEngine;
const provider = 'typesafe:jev-1.13.0';
const cfg = readDecideConfig({ 'decide.provider': provider, 'decide.egress.typesafe.query': 'allow', 'decide.budget.daily_usd': '0.001', 'decide.budget.remote_share': '1' });
const req = { slot: 'triage' as const, callSite: 'test', state: {}, remote: true, questions: [{ id: 'q', kind: 'noul' as const, instructions: 'Is this useful?', inputs: { q: { text: 'hello', class: 'query' as const } } }] };
const refuse = (status: number) => new Response('private evidence must not escape', { status });
function answer(init: RequestInit, tokens = 100) {
  const body = JSON.parse(init.body as string);
  return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: tokens }, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.8 }])) });
}
async function rows() {
  await flushDecideWrites();
  return engine.executeRaw<{ input_tokens: number; cost_usd: number; outcome: string }>('SELECT input_tokens, cost_usd, outcome FROM decide_spend');
}
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test' } });
});
afterEach(async () => {
  await flushDecideWrites();
  __setDecideTransportForTests(null);
  resetGateway();
  __resetDecideStoreForTests();
});
afterAll(async () => { await engine.disconnect(); });

describe('refused TypeSafe spend', () => {
  test('repeated billing refusals do not exhaust a one-request daily cap; real spend still does', async () => {
    const estimate = planBatches(estimateContextTokens(req.state), req.questions.map(q => estimateContextTokens(toWireQuestion(q))))[0]!.estimatedInputTokens;
    const cap = usageCostUsd(provider, estimate, 0, 'decide')! * 1.1;
    const config = { ...cfg, dailyUsd: cap };
    let calls = 0;
    __setDecideTransportForTests(async () => { calls++; return refuse(402); });
    for (let i = 0; i < 5; i++) await expect(runDecide(req, { engine, config })).rejects.toMatchObject({ reason: 'provider_error', status: 402 });
    expect(calls).toBe(5);
    expect(await dailySpend(engine)).toEqual({ total: 0, remote: 0 });
    __setDecideTransportForTests(async (_url, init) => { calls++; return answer(init, estimate); });
    await runDecide(req, { engine, config });
    await expect(runDecide(req, { engine, config })).rejects.toMatchObject({ reason: 'budget_exhausted' });
    expect(calls).toBe(6);
  });

  test('a refused batch does not erase a successful in-flight sibling charge or its partial answers', async () => {
    let calls = 0;
    __setDecideTransportForTests(async (_url, init) => ++calls === 1 ? answer(init) : refuse(402));
    const questions = Array.from({ length: 5 }, (_, i) => ({ ...req.questions[0]!, id: `q${i}`, inputs: { q: { text: '1234567890'.repeat(1500), class: 'query' as const } } }));
    const tracker = new BudgetTracker({ maxCostUsd: 1, auditPath: '/dev/null', label: 'refused-spend' });
    await expect(withBudgetTracker(tracker, () => runDecide({ ...req, questions }, { engine, config: { ...cfg, dailyUsd: 1 } })))
      .rejects.toMatchObject({ status: 402, partial: { model_resolved: 'jev-1.13.0' } });
    expect(calls).toBe(2);
    expect((await rows()).map(r => r.input_tokens).sort((a, b) => a - b)).toEqual([0, 100]);
    expect((await dailySpend(engine)).total).toBeCloseTo(usageCostUsd(provider, 100, 0, 'decide')!, 12);
    expect(tracker.totalSpent).toBeCloseTo((await dailySpend(engine)).total, 12);
  });

  for (const status of [400, 401, 402, 403, 404, 422, 429]) {
    test(`HTTP ${status} retains failure evidence but charges zero in both budgets`, async () => {
      __setDecideTransportForTests(async () => refuse(status));
      const tracker = new BudgetTracker({ maxCostUsd: 1, auditPath: '/dev/null', label: 'refused-spend' });
      for (let i = 0; i < 3; i++) {
        await expect(withBudgetTracker(tracker, () => runDecide(req, { engine, config: cfg })))
          .rejects.toMatchObject({ status });
      }
      const stored = await rows();
      expect(stored).toHaveLength(3);
      for (const row of stored) expect({ ...row, cost_usd: Number(row.cost_usd) }).toEqual({ input_tokens: 0, cost_usd: 0, outcome: 'failed' });
      expect(await dailySpend(engine)).toEqual({ total: 0, remote: 0 });
      expect(tracker.totalSpent).toBe(0);
      __setDecideTransportForTests(async (_url, init) => answer(init));
      const r = await withBudgetTracker(tracker, () => runDecide(req, { engine, config: cfg }));
      expect(r.usage.input_tokens).toBe(100);
      expect((await dailySpend(engine)).total).toBeCloseTo(r.cost_usd, 12);
      expect(tracker.totalSpent).toBeCloseTo(r.cost_usd, 12);
    });
  }

  test('a 429 retry charges only the successful attempt in both budgets', async () => {
    let calls = 0;
    __setDecideTransportForTests(async (_url, init) => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : answer(init));
    const tracker = new BudgetTracker({ maxCostUsd: 1, auditPath: '/dev/null', label: 'refused-spend' });
    const r = await withBudgetTracker(tracker, () => runDecide(req, { engine, config: cfg }));
    expect(calls).toBe(2);
    expect((await rows()).map(r => r.input_tokens).sort((a, b) => a - b)).toEqual([0, 100]);
    expect(tracker.totalSpent).toBeCloseTo(r.cost_usd, 12);
    expect((await dailySpend(engine)).remote).toBeCloseTo(r.cost_usd, 12);
  });

  for (const status of [408, 500, 503]) {
    test(`uncertain HTTP ${status} still retains the pessimistic estimate`, async () => {
      __setDecideTransportForTests(async () => refuse(status));
      const tracker = new BudgetTracker({ maxCostUsd: 1, auditPath: '/dev/null', label: 'refused-spend' });
      await expect(withBudgetTracker(tracker, () => runDecide(req, { engine, config: cfg }))).rejects.toMatchObject({ status });
      const [row] = await rows();
      expect(row!.input_tokens).toBeGreaterThan(0);
      expect(tracker.totalSpent).toBeCloseTo(Number(row!.cost_usd), 12);
    });
  }

  test('transport failures and malformed successful responses remain charged', async () => {
    for (const transport of [async () => { throw new TypeError('offline'); }, async () => new Response('not JSON')]) {
      __setDecideTransportForTests(transport);
      await expect(runDecide(req, { engine, config: { ...cfg, dailyUsd: 1 } })).rejects.toBeInstanceOf(Error);
    }
    expect((await rows()).every(r => r.input_tokens > 0 && Number(r.cost_usd) > 0)).toBe(true);
    expect(await rows()).toHaveLength(2);
  });

  for (const status of [402, 429, 503]) {
    test(`reranker settles HTTP ${status} with the same refusal policy`, async () => {
      const tracker = new BudgetTracker({ maxCostUsd: 1, auditPath: '/dev/null', label: 'refused-spend' });
      await expect(rerankViaDecide({ query: 'q', documents: ['document'] }, {
        model: provider, modelId: 'jev-1.13.0', url: 'https://example.test/systemone', headers: {}, maxPayloadBytes: 1_000_000,
        defaultTimeoutMs: 1000, tracker, transport: async () => refuse(status),
      })).rejects.toBeInstanceOf(Error);
      if (status < 500) expect(tracker.totalSpent).toBe(0);
      else expect(tracker.totalSpent).toBeGreaterThan(0);
    });
  }

  test('status and doctor name provider errors and suggest a probe, even with an exhausted historical budget', async () => {
    await engine.setConfig('decide.budget.daily_usd', '0');
    await engine.executeRaw(`INSERT INTO decision_receipts (decision_id,slot,mode,provider,outcome,call_site,lane,error_reason) VALUES ('d','triage','on',$1,'error','triage','background','provider_error')`, [provider]);
    const status = await buildStatus(engine, await loadDecideState(engine));
    expect(status.slots.find(s => s.slot === 'triage')).toMatchObject({ errors_by_reason_24h: [{ reason: 'provider_error', count: 1 }], error_fix: 'gbrain decide probe' });
    const checks = await decideHealthEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
    expect(checks[0]!.message).toContain('provider_error');
    expect(checks[0]!.message).toContain('gbrain decide probe');
    expect(checks[0]!.message).toContain('budget exhausted');
    const output: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
    const error = spyOn(console, 'error').mockImplementation((...args) => { output.push(args.join(' ')); });
    try {
      expect(await runDecideCommand(engine, ['status'])).toBe(0);
      expect(output.join('\n')).toContain('provider_error=1; gbrain decide probe');
      __setDecideTransportForTests(async () => refuse(402));
      expect(await cmdProbe(engine, [])).toBe(1);
      expect(output.join('\n')).toContain('HTTP 402');
      expect(output.join('\n')).not.toContain('private evidence');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
