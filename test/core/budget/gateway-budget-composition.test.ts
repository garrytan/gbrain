/**
 * v0.37.x — TX5: gateway-layer enforcement via AsyncLocalStorage.
 *
 * Pins the public contract:
 *   - withBudgetTracker(tracker, fn) sets up an AsyncLocalStorage scope.
 *     Every gateway.chat / embed / rerank call inside the scope auto-
 *     composes the tracker without explicit per-call injection.
 *   - Nested scopes replace the active tracker for the inner closure and
 *     restore the outer tracker on exit.
 *   - Calls OUTSIDE any withBudgetTracker scope are ledgered by a per-call
 *     tracker, so paid provider calls cannot disappear from receipts.
 *
 * Hermetic: routes through __setChatTransportForTests so no network /
 * provider / env variable is touched.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chat,
  withBudgetTracker,
  getCurrentBudgetTracker,
  __setChatTransportForTests,
  __testing as gatewayTesting,
  type ChatOpts,
  type ChatResult,
} from '../../../src/core/ai/gateway.ts';
import {
  BudgetTracker,
  BudgetExhausted,
  configureBudgetTrackerDefaults,
  _resetBudgetTrackerWarningsForTest,
} from '../../../src/core/budget/budget-tracker.ts';
import { isoWeekFilename } from '../../../src/core/audit-week-file.ts';
import { withEnv } from '../../helpers/with-env.ts';

let tmp: string;
let auditPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-gw-budget-'));
  auditPath = join(tmp, 'budget.jsonl');
  _resetBudgetTrackerWarningsForTest();
});

afterEach(() => {
  __setChatTransportForTests(null);
  configureBudgetTrackerDefaults({});
  rmSync(tmp, { recursive: true, force: true });
});

async function withAuditDir<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_AUDIT_DIR: tmp }, fn);
}

function fakeChatTransport(usage = { input_tokens: 100, output_tokens: 50 }) {
  let calls = 0;
  const fn = async (_opts: ChatOpts): Promise<ChatResult> => {
    calls++;
    return {
      text: 'ok',
      blocks: [{ type: 'text', text: 'ok' }],
      stopReason: 'end',
      model: 'claude-haiku-4-5-20251001',
      providerId: 'anthropic',
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
    };
  };
  return Object.assign(fn, { get calls() { return calls; } });
}

describe('gateway chat usage normalization', () => {
  test('uses AI SDK inputTokenDetails so cached tokens are not double-counted', () => {
    expect(gatewayTesting.normalizeChatUsageForBudget({
      inputTokens: 118,
      outputTokens: 50,
      inputTokenDetails: {
        noCacheTokens: 100,
        cacheReadTokens: 7,
        cacheWriteTokens: 11,
      },
    }, undefined)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 7,
      cacheCreationTokens: 11,
    });
  });

  test('falls back to Anthropic raw usage metadata when SDK details are absent', () => {
    expect(gatewayTesting.normalizeChatUsageForBudget({
      inputTokens: 118,
      outputTokens: 50,
    }, {
      anthropic: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 11,
        },
      },
    })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 7,
      cacheCreationTokens: 11,
    });
  });
});

describe('withBudgetTracker — scope semantics', () => {
  test('chat() inside scope auto-composes the tracker', async () => {
    const tracker = new BudgetTracker({ maxCostUsd: 1.0, label: 'test-gw', auditPath });
    const transport = fakeChatTransport({ input_tokens: 1000, output_tokens: 500 });
    __setChatTransportForTests(transport);

    expect(getCurrentBudgetTracker()).toBeNull();

    await withBudgetTracker(tracker, async () => {
      expect(getCurrentBudgetTracker()).toBe(tracker);
      await chat({
        model: 'claude-haiku-4-5-20251001',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      });
    });

    expect(getCurrentBudgetTracker()).toBeNull();
    // Haiku: 1K in + 500 out → ($1/M × 1K) + ($5/M × 500) = $0.001 + $0.0025 = $0.0035
    expect(tracker.totalSpent).toBeCloseTo(0.0035, 6);
    expect(tracker.snapshot().callsRecorded).toBe(1);
  });

  test('chat() OUTSIDE any scope writes a ledger-only receipt', async () => {
    const transport = fakeChatTransport();
    __setChatTransportForTests(transport);
    // No withBudgetTracker wrapper: the gateway still emits reserve + record
    // rows under a per-call ledger-only tracker.
    await withAuditDir(async () => {
      await chat({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
      });
    });
    expect(getCurrentBudgetTracker()).toBeNull();

    const receiptPath = join(tmp, isoWeekFilename('budget'));
    expect(existsSync(receiptPath)).toBe(true);
    const rows = readFileSync(receiptPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows.map(r => r.event)).toEqual(['reserve', 'record']);
    expect(rows.every(r => r.label === 'gateway.unscoped')).toBe(true);
    expect(rows[1].actual_cost_usd).toBeGreaterThan(0);
  });

  test('chat() OUTSIDE any scope applies the configured monthly default before provider spend', async () => {
    const transport = fakeChatTransport();
    __setChatTransportForTests(transport);
    configureBudgetTrackerDefaults({
      monthlyBudget: { maxCostUsd: 0.0001, mode: 'block' },
    });

    await withAuditDir(async () => {
      await expect(chat({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4096,
      })).rejects.toThrow(BudgetExhausted);
    });

    expect(transport.calls).toBe(0);

    const receiptPath = join(tmp, isoWeekFilename('budget'));
    const rows = readFileSync(receiptPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows.map(r => r.event)).toEqual(['monthly_budget_denied']);
    expect(rows[0].label).toBe('gateway.unscoped');
    expect(rows[0].sub_label).toBe('gateway.chat');
  });

  test('chat() OUTSIDE any scope uses an explicit budget label for attribution', async () => {
    const transport = fakeChatTransport();
    __setChatTransportForTests(transport);

    await withAuditDir(async () => {
      await chat({
        model: 'claude-haiku-4-5-20251001',
        budgetLabel: 'contextual_retrieval.synopsis',
        messages: [{ role: 'user', content: 'hi' }],
      });
    });

    const receiptPath = join(tmp, isoWeekFilename('budget'));
    const rows = readFileSync(receiptPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows.map(r => r.event)).toEqual(['reserve', 'record']);
    expect(rows.every(r => r.label === 'contextual_retrieval.synopsis')).toBe(true);
    expect(rows.every(r => r.sub_label === 'contextual_retrieval.synopsis')).toBe(true);
  });

  test('chat() INSIDE a scope keeps the outer label and uses the explicit budget label as sub-label', async () => {
    const transport = fakeChatTransport();
    __setChatTransportForTests(transport);
    const tracker = new BudgetTracker({ maxCostUsd: 1.0, label: 'outer-scope', auditPath });

    await withBudgetTracker(tracker, async () => {
      await chat({
        model: 'claude-haiku-4-5-20251001',
        budgetLabel: 'think.answer',
        messages: [{ role: 'user', content: 'hi' }],
      });
    });

    const rows = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows.map(r => r.event)).toEqual(['reserve', 'record']);
    expect(rows.every(r => r.label === 'outer-scope')).toBe(true);
    expect(rows.every(r => r.sub_label === 'think.answer')).toBe(true);
  });

  test('failed chat calls with provider usage keep provider-usage accounting labels', async () => {
    const transport = async (): Promise<ChatResult> => {
      const err = new Error('provider exploded') as Error & { usage?: Record<string, number> };
      err.usage = { input_tokens: 100, output_tokens: 50 };
      throw err;
    };
    __setChatTransportForTests(transport);

    await withAuditDir(async () => {
      await expect(chat({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('provider exploded');
    });

    const receiptPath = join(tmp, isoWeekFilename('budget'));
    const rows = readFileSync(receiptPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows.map(r => r.event)).toEqual(['reserve', 'record']);
    expect(rows[1].sub_label).toBe('gateway.chat.failed.provider_usage');
    expect(rows[1].actual_cost_usd).toBeGreaterThan(0);
  });

  test('failed chat calls without provider usage mark fallback accounting rows', async () => {
    const transport = async (): Promise<ChatResult> => {
      throw new Error('provider exploded before usage');
    };
    __setChatTransportForTests(transport);

    await withAuditDir(async () => {
      await expect(chat({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
      })).rejects.toThrow('provider exploded before usage');
    });

    const receiptPath = join(tmp, isoWeekFilename('budget'));
    const rows = readFileSync(receiptPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows.map(r => r.event)).toEqual(['reserve', 'record']);
    expect(rows[1].sub_label).toBe('gateway.chat.failed.fallback');
    expect(rows[1].actual_cost_usd).toBeGreaterThan(0);
  });

  test('nested scopes restore outer tracker on exit', async () => {
    const outer = new BudgetTracker({ maxCostUsd: 1.0, label: 'outer', auditPath });
    const inner = new BudgetTracker({ maxCostUsd: 1.0, label: 'inner', auditPath: join(tmp, 'inner.jsonl') });

    await withBudgetTracker(outer, async () => {
      expect(getCurrentBudgetTracker()).toBe(outer);
      await withBudgetTracker(inner, async () => {
        expect(getCurrentBudgetTracker()).toBe(inner);
      });
      expect(getCurrentBudgetTracker()).toBe(outer);
    });
    expect(getCurrentBudgetTracker()).toBeNull();
  });

  test('over-cap chat call throws BudgetExhausted via reserve()', async () => {
    const tracker = new BudgetTracker({ maxCostUsd: 0.001, label: 'tight', auditPath });
    const transport = fakeChatTransport();
    __setChatTransportForTests(transport);

    let caught: unknown = null;
    await withBudgetTracker(tracker, async () => {
      try {
        await chat({
          // Opus 4.7 with high maxTokens → projected cost > $0.001
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'a'.repeat(40_000) }],
          maxTokens: 4096,
        });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('cost');
    // The transport should NOT have been called — reserve() fired first.
    expect(transport.calls).toBe(0);
  });

  test('TX1 mid-run: cumulative > cap throws via record() after the call', async () => {
    // Reserve passes (small input estimate); record() over-shoots cap.
    const tracker = new BudgetTracker({ maxCostUsd: 0.005, label: 'tx1', auditPath });
    // Mock transport reports huge actual usage
    const transport = fakeChatTransport({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    __setChatTransportForTests(transport);

    // First call: reserve fits (small chars), record() over-shoots and TX1
    // suppresses internally. Second call: reserve sees cumulative > cap.
    await withBudgetTracker(tracker, async () => {
      // First call — record() throws internally but is suppressed.
      await chat({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'short' }],
        maxTokens: 100,
      });
      expect(tracker.totalSpent).toBeGreaterThan(0.005);

      // Second call: reserve() sees cumulative > cap and throws.
      let caught: unknown = null;
      try {
        await chat({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'short' }],
          maxTokens: 100,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BudgetExhausted);
      expect((caught as BudgetExhausted).reason).toBe('cost');
    });
  });
});

describe('AsyncLocalStorage isolation', () => {
  test('parallel withBudgetTracker scopes do not bleed trackers', async () => {
    const t1 = new BudgetTracker({ maxCostUsd: 1.0, label: 'parallel-1', auditPath });
    const t2 = new BudgetTracker({ maxCostUsd: 1.0, label: 'parallel-2', auditPath: join(tmp, 'p2.jsonl') });
    const transport = fakeChatTransport({ input_tokens: 1000, output_tokens: 500 });
    __setChatTransportForTests(transport);

    await Promise.all([
      withBudgetTracker(t1, async () => {
        await chat({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'a' }] });
      }),
      withBudgetTracker(t2, async () => {
        await chat({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'b' }] });
      }),
    ]);

    // Each tracker should have exactly 1 recorded call.
    expect(t1.snapshot().callsRecorded).toBe(1);
    expect(t2.snapshot().callsRecorded).toBe(1);
  });
});
