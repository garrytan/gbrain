/**
 * Nightly quality probe: one run-level budget over both stages (CEO B4),
 * the pricing policy for that cap, and the receipts a non-pass run keeps
 * (#5506).
 *
 * Protects: the LongMemEval stage spends against the same cap as the
 * judges; a budget stop before judging makes no judge call; a budget stop
 * is `budget_exceeded`, never `fail`; a default cap runs an unpriced model
 * with a warning, a configured (user) cap refuses it with the shared
 * no_pricing guidance unless `pricing.overrides` prices it; a non-pass run
 * keeps its summary and LongMemEval output under the audit dir, newest 7.
 * Fails when: the LongMemEval stage runs outside the tracker (master ran it
 * uncapped), a budget stop reads as fail, or receipts are deleted.
 * Seams: the gateway's test chat transport (reserve/record run for real),
 * GBRAIN_AUDIT_DIR per test, DI stubs for the two stages.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveProbeCap,
  runNightlyQualityProbe,
  type NightlyProbeDeps,
} from '../src/core/cycle/nightly-quality-probe.ts';
import { readRecentQualityProbeEvents } from '../src/core/audit-quality-probe.ts';
import {
  __setChatTransportForTests,
  chat,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { _resetBudgetTrackerWarningsForTest } from '../src/core/budget/budget-tracker.ts';
import { withEnv } from './helpers/with-env.ts';

const PRICED = 'anthropic:claude-haiku-4-5';
const UNPRICED = 'acme-local:unpriced-1';
const PASS_SUMMARY = { pass_count: 10, fail_count: 0, inconclusive_count: 0, error_count: 0, est_cost_usd: 0.1, verdict: 'pass' };

let auditTmp: string;
let providerCalls: string[];

function reply(model: string): ChatResult {
  return {
    text: 'widget-co',
    blocks: [{ type: 'text', text: 'widget-co' }],
    stopReason: 'end',
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model,
    providerId: model.split(':')[0]!,
  };
}

/** `n` gateway chat calls on `model`, each failure swallowed the way LongMemEval records a per-question error. */
async function chatCalls(model: string, n: number): Promise<number> {
  let refused = 0;
  for (let i = 0; i < n; i++) {
    try {
      await chat({ model, messages: [{ role: 'user', content: `question ${i}` }], maxTokens: 1000 });
    } catch {
      refused++;
    }
  }
  return refused;
}

function deps(overrides: Partial<NightlyProbeDeps> = {}): NightlyProbeDeps {
  return {
    isEnabled: () => true,
    hasEmbeddingProvider: () => true,
    resolveMaxUsd: () => 5,
    resolveRepoRoot: () => process.cwd(),
    runLongMemEval: async () => { await chatCalls(PRICED, 1); },
    runCrossModalBatch: async () => ({ exitCode: 0, summary: PASS_SUMMARY }),
    now: () => new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  auditTmp = mkdtempSync(join(tmpdir(), 'probe-budget-'));
  providerCalls = [];
  configureGateway({ env: {} });
  __setChatTransportForTests(async (opts) => {
    providerCalls.push(opts.model!);
    return reply(opts.model!);
  });
  _resetBudgetTrackerWarningsForTest();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  rmSync(auditTmp, { recursive: true, force: true });
});

describe('resolveProbeCap', () => {
  test('a valid value on either plane is a user cap; none is the $5 default cap', () => {
    expect(resolveProbeCap('2.5', 10)).toEqual({ maxUsd: 2.5, capSource: 'user' });
    expect(resolveProbeCap(null, '4')).toEqual({ maxUsd: 4, capSource: 'user' });
    expect(resolveProbeCap('banana', 3)).toEqual({ maxUsd: 3, capSource: 'user' });
    expect(resolveProbeCap(null, undefined)).toEqual({ maxUsd: 5, capSource: 'default' });
    expect(resolveProbeCap('-1', 'x')).toEqual({ maxUsd: 5, capSource: 'default' });
  });
});

describe('one budget across LongMemEval and the judges (CEO B4)', () => {
  test('LongMemEval spend exhausts the cap → budget_exceeded, LongMemEval stops paying, no judge call', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let judgeCalls = 0;
      let refused = 0;
      const r = await runNightlyQualityProbe(deps({
        resolveMaxUsd: () => 0.02,
        runLongMemEval: async () => { refused = await chatCalls(PRICED, 10); },
        runCrossModalBatch: async () => { judgeCalls++; return { exitCode: 0, summary: PASS_SUMMARY }; },
      }));
      expect(r.outcome).toBe('budget_exceeded');
      expect(judgeCalls).toBe(0);
      expect(providerCalls.length).toBeLessThan(10);
      expect(refused).toBe(10 - providerCalls.length);
      const [event] = readRecentQualityProbeEvents(1);
      expect(event!.outcome).toBe('budget_exceeded');
      expect(event!.reason).toBe('cost');
      expect(event!.cap_usd).toBe(0.02);
      expect(event!.cap_source).toBe('default');
      expect(event!.chat_calls).toBe(providerCalls.length);
      expect(event!.detail).toContain('No further paid call was made.');
      expect(event!.detail).toContain('gbrain config set autopilot.nightly_quality_probe.max_usd <usd>');
    });
  });

  test('judge spend exhausts the cap → budget_exceeded even when the batch says fail', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(deps({
        resolveMaxUsd: () => 0.02,
        runCrossModalBatch: async () => {
          await chatCalls(PRICED, 10);
          return { exitCode: 1, summary: { ...PASS_SUMMARY, pass_count: 2, fail_count: 8, verdict: 'fail' } };
        },
      }));
      expect(r.outcome).toBe('budget_exceeded');
      expect(providerCalls.length).toBeLessThan(11);
      const [event] = readRecentQualityProbeEvents(1);
      expect(event!.outcome).toBe('budget_exceeded');
      expect(event!.reason).toBe('cost');
    });
  });

  test('a run under the cap reaches its verdict with every call metered', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(deps({
        runCrossModalBatch: async () => { await chatCalls(PRICED, 3); return { exitCode: 0, summary: PASS_SUMMARY }; },
      }));
      expect(r.outcome).toBe('pass');
      expect(providerCalls).toHaveLength(4);
      const [event] = readRecentQualityProbeEvents(1);
      expect(event!.chat_calls).toBe(4);
      expect(event!.cap_usd).toBe(5);
    });
  });

  test('each call settles its own reservation, so the cap counts actual spend, not held worst cases', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let refused = -1;
      const r = await runNightlyQualityProbe(deps({
        resolveMaxUsd: () => 0.02,
        runLongMemEval: async () => { refused = await chatCalls(PRICED, 8); },
      }));
      expect(refused).toBe(0);
      expect(r.outcome).toBe('pass');
      expect(providerCalls).toHaveLength(8);
    });
  });
});

describe('pricing policy for the run cap', () => {
  test('default cap: an unpriced model warns and runs', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(deps({
        runLongMemEval: async () => { await chatCalls(UNPRICED, 2); },
      }));
      expect(r.outcome).toBe('pass');
      expect(providerCalls).toEqual([UNPRICED, UNPRICED]);
      const [event] = readRecentQualityProbeEvents(1);
      expect(event!.unpriced_chat_calls).toBe(2);
      expect(event!.cap_source).toBe('default');
    });
  });

  test('user cap: an unpriced model is refused with the no_pricing guidance and never reaches the provider', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      let judgeCalls = 0;
      const r = await runNightlyQualityProbe(deps({
        resolveMaxUsd: () => 3,
        resolveBudgetPolicy: async () => ({ capSource: 'user' }),
        runLongMemEval: async () => { await chatCalls(UNPRICED, 2); },
        runCrossModalBatch: async () => { judgeCalls++; return { exitCode: 0, summary: PASS_SUMMARY }; },
      }));
      expect(r.outcome).toBe('budget_exceeded');
      expect(providerCalls).toEqual([]);
      expect(judgeCalls).toBe(0);
      const [event] = readRecentQualityProbeEvents(1);
      expect(event!.reason).toBe('no_pricing');
      expect(event!.cap_source).toBe('user');
      expect(event!.detail).toContain(`gbrain pricing set ${UNPRICED} --input <usd-per-1M-input-tokens>`);
      expect(event!.detail).toContain('$3.00 cost cap');
    });
  });

  test('user cap: pricing.overrides prices the model, so it runs under the cap', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(deps({
        resolveMaxUsd: () => 3,
        resolveBudgetPolicy: async () => ({ capSource: 'user', pricingOverrides: { [UNPRICED]: { input: 1, output: 2 } } }),
        runLongMemEval: async () => { await chatCalls(UNPRICED, 2); },
      }));
      expect(r.outcome).toBe('pass');
      expect(providerCalls).toEqual([UNPRICED, UNPRICED]);
      const [event] = readRecentQualityProbeEvents(1);
      expect(event!.unpriced_chat_calls).toBe(0);
      expect(event!.chat_cost_usd).toBeCloseTo(2 * (1000 * 1 + 200 * 2) / 1_000_000, 9);
    });
  });
});

describe('receipts of a non-pass run (#5506)', () => {
  const failSummary = { ...PASS_SUMMARY, pass_count: 6, fail_count: 4, verdict: 'fail' };

  function writingStages(): Pick<NightlyProbeDeps, 'runLongMemEval' | 'runCrossModalBatch'> {
    return {
      runLongMemEval: async ({ outputPath }) => { writeFileSync(outputPath, '{"question_id":"q1"}\n'); },
      runCrossModalBatch: async ({ summaryPath }) => {
        writeFileSync(summaryPath, JSON.stringify(failSummary));
        return { exitCode: 1, summary: failSummary };
      },
    };
  }

  test('a FAIL keeps summary.json and lme-output.jsonl under the audit dir and names it on the row', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(deps(writingStages()));
      expect(r.outcome).toBe('fail');
      const [event] = readRecentQualityProbeEvents(1);
      expect(event!.receipt_dir).toStartWith(join(auditTmp, 'nightly-probe'));
      expect(JSON.parse(readFileSync(join(event!.receipt_dir!, 'summary.json'), 'utf8')).verdict).toBe('fail');
      expect(readFileSync(join(event!.receipt_dir!, 'lme-output.jsonl'), 'utf8')).toContain('q1');
    });
  });

  test('a runtime error after LongMemEval keeps its output too', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      const r = await runNightlyQualityProbe(deps({
        runLongMemEval: writingStages().runLongMemEval,
        runCrossModalBatch: async () => { throw new Error('summary missing'); },
      }));
      expect(r.outcome).toBe('error');
      const [event] = readRecentQualityProbeEvents(1);
      expect(existsSync(join(event!.receipt_dir!, 'lme-output.jsonl'))).toBe(true);
    });
  });

  test('only the newest 7 receipt directories are kept', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp }, async () => {
      // Rows carry the wall-clock ts, so each night's now() lies past the 24h gate of every earlier row.
      const start = Date.now() + 25 * 3600_000;
      for (let night = 0; night < 9; night++) {
        const now = new Date(start + night * 25 * 3600_000);
        const r = await runNightlyQualityProbe(deps({ ...writingStages(), now: () => now }));
        expect(r.outcome).toBe('fail');
      }
      const kept = readdirSync(join(auditTmp, 'nightly-probe')).sort();
      expect(kept).toHaveLength(7);
      expect(kept[0]).toStartWith(new Date(start + 2 * 25 * 3600_000).toISOString().slice(0, 13));
    });
  });
});
