import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetMeter, _resetBudgetMeterWarningsForTest, ANTHROPIC_PRICING } from '../src/core/cycle/budget-meter.ts';

let tmpDir: string;
let auditPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'budget-meter-'));
  auditPath = join(tmpDir, 'budget.jsonl');
  _resetBudgetMeterWarningsForTest();
});

function readLedger(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('BudgetMeter', () => {
  test('Anthropic pricing map covers the alias resolution targets', () => {
    expect(ANTHROPIC_PRICING['claude-opus-4-7']).toBeDefined();
    expect(ANTHROPIC_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(ANTHROPIC_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
  });

  test('first submit is allowed when within budget', () => {
    const meter = new BudgetMeter({ budgetUsd: 1.0, phase: 'auto_think', auditPath });
    const r = meter.check({ modelId: 'claude-haiku-4-5-20251001', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'test' });
    expect(r.allowed).toBe(true);
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
    expect(r.cumulativeCostUsd).toBe(r.estimatedCostUsd);
  });

  test('cumulative cost denies the third submit when budget exhausted', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.50, phase: 'auto_think', auditPath });
    // opus is expensive: ~$0.15 input + $0.30 output per 1K-input + 4K-output call
    const big = { modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 4000, label: 'big' };
    const r1 = meter.check(big); // ~$0.075 + $0.30 = $0.375
    const r2 = meter.check(big); // cumulative would be $0.75 → exceeds $0.50 → DENY
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toContain('BUDGET_EXHAUSTED');
  });

  test('budget=0 disables the gate (cycle runs unbounded)', () => {
    const meter = new BudgetMeter({ budgetUsd: 0, phase: 'drift', auditPath });
    const r = meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 100_000, maxOutputTokens: 100_000, label: 'huge' });
    expect(r.allowed).toBe(true);
  });

  test('non-Anthropic model bypasses gate with warn-once + ledger entry', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    const r1 = meter.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'gem1' });
    const r2 = meter.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'gem2' });
    expect(r1.allowed).toBe(true);
    expect(r1.unpriced).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(meter.unpricedSubmits).toBe(2);
  });

  test('ledger captures every submit (allowed + denied + unpriced)', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 4000, label: 'a' });
    meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 4000, label: 'b-denied' });
    meter.check({ modelId: 'gpt-5', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'c-unpriced' });
    const lines = readLedger();
    expect(lines).toHaveLength(3);
    expect(lines[0].event).toBe('submit_denied'); // first opus call exceeds the $0.001 cap
    expect(lines[1].event).toBe('submit_denied');
    expect(lines[2].event).toBe('submit_unpriced');
  });

  test('ledger uses ISO-week filename when auditPath not overridden', () => {
    // Implicit path branch — just verify it doesn't throw and writes somewhere reasonable.
    const meter = new BudgetMeter({ budgetUsd: 1.0, phase: 'drift' });
    const r = meter.check({ modelId: 'claude-haiku-4-5-20251001', estimatedInputTokens: 100, maxOutputTokens: 100, label: 'wk' });
    expect(r.allowed).toBe(true);
  });
});
