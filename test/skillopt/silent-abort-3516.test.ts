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
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import { parseFlags } from '../../src/commands/skillopt.ts';
import { estimateCost, formatPreflightReport, preflight } from '../../src/core/skillopt/preflight.ts';
import { BudgetTracker, _resetBudgetTrackerWarningsForTest } from '../../src/core/budget/budget-tracker.ts';
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
