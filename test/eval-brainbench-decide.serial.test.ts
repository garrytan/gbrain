/**
 * `gbrain eval brainbench --decide ...` (System One arms) with a fixture
 * decide transport (no provider is called).
 *
 * Protects: the flags parse (and bad values are usage errors); an all-off run
 * adds no decide field to turn rows; an S6 recall_needed arm configures the
 * benchmark brain so the slot acts at the claude-code turn-context seam and
 * each replayed turn carries its `decide.recall_needed` receipt (mode,
 * effective, outcomes, latency, decide tokens); the roll-up summarizes them.
 * Serial: mutates the process-global gateway, transport and GBRAIN_DECIDE_SLOTS.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { _internal } from '../src/commands/eval-brainbench.ts';
import { DEFAULT_FIXTURES_DIR, DEFAULT_GOLD_DIR } from '../src/commands/eval-brainbench.ts';
import { loadCorpus } from '../src/eval/brainbench/fixtures.ts';
import { runBrainBench } from '../src/eval/brainbench/harness.ts';
import { newDecideEvalOptions, applyDecideEvalFlag, prepareDecideEval, summarizeDecideReceipts } from '../src/eval/decide-eval-flags.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../src/core/ai/gateway.ts';
import { enableDecideEvalOverride } from '../src/core/ai/decide/config.ts';
import { __resetDecideStoreForTests } from '../src/core/ai/decide/store.ts';

const prevEnv = process.env.GBRAIN_DECIDE_SLOTS;
let calls = 0;

beforeAll(() => {
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setDecideTransportForTests(async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body as string);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.8 }]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 90, output_tokens: 0 } }));
  });
});

afterAll(() => {
  __setDecideTransportForTests(null);
  resetGateway();
  __resetDecideStoreForTests();
  if (prevEnv === undefined) delete process.env.GBRAIN_DECIDE_SLOTS;
  else process.env.GBRAIN_DECIDE_SLOTS = prevEnv;
  enableDecideEvalOverride(false);
});

describe('eval brainbench --decide', () => {
  test('flags parse; bad values are usage errors', () => {
    const ok = _internal.parseArgs(['--decide', 'recall_needed=on', '--decide-threshold', 'recall_needed=0.5', '--decide-force-on', 'recall_needed']);
    expect('usageError' in ok).toBe(false);
    expect((ok as { decide: unknown }).decide).toMatchObject({ slots: { recall_needed: 'on' }, thresholds: { recall_needed: 0.5 }, forceOn: ['recall_needed'] });
    const bad = _internal.parseArgs(['--decide', 'recall_needed=sometimes']);
    expect((bad as { usageError: string }).usageError).toContain('off|on|shadow');
  });

  test('all-off turn rows carry no decide; an S6 arm stamps per-turn receipts at the claude-code seam', async () => {
    const corpus = await loadCorpus(DEFAULT_FIXTURES_DIR, DEFAULT_GOLD_DIR);
    const base = await runBrainBench(corpus, { harnesses: ['claude-code'], suites: ['know-to-ask'], includeHoldout: false, llm: false });
    expect(base.turn_rows.length).toBeGreaterThan(0);
    expect(base.turn_rows.every((r) => r.decide === undefined)).toBe(true);
    expect(calls).toBe(0);

    const o = newDecideEvalOptions();
    for (const [f, v] of [['--decide', 'recall_needed=on'], ['--decide-threshold', 'recall_needed=0.5'], ['--decide-force-on', 'recall_needed']]) applyDecideEvalFlag(o, f!, v!);
    const decide = prepareDecideEval(o, { command: 'gbrain eval brainbench', throwaway: true })!;
    const arm = await runBrainBench(corpus, { harnesses: ['claude-code'], suites: ['know-to-ask'], includeHoldout: false, llm: false, decide });
    expect(arm.turn_rows.length).toBe(base.turn_rows.length);
    expect(arm.turn_rows.every((r) => r.decide?.recall_needed?.mode === 'on')).toBe(true);
    const acted = arm.turn_rows.filter((r) => r.decide?.recall_needed?.effective === 'on');
    expect(acted.length).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(0);
    expect(acted.some((r) => (r.decide!.recall_needed!.input_tokens ?? 0) > 0)).toBe(true);
    const summary = summarizeDecideReceipts(arm.turn_rows.map((r) => r.decide)) as Record<string, { rows: number }>;
    expect(summary.recall_needed!.rows).toBe(arm.turn_rows.length);
  }, 240_000);
});
