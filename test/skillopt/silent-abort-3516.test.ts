/**
 * #3516 — skillopt silent-abort surfacing + uncapped-cost escape hatch.
 *
 * Pre-fix, a run that died mid-loop printed only "Outcome: errored" (the
 * detail lived exclusively in the audit JSONL, logged under the untruthful
 * reason 'sigint'), and there was no way to run an unpriced model id
 * (openrouter:*, litellm:*) because --max-cost-usd rejected 0 and the
 * BudgetTracker hard-fails reserve() with no_pricing whenever a cap is set.
 *
 * Covers:
 *   - parseFlags: --no-max-cost and --max-cost-usd 0 → maxCostUsd 0;
 *     negative still rejected.
 *   - preflight: maxCostUsd 0 never trips exceeds_cap; report says 'uncapped'.
 *   - BudgetTracker composition: uncapped tracker warn-onces on an unpriced
 *     model instead of throwing BudgetExhausted(no_pricing).
 *   - audit union: reason 'error' is a first-class abort reason (typed, no
 *     `as never`), so the catch-all no longer has to lie with 'sigint'.
 *   - RunReceipt carries abort_reason/abort_detail fields (type-level).
 *   - classifyAbortError: a real (not string-faked) BudgetExhausted correctly
 *     classifies as outcome='aborted'/abort_reason='budget_exhausted' — the
 *     #3516-adjacent gap where the catch block's own string sniff could
 *     never match any of budget-tracker.ts's actual throw messages, so every
 *     cost-cap/no-pricing abort silently fell through to outcome='errored'.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import { parseFlags } from '../../src/commands/skillopt.ts';
import { estimateCost, formatPreflightReport, preflight } from '../../src/core/skillopt/preflight.ts';
import { BudgetTracker, BudgetExhausted, _resetBudgetTrackerWarningsForTest } from '../../src/core/budget/budget-tracker.ts';
import { BudgetExhausted as MinionsBudgetExhausted } from '../../src/core/minions/budget-tracker.ts';
import { classifyAbortError } from '../../src/core/skillopt/orchestrator.ts';
import {
  _resetAuditWriterForTests,
  currentAuditFilename,
  logEvent,
  type SkilloptEvent,
} from '../../src/core/skillopt/audit.ts';
import type { RunReceipt } from '../../src/core/skillopt/types.ts';

const SKILL = 'widget-example';

describe('#3516 — parseFlags cost-cap escape hatch', () => {
  test('--no-max-cost sets maxCostUsd to 0', () => {
    const p = parseFlags([SKILL, '--no-max-cost']);
    expect(p.maxCostUsd).toBe(0);
  });

  test('--max-cost-usd 0 is accepted (uncapped)', () => {
    const p = parseFlags([SKILL, '--max-cost-usd', '0']);
    expect(p.maxCostUsd).toBe(0);
  });

  test('--max-cost-usd rejects negative values', () => {
    expect(() => parseFlags([SKILL, '--max-cost-usd', '-1'])).toThrow(/non-negative/);
  });

  test('positive --max-cost-usd still parses', () => {
    const p = parseFlags([SKILL, '--max-cost-usd', '2.5']);
    expect(p.maxCostUsd).toBe(2.5);
  });
});

describe('#3516 — preflight treats 0 as uncapped', () => {
  const baseOpts = {
    epochs: 4,
    batchSize: 8,
    trainSize: 8,
    selSize: 2,
    testSize: 2,
    optimizerModel: 'anthropic:claude-opus-4-7',
    targetModel: 'anthropic:claude-sonnet-4-6',
    judgeModel: 'anthropic:claude-sonnet-4-6',
    heldOutSize: 0,
    interactive: false,
  };

  test('maxCostUsd 0 never trips exceeds_cap', () => {
    const est = estimateCost({ ...baseOpts, maxCostUsd: 0 });
    expect(est.est_cost_usd).toBeGreaterThan(0);
    expect(est.exceeds_cap).toBe(false);
    const result = preflight({ ...baseOpts, maxCostUsd: 0 });
    expect(result.proceed).toBe(true);
  });

  test('a tiny positive cap still refuses (cap behavior unchanged)', () => {
    const result = preflight({ ...baseOpts, maxCostUsd: 0.000001 });
    expect(result.proceed).toBe(false);
    expect(result.abort_reason).toContain('exceeds');
  });

  test('report renders "uncapped" instead of $0.00', () => {
    const est = estimateCost({ ...baseOpts, maxCostUsd: 0 });
    const report = formatPreflightReport(est, { ...baseOpts, maxCostUsd: 0 });
    expect(report).toContain('uncapped');
    expect(report).not.toContain('cap: $0.00');
  });
});

describe('#3516 — uncapped BudgetTracker warn-onces on unpriced models', () => {
  beforeEach(() => _resetBudgetTrackerWarningsForTest());

  test('reserve() does not throw for an unpriced openrouter id when uncapped', () => {
    const tracker = new BudgetTracker({ label: 'skillopt:test' });
    expect(() => tracker.reserve({
      modelId: 'openrouter:some-lab/uncharted-model',
      estimatedInputTokens: 1000,
      maxOutputTokens: 500,
      kind: 'chat',
    })).not.toThrow();
  });

  test('reserve() still hard-fails no_pricing when a cap is set', () => {
    const tracker = new BudgetTracker({ maxCostUsd: 5, label: 'skillopt:test' });
    expect(() => tracker.reserve({
      modelId: 'openrouter:some-lab/uncharted-model',
      estimatedInputTokens: 1000,
      maxOutputTokens: 500,
      kind: 'chat',
    })).toThrow(/no pricing/);
  });
});

describe("#3516 — audit union carries a truthful 'error' reason", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-3516-'));
    _resetAuditWriterForTests();
  });

  afterEach(() => {
    _resetAuditWriterForTests();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("abort event with reason 'error' round-trips through the JSONL (typed)", async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // NOTE: no `as never` — the union must accept 'error' at compile time.
      const ev: Omit<Extract<SkilloptEvent, { kind: 'abort' }>, 'ts'> = {
        kind: 'abort',
        run_id: 'r-3516',
        skill: SKILL,
        reason: 'error',
        detail: 'provider exploded: 500',
      };
      logEvent(ev);
      const file = path.join(tmpDir, currentAuditFilename());
      const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
      expect(row.kind).toBe('abort');
      expect(row.reason).toBe('error');
      expect(row.detail).toBe('provider exploded: 500');
    });
  });

  test("'sigint' and 'runtime_exceeded' remain valid reasons (typed)", () => {
    type AbortEvent = Omit<Extract<SkilloptEvent, { kind: 'abort' }>, 'ts'>;
    const sigint: AbortEvent = {
      kind: 'abort', run_id: 'r', skill: SKILL, reason: 'sigint',
    };
    const runtime: AbortEvent = {
      kind: 'abort', run_id: 'r', skill: SKILL, reason: 'runtime_exceeded',
    };
    expect(sigint.kind).toBe('abort');
    expect(runtime.kind).toBe('abort');
  });
});

describe('#3516 — RunReceipt carries abort_reason / abort_detail', () => {
  test('fields are part of the receipt type and JSON-serialize', () => {
    const receipt: RunReceipt = {
      run_id: 'r-3516',
      skill: SKILL,
      skill_sha8: 'abcd1234',
      benchmark_sha8: 'deadbeef',
      optimizer_model: 'anthropic:claude-opus-4-7',
      target_model: 'anthropic:claude-sonnet-4-6',
      judge_model: 'anthropic:claude-sonnet-4-6',
      epochs: 4,
      batch_size: 8,
      lr: 4,
      lr_schedule: 'cosine',
      max_cost_usd: 5,
      started_at: new Date().toISOString(),
      outcome: 'errored',
      abort_reason: 'error',
      abort_detail: 'provider exploded: 500',
    };
    const parsed = JSON.parse(JSON.stringify(receipt));
    expect(parsed.abort_reason).toBe('error');
    expect(parsed.abort_detail).toBe('provider exploded: 500');
  });
});

describe('classifyAbortError — real BudgetExhausted instances (not string-faked)', () => {
  // Every message shape matches an ACTUAL throw site in budget-tracker.ts
  // (reserve's cost-cap denial, reserve's no_pricing hard-fail, record's
  // post-hoc cost overage) — none contain the literal substrings the old
  // string sniff checked for, which is exactly why every real
  // BudgetExhausted fell through to the generic catch-all pre-fix.
  test('reason=cost classifies as aborted/budget_exhausted', () => {
    const err = new BudgetExhausted(
      'skillopt:widget: projected cost $1.5000 exceeds --max-cost $1.00 (cumulative $0.0000 + outstanding $0.0000 + this call $1.5000)',
      { reason: 'cost', spent: 0, cap: 1.0, modelId: 'anthropic:claude-opus-4-7' },
    );
    const r = classifyAbortError(err, { maxRuntimeMin: 30 });
    expect(r.outcome).toBe('aborted');
    expect(r.abortReason).toBe('budget_exhausted');
    expect(r.abortDetail).toBe(err.message);
  });

  test('reason=no_pricing classifies as aborted/budget_exhausted', () => {
    const err = new BudgetExhausted('no pricing data available for openrouter:some-model', {
      reason: 'no_pricing', spent: 0, cap: 1.0, modelId: 'openrouter:some-model',
    });
    const r = classifyAbortError(err, { maxRuntimeMin: 30 });
    expect(r.outcome).toBe('aborted');
    expect(r.abortReason).toBe('budget_exhausted');
  });

  test('reason=runtime classifies as aborted/runtime_exceeded (distinct from budget_exhausted)', () => {
    // Not reachable from orchestrator.ts's own tracker today (constructed
    // without maxRuntimeMs) — pinned anyway so the mapping stays correct if
    // that ever changes, and so this reason isn't silently merged into
    // budget_exhausted by a future edit.
    const err = new BudgetExhausted('skillopt:widget: wall-clock 45.0s exceeded --max-runtime 30.0s', {
      reason: 'runtime', spent: 45000, cap: 30000,
    });
    const r = classifyAbortError(err, { maxRuntimeMin: 30 });
    expect(r.outcome).toBe('aborted');
    expect(r.abortReason).toBe('runtime_exceeded');
  });

  test('a BudgetExhausted from the UNRELATED minions/budget-tracker.ts class is not misclassified as budget_exhausted', () => {
    // Two distinct BudgetExhausted classes exist in this repo (core/budget,
    // used here, and core/minions, a differently-shaped job-cost tracker
    // with an unrelated (owner_id, balance_cents) constructor) — instanceof
    // is nominal, not structural, so an instance of the wrong one must NOT
    // satisfy this check. Guards against a future refactor importing the
    // wrong one and silently reintroducing this exact bug class.
    const wrongClassErr = new MinionsBudgetExhausted(42, 0);
    const r = classifyAbortError(wrongClassErr, { maxRuntimeMin: 30 });
    expect(r.abortReason).not.toBe('budget_exhausted');
    expect(r.outcome).toBe('errored');
  });

  test('skillopt_runtime_exceeded (plain Error, the orchestrator wall-clock deadline) still classifies correctly', () => {
    const err = new Error('skillopt_runtime_exceeded');
    const r = classifyAbortError(err, { maxRuntimeMin: 30 });
    expect(r.outcome).toBe('aborted');
    expect(r.abortReason).toBe('runtime_exceeded');
    expect(r.abortDetail).toBe('exceeded --max-runtime-min 30');
  });

  test('SIGINT (plain Error) still classifies correctly', () => {
    const err = new Error('received SIGINT, aborting run');
    const r = classifyAbortError(err, { maxRuntimeMin: 30 });
    expect(r.outcome).toBe('aborted');
    expect(r.abortReason).toBe('sigint');
  });

  test('an unrelated provider error still classifies as the truthful catch-all (#3516 behavior preserved)', () => {
    const err = new Error('provider exploded: 500');
    const r = classifyAbortError(err, { maxRuntimeMin: 30 });
    expect(r.outcome).toBe('errored');
    expect(r.abortReason).toBe('error');
    expect(r.abortDetail).toBe('provider exploded: 500');
  });

  test('negative control: replaying the exact pre-fix string-sniff against a real BudgetExhausted misclassifies it (proves this is a real regression, not a hypothetical)', () => {
    function preFixClassify(err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('BudgetExhausted') || msg.includes('budget_exhausted')) {
        return { outcome: 'aborted' as const, abortReason: 'budget_exhausted' as const };
      } else if (msg.includes('skillopt_runtime_exceeded')) {
        return { outcome: 'aborted' as const, abortReason: 'runtime_exceeded' as const };
      } else if (msg.includes('SIGINT')) {
        return { outcome: 'aborted' as const, abortReason: 'sigint' as const };
      }
      return { outcome: 'errored' as const, abortReason: 'error' as const };
    }
    const err = new BudgetExhausted('skillopt:widget: projected cost $1.5000 exceeds --max-cost $1.00', {
      reason: 'cost', spent: 0, cap: 1.0,
    });
    const old = preFixClassify(err);
    const fixed = classifyAbortError(err, { maxRuntimeMin: 30 });
    expect(old.outcome).toBe('errored'); // the bug: pre-fix logic misses it
    expect(fixed.outcome).toBe('aborted'); // this fix: correctly classified
    expect(old).not.toEqual({ outcome: fixed.outcome, abortReason: fixed.abortReason });
  });
});
