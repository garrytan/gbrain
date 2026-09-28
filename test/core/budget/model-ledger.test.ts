/**
 * #5585 — BudgetTracker per-model ledger (`snapshot().models`), the shared
 * `reservationCostUsd` pricing helper, and the `models_used` builders.
 *
 * Hermetic: every tracker writes its audit JSONL to a per-test tempdir; no
 * gateway, provider or network is touched.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExhausted, BudgetTracker } from '../../../src/core/budget/budget-tracker.ts';
import { reservationCostUsd } from '../../../src/core/budget/reservation-cost.ts';
import {
  buildModelsUsed,
  formatModelsUsedTable,
  mergeModelUsageRows,
  touchpointForLabel,
  type ModelUsageRow,
} from '../../../src/core/budget/models-used.ts';

const HAIKU = 'anthropic:claude-haiku-4-5-20251001';

let tmp: string;
let auditPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-model-ledger-'));
  auditPath = join(tmp, 'budget.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const tracker = (maxCostUsd?: number) =>
  new BudgetTracker({ label: 'ledger-test', auditPath, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) });

describe('touchpointForLabel', () => {
  test('maps gateway labels (incl. .failed) and falls back to other', () => {
    expect(touchpointForLabel('gateway.chat')).toBe('chat');
    expect(touchpointForLabel('gateway.expand.failed')).toBe('expansion');
    expect(touchpointForLabel('gateway.embed')).toBe('embedding');
    expect(touchpointForLabel('gateway.rerank')).toBe('rerank');
    expect(touchpointForLabel('gateway.ocr.failed')).toBe('ocr');
    expect(touchpointForLabel('gateway.chatter')).toBe('other');
    expect(touchpointForLabel(undefined)).toBe('other');
  });
});

describe('BudgetTracker ledger', () => {
  test('aggregates per (requested, served, touchpoint, purpose) with tokens and cost', () => {
    const t = tracker();
    t.record({ modelId: HAIKU, inputTokens: 1000, outputTokens: 100, label: 'gateway.chat', purpose: 'skillopt.judge' });
    t.record({ modelId: HAIKU, inputTokens: 500, outputTokens: 50, label: 'gateway.chat', purpose: 'skillopt.judge' });
    const [row, ...rest] = t.snapshot().models;
    expect(rest).toEqual([]);
    expect(row).toEqual({
      requested_model: HAIKU, model: HAIKU, touchpoint: 'chat', purpose: 'skillopt.judge',
      calls: 2, attempts: 2, failed_calls: 0, input_tokens: 1500, output_tokens: 150,
      cost_usd: expect.any(Number), cost_basis: 'measured',
    });
    expect(row!.cost_usd).toBeCloseTo(t.totalSpent, 12);
  });

  test('same model, two purposes -> two rows; engine-internal calls carry purpose null', () => {
    const t = tracker();
    t.record({ modelId: HAIKU, inputTokens: 10, outputTokens: 1, label: 'gateway.chat', purpose: 'skillopt.optimizer' });
    t.record({ modelId: HAIKU, inputTokens: 10, outputTokens: 1, label: 'gateway.chat', purpose: 'skillopt.judge' });
    t.record({ modelId: HAIKU, inputTokens: 10, outputTokens: 1, label: 'gateway.expand' });
    const rows = t.snapshot().models;
    expect(rows.map(r => [r.touchpoint, r.purpose])).toEqual([
      ['chat', 'skillopt.judge'],
      ['chat', 'skillopt.optimizer'],
      ['expansion', null],
    ]);
  });

  test('.failed labels and explicit failed both count as failed calls; estimated sets cost_basis', () => {
    const t = tracker();
    t.record({ modelId: HAIKU, inputTokens: 10, outputTokens: 5, label: 'gateway.embed.failed', kind: 'chat' });
    t.record({ modelId: HAIKU, inputTokens: 10, outputTokens: 5, label: 'gateway.chat', failed: true, estimated: true });
    t.record({ modelId: HAIKU, inputTokens: 10, outputTokens: 5, label: 'gateway.chat' });
    const rows = t.snapshot().models;
    expect(rows.find(r => r.touchpoint === 'chat')).toMatchObject({ calls: 2, failed_calls: 1, cost_basis: 'estimated' });
    expect(rows.find(r => r.touchpoint === 'embedding')).toMatchObject({ calls: 1, failed_calls: 1, cost_basis: 'measured' });
  });

  test('countsAsCall:false adds an attempt, not a call', () => {
    const t = tracker();
    t.record({ modelId: HAIKU, inputTokens: 10, label: 'gateway.expand.failed' });
    t.record({ modelId: HAIKU, inputTokens: 10, label: 'gateway.expand', countsAsCall: false });
    expect(t.snapshot().models).toEqual([expect.objectContaining({ calls: 1, attempts: 2, failed_calls: 1 })]);
  });

  test('unpriced record stays in the ledger with cost_usd null', () => {
    const t = tracker();
    t.record({ modelId: 'litellm:mystery', inputTokens: 42, outputTokens: 7, label: 'gateway.chat' });
    expect(t.totalSpent).toBe(0);
    expect(t.snapshot().models).toEqual([expect.objectContaining({
      model: 'litellm:mystery', calls: 1, input_tokens: 42, output_tokens: 7, cost_usd: null,
    })]);
  });

  test('a TX1 over-cap record throws AND is still in the ledger', () => {
    const t = tracker(0.000001);
    expect(() => t.record({ modelId: HAIKU, inputTokens: 100_000, outputTokens: 10_000, label: 'gateway.chat' }))
      .toThrow(BudgetExhausted);
    expect(t.snapshot().models).toEqual([expect.objectContaining({ calls: 1, input_tokens: 100_000, cost_usd: expect.any(Number) })]);
  });

  test('requested vs served stay distinct; alias and canonical served ids aggregate to one row', () => {
    const t = tracker();
    t.record({ modelId: 'claude-cli:haiku', requestedModelId: 'claude-cli:haiku', inputTokens: 10, label: 'gateway.chat' });
    t.record({ modelId: 'claude-cli:claude-haiku-4-5-20251001', requestedModelId: 'claude-cli:haiku', inputTokens: 10, label: 'gateway.chat' });
    expect(t.snapshot().models).toEqual([expect.objectContaining({
      requested_model: 'claude-cli:haiku', model: 'claude-cli:claude-haiku-4-5-20251001', calls: 2,
    })]);
  });

  test('two trackers keep isolated ledgers', () => {
    const a = tracker();
    const b = tracker();
    a.record({ modelId: HAIKU, inputTokens: 10, label: 'gateway.chat' });
    expect(a.snapshot().models).toHaveLength(1);
    expect(b.snapshot().models).toEqual([]);
  });

  test('snapshot rows are copies (mutating them does not touch the ledger)', () => {
    const t = tracker();
    t.record({ modelId: HAIKU, inputTokens: 10, label: 'gateway.chat' });
    t.snapshot().models[0]!.calls = 99;
    expect(t.snapshot().models[0]!.calls).toBe(1);
  });
});

describe('reservationCostUsd', () => {
  test('free local chat model prices at 0 and never trips a cap', () => {
    expect(reservationCostUsd('ollama:llama3', 'chat', 1_000_000, 32_000)).toBe(0);
    expect(() => tracker(0.0001).reserve({ modelId: 'ollama:llama3', estimatedInputTokens: 1_000_000, maxOutputTokens: 32_000, kind: 'chat' }))
      .not.toThrow();
  });

  test('pricing override is honored; unknown price is null', () => {
    expect(reservationCostUsd('litellm:x', 'chat', 1_000_000, 1_000_000)).toBeNull();
    expect(reservationCostUsd('litellm:x', 'chat', 1_000_000, 1_000_000, { 'litellm:x': { input: 2, output: 4 } })).toBe(6);
  });

  test('parity: reserve() admits exactly when the projection fits the cap', () => {
    const projected = reservationCostUsd(HAIKU, 'chat', 10_000, 4096)!;
    expect(projected).toBeGreaterThan(0);
    const estimate = { modelId: HAIKU, estimatedInputTokens: 10_000, maxOutputTokens: 4096, kind: 'chat' as const };
    expect(() => tracker(projected * 1.01).reserve(estimate)).not.toThrow();
    expect(() => tracker(projected * 0.99).reserve(estimate)).toThrow(BudgetExhausted);
  });
});

const row = (over: Partial<ModelUsageRow>): ModelUsageRow => ({
  requested_model: HAIKU, model: HAIKU, touchpoint: 'chat', purpose: null,
  calls: 1, attempts: 1, failed_calls: 0, input_tokens: 10, output_tokens: 1, cost_usd: 0.5, cost_basis: 'measured',
  ...over,
});

describe('buildModelsUsed / mergeModelUsageRows', () => {
  test('prior-segment rows merge with the snapshot on the ledger key', () => {
    const merged = buildModelsUsed(
      { models: [row({ calls: 2, cost_usd: 1 }), row({ touchpoint: 'expansion' })] },
      [row({ calls: 3, cost_usd: 0.25, cost_basis: 'estimated' })],
    );
    expect(merged).toEqual([
      row({ calls: 5, attempts: 2, input_tokens: 20, output_tokens: 2, cost_usd: 1.25, cost_basis: 'estimated' }),
      row({ touchpoint: 'expansion' }),
    ]);
  });

  test('an unpriced contribution makes the merged cost null', () => {
    expect(mergeModelUsageRows([row({})], [row({ cost_usd: null })])[0]!.cost_usd).toBeNull();
  });
});

describe('formatModelsUsedTable', () => {
  test('header + one aligned line per row; requested -> served, attempts, failures, estimated and unpriced marks', () => {
    const lines = formatModelsUsedTable([
      row({ purpose: 'skillopt.judge', cost_usd: 0.0123 }),
      row({ touchpoint: 'expansion', requested_model: 'anthropic:haiku', attempts: 2, failed_calls: 1, cost_basis: 'estimated' }),
      row({ touchpoint: 'rerank', model: 'litellm:x', requested_model: 'litellm:x', cost_usd: null }),
    ]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^touchpoint\s+purpose\s+model\s+calls\s+tokens in\/out\s+cost$/);
    expect(lines[1]).toContain('skillopt.judge');
    expect(lines[1]).toContain('$0.0123');
    expect(lines[2]).toContain('engine');
    expect(lines[2]).toContain(`anthropic:haiku -> ${HAIKU}`);
    expect(lines[2]).toContain('1 (2 attempts), 1 failed');
    expect(lines[2]).toContain('~$0.5000');
    expect(lines[3]).toContain('unpriced');
    expect(lines[1]!.indexOf('10/1')).toBe(lines[3]!.indexOf('10/1'));
  });
});
