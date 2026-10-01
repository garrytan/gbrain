// Write-path audit C-16: dream budget meter gaps.
//  - A model missing from the pricing table is metered at a conservative
//    fallback rate instead of bypassing the gate; `dream.budget.allow_unpriced`
//    restores the bypass.
//  - A budget of 0 spends nothing everywhere; `unlimited` is the explicit
//    no-cap value.
//  - Drift estimates its input tokens from the actual prompt.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { BudgetMeter, parseBudgetUsd, loadAllowUnpriced, _resetBudgetMeterWarningsForTest } from '../src/core/cycle/budget-meter.ts';
import { runPhaseDrift } from '../src/core/cycle/drift.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'budget-fail-closed-'));
  _resetBudgetMeterWarningsForTest();
});

describe('BudgetMeter fails closed', () => {
  test('an unpriced model is metered at the fallback rate and denied past the cap', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'drift', auditPath: join(tmpDir, 'a.jsonl') });
    const r = meter.check({ modelId: 'proxy:unknown-alias', estimatedInputTokens: 100_000, maxOutputTokens: 10_000, label: 'x' });
    expect(r.unpriced).toBe(true);
    expect(r.allowed).toBe(false);
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
  });

  test('local model servers cost nothing and are never capped by the fallback rate', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'drift', auditPath: join(tmpDir, 'l.jsonl') });
    for (const modelId of ['ollama:llama3.3', 'lmstudio:qwen3-8b', 'llama-server:local']) {
      const r = meter.check({ modelId, estimatedInputTokens: 1e6, maxOutputTokens: 1e5, label: modelId });
      expect(r.allowed).toBe(true);
      expect(r.estimatedCostUsd).toBe(0);
      expect(r.unpriced).toBeFalsy();
    }
  });

  test('allowUnpriced restores the documented bypass', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'drift', auditPath: join(tmpDir, 'b.jsonl'), allowUnpriced: true });
    const r = meter.check({ modelId: 'proxy:unknown-alias', estimatedInputTokens: 100_000, maxOutputTokens: 10_000, label: 'x' });
    expect(r.unpriced).toBe(true);
    expect(r.allowed).toBe(true);
  });

  test('a budget of 0 spends nothing; Infinity is the explicit no-cap value', () => {
    const zero = new BudgetMeter({ budgetUsd: 0, phase: 'drift', auditPath: join(tmpDir, 'c.jsonl') });
    expect(zero.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 100, maxOutputTokens: 100, label: 'z' }).allowed).toBe(false);
    const open = new BudgetMeter({ budgetUsd: Infinity, phase: 'drift', auditPath: join(tmpDir, 'd.jsonl') });
    expect(open.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 1e7, maxOutputTokens: 1e6, label: 'u' }).allowed).toBe(true);
    expect(open.check({ modelId: 'proxy:unknown-alias', estimatedInputTokens: 1e7, maxOutputTokens: 1e6, label: 'u2' }).allowed).toBe(true);
  });

  test('parseBudgetUsd: 0 is honored, negatives clamp to 0, unlimited is Infinity, garbage falls back', () => {
    expect(parseBudgetUsd('0', 1)).toBe(0);
    expect(parseBudgetUsd('2.5', 1)).toBe(2.5);
    expect(parseBudgetUsd(3, 1)).toBe(3);
    expect(parseBudgetUsd('unlimited', 1)).toBe(Infinity);
    expect(parseBudgetUsd(' Unlimited ', 1)).toBe(Infinity);
    expect(parseBudgetUsd('-1', 1)).toBe(0);
    expect(parseBudgetUsd('abc', 1)).toBe(1);
    expect(parseBudgetUsd('', 1)).toBe(1);
    expect(parseBudgetUsd(null, 1)).toBe(1);
    expect(parseBudgetUsd(undefined, 1)).toBe(1);
  });
});

describe('drift budget', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const page = await engine.putPage('people/dana-example', { title: 'Dana', type: 'person', compiled_truth: 'Dana content' });
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Strong operator', kind: 'take', holder: 'brain', weight: 0.6 }]);
    const today = new Date().toISOString().slice(0, 10);
    await engine.addTimelineEntriesBatch(Array.from({ length: 12 }, (_, i) => ({
      slug: 'people/dana-example', date: today, source: `meeting-${i}`, summary: `Long notes ${i}: ${'word '.repeat(800)}`,
    })));
    await engine.setConfig('dream.drift.enabled', 'true');
    await engine.setConfig('models.drift', 'anthropic:claude-sonnet-4-6');
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function judgeCalls(budget: string): Promise<{ calls: number; status: string }> {
    await engine.setConfig('dream.drift.budget', budget);
    let calls = 0;
    const r = await runPhaseDrift(engine, {
      dryRun: false,
      auditPath: join(tmpDir, `drift-${budget}.jsonl`),
      judge: async () => { calls++; return { drifted: false, confidence: 0.5, reasoning: '' }; },
    });
    return { calls, status: r.status };
  }

  test('the input estimate follows the real evidence size', async () => {
    // ~12k tokens of evidence cannot fit $0.02 at Sonnet rates; the old fixed
    // 1,500-token estimate said it could.
    expect(await judgeCalls('0.02')).toEqual({ calls: 0, status: 'partial' });
    expect((await judgeCalls('1.0')).calls).toBe(1);
  });

  test('"0" spends nothing and "unlimited" has no cap', async () => {
    expect((await judgeCalls('0')).calls).toBe(0);
    expect((await judgeCalls('unlimited')).calls).toBe(1);
  });

  test('pricing.overrides reach the drift gate (#4312)', async () => {
    // The same budget that cannot fit one Sonnet judge call at list price
    // (asserted above) fits once the operator declares a $0 rate for it.
    await engine.setConfig('pricing.overrides', '{"anthropic:claude-sonnet-4-6": 0}');
    try {
      expect((await judgeCalls('0.02')).calls).toBe(1);
    } finally {
      await engine.setConfig('pricing.overrides', '');
    }
  });

  test('loadAllowUnpriced reads dream.budget.allow_unpriced', async () => {
    expect(await loadAllowUnpriced(engine)).toBe(false);
    await engine.setConfig('dream.budget.allow_unpriced', 'true');
    expect(await loadAllowUnpriced(engine)).toBe(true);
    await engine.setConfig('dream.budget.allow_unpriced', 'false');
  });
});
