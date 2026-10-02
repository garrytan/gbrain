import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetMeter, _resetBudgetMeterWarningsForTest, ANTHROPIC_PRICING } from '../src/core/cycle/budget-meter.ts';
import { estimateMaxCostUsd } from '../src/core/anthropic-pricing.ts';
import { parsePricingOverrides } from '../src/core/budget/budget-tracker.ts';

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

  test('budget=0 spends nothing; Infinity is the explicit no-cap value (C-16)', () => {
    const zero = new BudgetMeter({ budgetUsd: 0, phase: 'drift', auditPath });
    expect(zero.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 100_000, maxOutputTokens: 100_000, label: 'huge' }).allowed).toBe(false);
    const meter = new BudgetMeter({ budgetUsd: Infinity, phase: 'drift', auditPath });
    const r = meter.check({ modelId: 'claude-opus-4-7', estimatedInputTokens: 100_000, maxOutputTokens: 100_000, label: 'huge' });
    expect(r.allowed).toBe(true);
  });

  test('an unpriced model is metered at the fallback rate with warn-once + ledger entry (C-16)', () => {
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    const r1 = meter.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'gem1' });
    const r2 = meter.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'gem2' });
    expect(r1.allowed).toBe(false);
    expect(r1.unpriced).toBe(true);
    expect(r2.allowed).toBe(false);
    expect(meter.unpricedSubmits).toBe(2);
    const bypass = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath, allowUnpriced: true });
    expect(bypass.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'gem3' }).allowed).toBe(true);
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

  test('a model absent from the canonical table is gated at a conservative fallback rate (C-16)', () => {
    // gemini-3-pro is in neither table. Like synthesize-concepts and
    // skillopt/preflight, it is metered at Sonnet-tier rates;
    // dream.budget.allow_unpriced=true is the explicit bypass.
    const meter = new BudgetMeter({ budgetUsd: 0.001, phase: 'auto_think', auditPath });
    const r = meter.check({ modelId: 'gemini-3-pro', estimatedInputTokens: 1000, maxOutputTokens: 1000, label: 'absent' });
    expect(r.unpriced).toBe(true);
    expect(r.allowed).toBe(false);
    expect(readLedger().at(-1)!.event).toBe('submit_unpriced');
    expect(readLedger().at(-1)!.allowed).toBe(false);
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

// #4312: `pricing.overrides` is the documented operator rate (a proxy route,
// or $0 for a flat-rate subscription lane). BudgetTracker consults it before
// the shipped tables; the dream-cycle meter must price the same way, or an
// override that clears every other cost cap still exhausts the dream budget
// at list price.
describe('BudgetMeter pricing.overrides (#4312)', () => {
  const big = { estimatedInputTokens: 100_000, maxOutputTokens: 10_000, label: 'big' };

  test('a $0 override prices a table model at $0 under a tight cap', () => {
    const listed = new BudgetMeter({ budgetUsd: 0.001, phase: 'propose_takes', auditPath });
    expect(listed.check({ modelId: 'anthropic:claude-sonnet-4-6', ...big }).allowed).toBe(false);
    const meter = new BudgetMeter({
      budgetUsd: 0.001, phase: 'propose_takes', auditPath,
      pricingOverrides: parsePricingOverrides('{"anthropic:claude-sonnet-4-6": 0}'),
    });
    const r = meter.check({ modelId: 'anthropic:claude-sonnet-4-6', ...big });
    expect(r.allowed).toBe(true);
    expect(r.estimatedCostUsd).toBe(0);
    expect(r.unpriced).toBeFalsy();
  });

  test('an override declared on the dated id also prices the recipe alias', () => {
    const meter = new BudgetMeter({
      budgetUsd: 0.001, phase: 'propose_takes', auditPath,
      pricingOverrides: parsePricingOverrides('{"claude-cli:claude-haiku-4-5-20251001": 0}'),
    });
    const r = meter.check({ modelId: 'claude-cli:haiku', ...big });
    expect(r.allowed).toBe(true);
    expect(r.estimatedCostUsd).toBe(0);
  });

  test('an override prices a model absent from the tables at the declared rate, not the fallback', () => {
    const meter = new BudgetMeter({
      budgetUsd: 10, phase: 'drift', auditPath,
      pricingOverrides: parsePricingOverrides('{"litellm:gpt-4o": {"input": 2, "output": 8}}'),
    });
    const r = meter.check({ modelId: 'litellm:gpt-4o', ...big });
    expect(r.unpriced).toBeFalsy();
    expect(r.estimatedCostUsd).toBeCloseTo((100_000 / 1e6) * 2 + (10_000 / 1e6) * 8, 10);
  });
});

// Structural pin: every production meter must be handed the operator's rates.
// A call site that forgets `pricingOverrides` silently reverts that phase to
// list price — the behaviour above, one construction site at a time.
test('every `new BudgetMeter(` in src passes pricingOverrides (#4312)', () => {
  const srcRoot = join(dirname(import.meta.dir), 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.ts')) files.push(f);
    }
  };
  walk(srcRoot);
  const sites: string[] = [];
  const missing: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf-8');
    for (let i = text.indexOf('new BudgetMeter('); i !== -1; i = text.indexOf('new BudgetMeter(', i + 1)) {
      let depth = 0, j = i + 'new BudgetMeter'.length;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')' && --depth === 0) break;
      }
      const call = text.slice(i, j + 1);
      const where = `${f.slice(srcRoot.length + 1)}:${text.slice(0, i).split('\n').length}`;
      sites.push(where);
      if (!call.includes('pricingOverrides')) missing.push(where);
    }
  }
  expect(sites.length).toBeGreaterThanOrEqual(5);
  expect(missing).toEqual([]);
});
