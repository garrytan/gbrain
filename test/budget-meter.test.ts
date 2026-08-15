import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetMeter, _resetBudgetMeterWarningsForTest, ANTHROPIC_PRICING } from '../src/core/cycle/budget-meter.ts';
import { estimateMaxCostUsd } from '../src/core/anthropic-pricing.ts';

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

  test('cumulative cost denies the second submit when budget exhausted', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.50, phase: 'auto_think', auditPath });
    // Opus 4.7: $5 in / $25 out per 1M. Per call: 5000×5/1M + 10000×25/1M = $0.025 + $0.25 = $0.275
    const big = { modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 10000, label: 'big' };
    const r1 = meter.check(big); // $0.275 cumulative — allowed
    const r2 = meter.check(big); // $0.55 cumulative — exceeds $0.50 → DENY
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

  test('a canonical-priced non-Anthropic model is gated, not waved through', () => {
    // openai:gpt-5.2 is in CANONICAL_PRICING but not in the derived
    // ANTHROPIC_PRICING view, so the pre-canonical lookup returned null and
    // check() took the unpriced bypass: allowed, cost 0, gate disabled.
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    const r = meter.check({
      modelId: 'openai:gpt-5.2',
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      label: 'canonical-priced',
    });
    expect(r.unpriced).toBeFalsy();
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
    expect(r.allowed).toBe(false);          // 1M+1M tokens cannot fit $0.001
    expect(meter.unpricedSubmits).toBe(0);
    expect(readLedger().at(-1)!.event).toBe('submit_denied');
  });

  test('a model absent from the canonical table keeps the documented bypass', () => {
    // Unchanged behaviour: gemini-3-pro is in neither table. Whether these
    // should also be gated (via a conservative fallback rate, as
    // synthesize-concepts and skillopt/preflight do) is a policy call and is
    // deliberately not decided here.
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    const r = meter.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'absent' });
    expect(r.unpriced).toBe(true);
    expect(r.allowed).toBe(true);
    expect(readLedger().at(-1)!.event).toBe('submit_unpriced');
  });

  test('Anthropic ids price identically through canonical and the derived view', () => {
    // The derived view is generated from canonical, so routing through
    // canonicalLookup must not move any Anthropic number.
    const meter = new BudgetMeter({ budgetUsd: 1000, phase: 'auto_think', auditPath });
    const r = meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 4000, label: 'parity' });
    const viaView = estimateMaxCostUsd('claude-opus-4-7', 5000, 4000);
    expect(viaView).not.toBeNull();
    expect(r.estimatedCostUsd).toBeCloseTo(viaView!, 10);
  });

  test('an inherited-key model id cannot poison the running total', () => {
    // Both pricing tables are object literals, so 'constructor' resolves to a
    // truthy Object.prototype value and the rate arithmetic yields NaN. If
    // that reached cumulativeUsd, every later submit would pass the gate.
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    const poison = meter.check({ modelId: 'constructor', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'poison' });
    expect(poison.unpriced).toBe(true);              // treated as unpriceable
    expect(Number.isFinite(poison.cumulativeCostUsd)).toBe(true);

    const after = meter.check({
      modelId: 'claude-opus-4-7',
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      label: 'after-poison',
    });
    expect(after.allowed).toBe(false);               // gate still enforcing
    expect(Number.isFinite(after.cumulativeCostUsd)).toBe(true);
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

  test('A2 amended: every ledger line carries schema_version=1 and the documented field set', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.01, phase: 'auto_think', auditPath });
    meter.check({ modelId: 'claude-haiku-4-5-20251001', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'verdict' }); // submit
    meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 5000, maxOutputTokens: 10000, label: 'big-call' });          // submit_denied
    meter.check({ modelId: 'gpt-5', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'unpriced' });                     // submit_unpriced
    const lines = readLedger();
    expect(lines).toHaveLength(3);

    // schema_version must be on every line (renames here are breaking).
    for (const line of lines) {
      expect(line.schema_version).toBe(1);
      expect(typeof line.ts).toBe('string');
      expect(line.phase).toBe('auto_think');
      expect(['submit', 'submit_denied', 'submit_unpriced']).toContain(line.event as string);
      expect(typeof line.model).toBe('string');
      expect(typeof line.label).toBe('string');
    }

    // submit / submit_denied carry the cost fields.
    const denied = lines[0]; // first opus call exceeds the cap → denied
    expect(typeof denied.estimated_cost_usd).toBe('number');
    expect(typeof denied.cumulative_cost_usd).toBe('number');
    expect(denied.budget_usd).toBe(0.01);

    // submit_unpriced carries the token-shape fields instead.
    const unpriced = lines[2];
    expect(typeof unpriced.estimated_input_tokens).toBe('number');
    expect(typeof unpriced.max_output_tokens).toBe('number');
  });
});
