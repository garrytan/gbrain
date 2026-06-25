/**
 * v0.37.x — BudgetTracker contracts (TX1, TX2, A3 amended, Q2).
 *
 * Every behavior the rest of the budget cathedral depends on is pinned here:
 *   - reserve() throws BudgetExhausted on each of {cost, runtime, no_pricing}.
 *   - record() throws BudgetExhausted (reason:'cost') when cumulative > cap
 *     after a single under-estimated call (TX1).
 *   - extractUsageFromError prefers err.usage, falls back to a pessimistic
 *     ceiling (NOT the conservative pre-call estimate) (A3 amended).
 *   - onExhausted fires once + synchronously, before the throw propagates.
 *   - Audit JSONL is schema-stable: every line carries schema_version=1.
 *   - Non-priced model + no cap: emits BUDGET_TRACKER_NO_PRICING once per
 *     process (legacy behavior preserved).
 *
 * Hermetic: no DB, no network, no real audit dir. We override `auditPath`
 * to a tmpdir-scoped JSONL so tests can read it back without touching
 * `~/.gbrain`. `withEnv` covers the GBRAIN_AUDIT_DIR escape hatch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BudgetTracker,
  BudgetExhausted,
  configureBudgetTrackerDefaults,
  extractUsageFromError,
  _resetBudgetTrackerWarningsForTest,
} from '../../../src/core/budget/budget-tracker.ts';
import {
  budgetAuditRowFingerprint,
  isModelInMonthlyBudgetScope,
  readMonthlyChatSpendUsd,
  resolveMonthlyBudgetCapFromEngine,
} from '../../../src/core/budget/monthly-cap.ts';

let tmp: string;
let auditPath: string;
let stderrCapture: string;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-budget-test-'));
  auditPath = join(tmp, 'budget.jsonl');
  _resetBudgetTrackerWarningsForTest();
  configureBudgetTrackerDefaults({});
  stderrCapture = '';
  origStderrWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    stderrCapture += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
});

afterEach(() => {
  (process.stderr as { write: unknown }).write = origStderrWrite;
  rmSync(tmp, { recursive: true, force: true });
});

function readAudit(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function writeAuditRows(rows: Array<Record<string, unknown>>): void {
  writeFileSync(auditPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

describe('BudgetTracker.reserve', () => {
  test('passes when under cap with known pricing', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    expect(() =>
      t.reserve({
        modelId: 'claude-haiku-4-5-20251001',
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        kind: 'chat',
      }),
    ).not.toThrow();
    const audit = readAudit();
    expect(audit.length).toBe(1);
    expect(audit[0].event).toBe('reserve');
    expect(audit[0].schema_version).toBe(1);
  });

  test('throws BudgetExhausted (reason: cost) when projected > cap', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.001, label: 'test', auditPath });
    let caught: unknown = null;
    try {
      // Opus 4.7 at $5/$25/M; 1K in + 1K out = $0.005 + $0.025 = $0.030 > $0.001
      t.reserve({
        modelId: 'claude-opus-4-7',
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        kind: 'chat',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('cost');
    expect((caught as BudgetExhausted).cap).toBe(0.001);
    expect((caught as BudgetExhausted).modelId).toBe('claude-opus-4-7');
    const audit = readAudit();
    expect(audit.some((e) => e.event === 'reserve_denied')).toBe(true);
  });

  test('throws BudgetExhausted (reason: runtime) when wall-clock cap blown', () => {
    const t = new BudgetTracker({ maxRuntimeMs: 1, label: 'test', auditPath });
    // Spin briefly so elapsed > 1ms
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    let caught: unknown = null;
    try {
      t.reserve({
        modelId: 'claude-haiku-4-5-20251001',
        estimatedInputTokens: 10,
        maxOutputTokens: 10,
        kind: 'chat',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('runtime');
  });

  test('TX2: throws BudgetExhausted (reason: no_pricing) when cap set + model unknown', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    let caught: unknown = null;
    try {
      t.reserve({
        modelId: 'mystery:some-unreleased-model',
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
        kind: 'chat',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('no_pricing');
    expect((caught as BudgetExhausted).modelId).toBe('mystery:some-unreleased-model');
    expect((caught as Error).message).toMatch(/model-pricing\.ts/);
  });

  test('DeepSeek chat models use canonical pricing under --max-cost', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    expect(() =>
      t.reserve({
        modelId: 'deepseek:deepseek-v4-pro',
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        kind: 'chat',
      }),
    ).not.toThrow();
    const audit = readAudit();
    expect(audit[0].event).toBe('reserve');
    expect(audit[0].projected_cost_usd).toBeCloseTo(0.001305, 8);
  });

  test('native non-Anthropic chat models use canonical pricing under --max-cost', () => {
    for (const [modelId, expectedCost] of [
      ['openai:gpt-5.4-mini', 0.00525],
      ['google:gemini-2.0-flash', 0.0005],
    ] as const) {
      const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
      expect(() =>
        t.reserve({
          modelId,
          estimatedInputTokens: 1000,
          maxOutputTokens: 1000,
          kind: 'chat',
        }),
      ).not.toThrow();
      const audit = readAudit();
      expect(audit.at(-1)?.event).toBe('reserve');
      expect(audit.at(-1)?.projected_cost_usd).toBeCloseTo(expectedCost, 8);
    }
  });

  test('OpenRouter nested chat ids fail closed under --max-cost', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    let caught: unknown = null;
    try {
      t.reserve({
        modelId: 'openrouter:openai/gpt-5.4-mini',
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        kind: 'chat',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('no_pricing');
    expect((caught as BudgetExhausted).modelId).toBe('openrouter:openai/gpt-5.4-mini');
    const audit = readAudit();
    expect(audit.some((e) => e.event === 'reserve')).toBe(false);
  });

  test('monthly Claude+DeepSeek budget blocks projected overage before reserve', () => {
    writeAuditRows([
      {
        schema_version: 1,
        ts: '2026-06-10T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'deepseek:deepseek-v4-pro',
        actual_cost_usd: 49.9,
      },
    ]);
    const t = new BudgetTracker({
      label: 'test',
      auditPath,
      monthlyNow: () => new Date('2026-06-18T00:00:00.000Z'),
      monthlyBudget: { maxCostUsd: 50, mode: 'block' },
    });
    let caught: unknown = null;
    try {
      t.reserve({
        modelId: 'deepseek:deepseek-v4-pro',
        estimatedInputTokens: 1_000_000,
        maxOutputTokens: 0,
        kind: 'chat',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('cost');
    const audit = readAudit();
    expect(audit.some((e) => e.event === 'monthly_budget_denied')).toBe(true);
    expect(audit.some((e) => e.event === 'reserve')).toBe(false);
  });

  test('monthly Claude+DeepSeek budget can warn and still reserve', () => {
    writeAuditRows([
      {
        schema_version: 1,
        ts: '2026-06-10T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'deepseek:deepseek-v4-flash',
        actual_cost_usd: 49.9,
      },
    ]);
    const t = new BudgetTracker({
      label: 'test',
      auditPath,
      monthlyNow: () => new Date('2026-06-18T00:00:00.000Z'),
      monthlyBudget: { maxCostUsd: 50, mode: 'warn' },
    });
    expect(() =>
      t.reserve({
        modelId: 'anthropic:claude-sonnet-4-6',
        estimatedInputTokens: 100_000,
        maxOutputTokens: 0,
        kind: 'chat',
      }),
    ).not.toThrow();
    expect(stderrCapture).toContain('monthly Claude+DeepSeek budget would exceed $50.00');
    const audit = readAudit();
    expect(audit.some((e) => e.event === 'monthly_budget_warn')).toBe(true);
    expect(audit.some((e) => e.event === 'reserve')).toBe(true);
  });

  test('v0.41.20.0: slash-prefix anthropic/claude-* under --max-cost does NOT no_pricing throw (THE FIX)', () => {
    // Pre-v0.41.20.0: lookupPricing only split modelId on ':'. CLI users
    // running `gbrain brainstorm --judge-model anthropic/claude-sonnet-4-6
    // --max-cost 5` hit TX2 no_pricing because the slash-form id silently
    // missed ANTHROPIC_PRICING (closes #1540).
    const t = new BudgetTracker({ maxCostUsd: 10.0, label: 'test', auditPath });
    expect(() =>
      t.reserve({
        modelId: 'anthropic/claude-sonnet-4-6',
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
        kind: 'chat',
      }),
    ).not.toThrow();
    const audit = readAudit();
    expect(audit[0].event).toBe('reserve');
  });

  test('v0.41.20.0: colon-prefix anthropic:claude-* under --max-cost still works (regression guard)', () => {
    // Same path as slash, exercised separately so a future refactor that
    // accidentally drops colon support fires this test loudly.
    const t = new BudgetTracker({ maxCostUsd: 10.0, label: 'test', auditPath });
    expect(() =>
      t.reserve({
        modelId: 'anthropic:claude-sonnet-4-6',
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
        kind: 'chat',
      }),
    ).not.toThrow();
  });

  test('no cap + unknown pricing: warns once per process, no throw', () => {
    const t = new BudgetTracker({ label: 'test', auditPath });
    expect(() =>
      t.reserve({
        modelId: 'mystery:some-other',
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
        kind: 'chat',
      }),
    ).not.toThrow();
    expect(stderrCapture).toMatch(/BUDGET_TRACKER_NO_PRICING/);
    // Second call same model: no second warning.
    const before = stderrCapture.length;
    t.reserve({
      modelId: 'mystery:some-other',
      estimatedInputTokens: 100,
      maxOutputTokens: 100,
      kind: 'chat',
    });
    expect(stderrCapture.length).toBe(before);
    const audit = readAudit();
    expect(audit.filter((e) => e.event === 'reserve_unpriced').length).toBe(2);
  });

  test('v0.40.6.1: rerank kind for llama-server-reranker prices at $0 (no TX2 throw under --max-cost)', () => {
    // The FREE_LOCAL_RERANK_PROVIDERS contract — local inference costs
    // electricity, not API tokens. Pre-v0.40.6.1 setting --max-cost while
    // configured for a local reranker would TX2 hard-fail because the
    // lookupPricing fall-through path returned null for any provider not
    // in ANTHROPIC_PRICING. Now the rerank kind recognizes the local
    // provider prefix and returns zero pricing.
    const t = new BudgetTracker({ maxCostUsd: 0.0001, label: 'test', auditPath });
    expect(() =>
      t.reserve({
        modelId: 'llama-server-reranker:qwen3-reranker-4b',
        estimatedInputTokens: 5000,
        maxOutputTokens: 0,
        kind: 'rerank',
      }),
    ).not.toThrow();
    expect(t.totalSpent).toBe(0);
  });

  test('v0.40.6.1: rerank kind for arbitrary model id under llama-server-reranker provider still zero-priced', () => {
    // Empty allowlist on the recipe means any model id is valid; budget
    // path must agree.
    const t = new BudgetTracker({ maxCostUsd: 0.0001, label: 'test', auditPath });
    expect(() =>
      t.reserve({
        modelId: 'llama-server-reranker:some-custom-gguf-id',
        estimatedInputTokens: 5000,
        maxOutputTokens: 0,
        kind: 'rerank',
      }),
    ).not.toThrow();
  });

  test('v0.40.6.1: chat kind for the same provider prefix is NOT zero-priced (rerank-only contract)', () => {
    // The free-local zero-price applies ONLY to the rerank kind. If someone
    // wires a chat call through this provider with --max-cost, the TX2 hard-
    // fail behavior is preserved so the user gets a clear "no pricing entry"
    // signal rather than silent zero accounting.
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    let caught: unknown = null;
    try {
      t.reserve({
        modelId: 'llama-server-reranker:not-actually-a-chat-model',
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
        kind: 'chat',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('no_pricing');
  });

  test('v0.40.x: local embed providers price at $0 (no TX2 throw under --max-cost)', () => {
    // FREE_LOCAL_EMBED_PROVIDERS — ollama / llama-server run on local inference
    // (electricity, not tokens). Pre-fix a --max-cost embed/reindex job
    // configured for a local provider TX2 hard-failed because
    // lookupEmbeddingPrice has no entry for them.
    for (const modelId of ['ollama:nomic-embed-text', 'llama-server:my-gguf']) {
      const t = new BudgetTracker({ maxCostUsd: 0.0001, label: 'test', auditPath });
      expect(() =>
        t.reserve({ modelId, estimatedInputTokens: 5000, maxOutputTokens: 0, kind: 'embed' }),
      ).not.toThrow();
      expect(t.totalSpent).toBe(0);
    }
  });

  test('v0.40.x REGRESSION: unknown hosted embed provider still TX2 hard-fails under cap', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    let caught: unknown = null;
    try {
      t.reserve({ modelId: 'mystery:some-embed-model', estimatedInputTokens: 100, maxOutputTokens: 0, kind: 'embed' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('no_pricing');
  });

  test('v0.40.x REGRESSION: known hosted embed (openai) still real-priced (trips a tiny cap)', () => {
    // 3-small is $0.02/1M tokens. 1M tokens projects $0.02 > $0.0001 cap, so a
    // real (nonzero) price trips the cost gate — proving it's NOT on the $0
    // local-provider path. The local providers above do NOT throw at the same cap.
    const t = new BudgetTracker({ maxCostUsd: 0.0001, label: 'test', auditPath });
    let caught: unknown = null;
    try {
      t.reserve({ modelId: 'openai:text-embedding-3-small', estimatedInputTokens: 1_000_000, maxOutputTokens: 0, kind: 'embed' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('cost');
  });
});

describe('BudgetTracker.record', () => {
  test('TX1: cumulative > cap after under-estimated call throws BudgetExhausted', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.01, label: 'test', auditPath });
    // Reserve a small call (within cap)
    t.reserve({
      modelId: 'claude-haiku-4-5-20251001',
      estimatedInputTokens: 100,
      maxOutputTokens: 100,
      kind: 'chat',
    });
    // Provider returns way more than expected — cumulative blows past cap.
    let caught: unknown = null;
    try {
      t.record({
        modelId: 'claude-haiku-4-5-20251001',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        kind: 'chat',
      } as any);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('cost');
    expect((caught as BudgetExhausted).cap).toBe(0.01);
    expect((caught as BudgetExhausted).spent).toBeGreaterThan(0.01);
    expect(t.totalSpent).toBeGreaterThan(0.01);
  });

  test('records actual usage on success and updates cumulative', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    t.record({
      modelId: 'claude-haiku-4-5-20251001',
      inputTokens: 1000,
      outputTokens: 500,
      kind: 'chat',
    } as any);
    // Haiku: ($1 × 1K/1M) + ($5 × 500/1K-K) = 0.001 + 0.0025 = 0.0035
    expect(t.totalSpent).toBeCloseTo(0.0035, 6);
    expect(t.snapshot().callsRecorded).toBe(1);
    const audit = readAudit();
    expect(audit.length).toBe(1);
    expect(audit[0].event).toBe('record');
    expect(audit[0].schema_version).toBe(1);
    expect(audit[0].actual_cost_usd).toBeCloseTo(0.0035, 6);
  });

  test('prices Anthropic cache tokens with cache-specific multipliers', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    t.record({
      modelId: 'claude-haiku-4-5-20251001',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 1000,
      cacheCreationTokens: 1000,
      kind: 'chat',
    } as any);

    // Haiku: input $0.001 + output $0.0025 + cache read $0.0001
    // + 5-minute cache write $0.00125 = $0.00485.
    expect(t.totalSpent).toBeCloseTo(0.00485, 6);
    const audit = readAudit();
    expect(audit[0].cache_read_tokens).toBe(1000);
    expect(audit[0].cache_creation_tokens).toBe(1000);
    expect(audit[0].cache_read_input_multiplier).toBe(0.1);
    expect(audit[0].cache_creation_input_multiplier).toBe(1.25);
    expect(audit[0].actual_cost_usd).toBeCloseTo(0.00485, 6);
  });

  test('prices Z.AI cached input with explicit cached-input rate', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    t.record({
      modelId: 'zai:glm-5.2',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 1000,
      cacheCreationTokens: 1000,
      kind: 'chat',
    } as any);

    // GLM-5.2: input $0.0014 + output $0.0022 + cached input $0.00026
    // + cache creation/storage currently priced at $0.00 = $0.00386.
    expect(t.totalSpent).toBeCloseTo(0.00386, 6);
    const audit = readAudit();
    expect(audit[0].cache_read_tokens).toBe(1000);
    expect(audit[0].cache_creation_tokens).toBe(1000);
    expect(audit[0].cache_read_input_multiplier).toBeNull();
    expect(audit[0].cache_creation_input_multiplier).toBeNull();
    expect(audit[0].actual_cost_usd).toBeCloseTo(0.00386, 6);
  });

  test('non-Anthropic cached tokens fall back to normal input pricing when no cache rate is modeled', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    t.record({
      modelId: 'openai:gpt-4o-mini',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 1000,
      cacheCreationTokens: 1000,
      kind: 'chat',
    } as any);

    // gpt-4o-mini: input $0.00015 + output $0.0003 + cached read fallback
    // $0.00015 + cached creation fallback $0.00015 = $0.00075.
    expect(t.totalSpent).toBeCloseTo(0.00075, 6);
    const audit = readAudit();
    expect(audit[0].cache_read_input_multiplier).toBeNull();
    expect(audit[0].cache_creation_input_multiplier).toBeNull();
    expect(audit[0].actual_cost_usd).toBeCloseTo(0.00075, 6);
  });

  test('unpriced record: no throw, audited as record_unpriced', () => {
    const t = new BudgetTracker({ label: 'test', auditPath });
    expect(() =>
      t.record({
        modelId: 'mystery:unknown',
        inputTokens: 100,
        outputTokens: 100,
        kind: 'chat',
      } as any),
    ).not.toThrow();
    const audit = readAudit();
    expect(audit.some((e) => e.event === 'record_unpriced')).toBe(true);
    expect(t.totalSpent).toBe(0);
  });

  test('embed record uses embedding-pricing map', () => {
    const t = new BudgetTracker({ maxCostUsd: 1.0, label: 'test', auditPath });
    t.record({
      modelId: 'openai:text-embedding-3-large',
      inputTokens: 1_000_000,
      embeddingDims: 3072,
      kind: 'embed',
    } as any);
    // 1M tokens × $0.13/M = $0.13
    expect(t.totalSpent).toBeCloseTo(0.13, 6);
    const audit = readAudit();
    expect(audit[0].embedding_dims).toBe(3072);
    expect(audit[0].kind).toBe('embed');
  });
});

describe('BudgetTracker.onExhausted', () => {
  test('fires once, synchronously, before throw propagates', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.001, label: 'test', auditPath });
    let fired = 0;
    let firedBeforeThrow = false;
    t.onExhausted(() => {
      fired++;
      firedBeforeThrow = true;
    });
    expect(() =>
      t.reserve({
        modelId: 'claude-opus-4-7',
        estimatedInputTokens: 1000,
        maxOutputTokens: 1000,
        kind: 'chat',
      }),
    ).toThrow(BudgetExhausted);
    expect(fired).toBe(1);
    expect(firedBeforeThrow).toBe(true);
    // Subsequent throws don't refire the callback (record() over cap should
    // not re-trigger).
    try {
      t.record({
        modelId: 'claude-opus-4-7',
        inputTokens: 10_000_000,
        outputTokens: 0,
        kind: 'chat',
      } as any);
    } catch {
      /* expected */
    }
    expect(fired).toBe(1);
  });
});

describe('extractUsageFromError (A3 amended)', () => {
  const fallback = { inputTokens: 5000, outputTokens: 5000 };

  test('reads top-level err.usage (Anthropic shape)', () => {
    const err = { usage: { input_tokens: 100, output_tokens: 50 } };
    expect(extractUsageFromError(err, fallback)).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  test('reads nested err.response.usage (OpenAI shape)', () => {
    const err = { response: { usage: { input_tokens: 200, output_tokens: 75 } } };
    expect(extractUsageFromError(err, fallback)).toEqual({ inputTokens: 200, outputTokens: 75 });
  });

  test('camelCase usage variant', () => {
    const err = { usage: { inputTokens: 300, outputTokens: 100 } };
    expect(extractUsageFromError(err, fallback)).toEqual({ inputTokens: 300, outputTokens: 100 });
  });

  test('preserves separate cache usage fields for cache-aware pricing', () => {
    const err = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 11,
      },
    };
    expect(extractUsageFromError(err, fallback)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 7,
      cacheCreationTokens: 11,
    });
  });

  test('returns pessimistic fallback when no usage present (A3 amended)', () => {
    const err = new Error('network blew up');
    // Critical: fallback must be the pessimistic ceiling (maxOutputTokens),
    // not the optimistic pre-call estimate. Caller passes
    // { inputTokens: estimatedInput, outputTokens: maxOutput }.
    expect(extractUsageFromError(err, fallback)).toEqual({
      inputTokens: 5000,
      outputTokens: 5000,
    });
  });

  test('partial usage uses fallback for the missing half', () => {
    const err = { usage: { input_tokens: 50 } };
    expect(extractUsageFromError(err, fallback)).toEqual({
      inputTokens: 50,
      outputTokens: 5000,
    });
  });

  test('handles primitives + null without throwing', () => {
    expect(extractUsageFromError(null, fallback)).toEqual(fallback);
    expect(extractUsageFromError(undefined, fallback)).toEqual(fallback);
    expect(extractUsageFromError('boom', fallback)).toEqual(fallback);
    expect(extractUsageFromError(42, fallback)).toEqual(fallback);
  });
});

describe('Audit JSONL schema (A2 amended — schema-stable)', () => {
  test('every line has schema_version=1 and the documented field set', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.5, label: 'phase-x', auditPath });
    t.reserve({
      modelId: 'claude-haiku-4-5-20251001',
      estimatedInputTokens: 1000,
      maxOutputTokens: 1000,
      kind: 'chat',
      label: 'phase-x.cross',
    });
    t.record({
      modelId: 'claude-haiku-4-5-20251001',
      inputTokens: 800,
      outputTokens: 600,
      kind: 'chat',
      label: 'phase-x.cross',
    } as any);
    const audit = readAudit();
    expect(audit.length).toBe(2);
    for (const line of audit) {
      expect(line.schema_version).toBe(1);
      expect(typeof line.ts).toBe('string');
      expect(line.label).toBe('phase-x');
      expect(line.sub_label).toBe('phase-x.cross');
      expect(['reserve', 'record']).toContain(line.event as string);
    }
  });
});

describe('BudgetTracker.snapshot', () => {
  test('reports elapsed time + cumulative + caps', () => {
    const t = new BudgetTracker({ maxCostUsd: 1, maxRuntimeMs: 60_000, label: 'x', auditPath });
    const s = t.snapshot();
    expect(s.cumulativeCostUsd).toBe(0);
    expect(s.maxCostUsd).toBe(1);
    expect(s.maxRuntimeMs).toBe(60_000);
    expect(s.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(s.callsRecorded).toBe(0);
  });
});

describe('monthly Claude+DeepSeek budget helpers', () => {
  test('scope includes native Claude and DeepSeek but not OpenAI or OpenRouter-wrapped Claude', () => {
    expect(isModelInMonthlyBudgetScope('claude-opus-4-8')).toBe(true);
    expect(isModelInMonthlyBudgetScope('anthropic:claude-sonnet-4-6')).toBe(true);
    expect(isModelInMonthlyBudgetScope('deepseek:deepseek-v4-flash')).toBe(true);
    expect(isModelInMonthlyBudgetScope('openai:gpt-5')).toBe(false);
    expect(isModelInMonthlyBudgetScope('openrouter:anthropic/claude-sonnet-4-6')).toBe(false);
  });

  test('readback sums current-month actual scoped provider rows unless quarantined', () => {
    writeAuditRows([
      {
        schema_version: 1,
        ts: '2026-06-01T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        actual_cost_usd: 10,
      },
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'deepseek:deepseek-v4-flash',
        actual_cost_usd: 1.25,
      },
      {
        schema_version: 1,
        ts: '2026-05-31T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        actual_cost_usd: 100,
      },
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'openai:gpt-5',
        actual_cost_usd: 100,
      },
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'reserve',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        projected_cost_usd: 100,
      },
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        label: 'outer-test',
        actual_cost_usd: 100,
      },
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        sub_label: 'gateway.chat.failed',
        actual_cost_usd: 100,
      },
    ]);
    expect(readMonthlyChatSpendUsd({ auditPath, now: new Date('2026-06-18T00:00:00.000Z') })).toBe(111.25);
  });

  test('monthly cap does not infer test status from plausible propose_takes token counts', () => {
    writeAuditRows([
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'record',
        label: 'cycle.propose_takes',
        sub_label: 'gateway.chat',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        input_tokens: 1000,
        output_tokens: 500,
        actual_cost_usd: 0.0105,
      },
    ]);
    expect(readMonthlyChatSpendUsd({ auditPath, now: new Date('2026-06-18T00:00:00.000Z') })).toBe(0.0105);
  });

  test('monthly cap excludes fallback accounting rows from provider spend', () => {
    writeAuditRows([
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'record',
        label: 'gateway.chat',
        sub_label: 'gateway.chat.failed.fallback',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        input_tokens: 1000,
        output_tokens: 500,
        actual_cost_usd: 0.0105,
      },
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'record',
        label: 'gateway.chat',
        sub_label: 'gateway.chat.failed.provider_usage',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        input_tokens: 1000,
        output_tokens: 500,
        actual_cost_usd: 0.0205,
      },
    ]);
    expect(readMonthlyChatSpendUsd({ auditPath, now: new Date('2026-06-18T00:00:00.000Z') })).toBe(0.0205);
  });

  test('monthly cap skips explicitly quarantined local audit rows', () => {
    const quarantinedRow = {
      schema_version: 1,
      ts: '2026-06-17T00:00:00.000Z',
      event: 'record',
      label: 'cycle.propose_takes',
      sub_label: 'gateway.chat',
      kind: 'chat',
      model: 'anthropic:claude-sonnet-4-6',
      input_tokens: 1000,
      output_tokens: 500,
      actual_cost_usd: 0.0105,
    };
    writeAuditRows([
      quarantinedRow,
      {
        schema_version: 1,
        ts: '2026-06-17T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        actual_cost_usd: 0.25,
      },
    ]);
    writeFileSync(
      join(tmp, 'budget-quarantine.jsonl'),
      JSON.stringify({
        fingerprint: budgetAuditRowFingerprint(quarantinedRow),
        reason: 'legacy_local_test_fixture',
      }) + '\n',
      'utf-8',
    );
    expect(readMonthlyChatSpendUsd({ auditPath, now: new Date('2026-06-18T00:00:00.000Z') })).toBe(0.25);
  });

  test('DB config readback resolves the cap and defaults mode to block', async () => {
    const config = new Map([
      ['budget.monthly.chat_max_usd', '50'],
      ['budget.monthly.mode', 'block'],
    ]);
    const got = await resolveMonthlyBudgetCapFromEngine({
      getConfig: async (key: string) => config.get(key) ?? null,
    });
    expect(got).toEqual({ maxCostUsd: 50, mode: 'block' });
  });

  test('configured default applies to trackers without per-instance monthly options', () => {
    writeAuditRows([
      {
        schema_version: 1,
        ts: '2026-06-10T00:00:00.000Z',
        event: 'record',
        kind: 'chat',
        model: 'anthropic:claude-sonnet-4-6',
        actual_cost_usd: 49.99,
      },
    ]);
    configureBudgetTrackerDefaults({ monthlyBudget: { maxCostUsd: 50, mode: 'block' } });
    const t = new BudgetTracker({
      label: 'test',
      auditPath,
      monthlyNow: () => new Date('2026-06-18T00:00:00.000Z'),
    });
    expect(() =>
      t.reserve({
        modelId: 'claude-opus-4-8',
        estimatedInputTokens: 10_000,
        maxOutputTokens: 0,
        kind: 'chat',
      }),
    ).toThrow(BudgetExhausted);
    expect(readAudit().some((e) => e.event === 'monthly_budget_denied')).toBe(true);
  });
});
