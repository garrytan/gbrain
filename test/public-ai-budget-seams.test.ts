/**
 * Downstream AI/runtime public seams.
 *
 * These imports intentionally use package subpaths. Relative imports would
 * bypass package.json exports and fail to prove that an installed consumer can
 * configure/probe the gateway or reuse the native budget primitives.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGatewayConfig, type AIGatewayConfig } from 'gbrain/ai/config';
import { getCurrentBudgetTracker, withBudgetTracker } from 'gbrain/ai/gateway';
import { probeOpenAICompat } from 'gbrain/ai/probes';
import { BudgetExhausted, BudgetTracker } from 'gbrain/budget/tracker';
import { BudgetError, BudgetLedger } from 'gbrain/budget/ledger';
import { reserve as reserveMcpSpend } from 'gbrain/budget/mcp';
import { withEnv } from './helpers/with-env.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function auditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-public-budget-'));
  tempDirs.push(dir);
  return join(dir, 'budget.jsonl');
}

describe('gbrain/ai/config', () => {
  test('builds the canonical gateway config and exports its return type', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      const config: AIGatewayConfig = buildGatewayConfig({
        engine: 'postgres',
        anthropic_api_key: 'test-config-key',
        chat_model: 'anthropic:claude-sonnet-4-6',
        provider_base_urls: { anthropic: 'https://provider.example.test/v1' },
      });

      expect(config.chat_model).toBe('anthropic:claude-sonnet-4-6');
      expect(config.env.ANTHROPIC_API_KEY).toBe('test-config-key');
      expect(config.base_urls?.anthropic).toBe('https://provider.example.test/v1');
    });
  });
});

describe('gbrain/ai/probes', () => {
  test('returns the native structured result for a valid models endpoint', async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await probeOpenAICompat('https://provider.example.test/v1', 50);
      expect(requestedUrl).toBe('https://provider.example.test/v1/models');
      expect(result).toEqual({ reachable: true, models_endpoint_valid: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('gbrain/budget/tracker', () => {
  test('composes with the public gateway AsyncLocalStorage seam', async () => {
    const tracker = new BudgetTracker({ label: 'downstream-test', auditPath: auditPath() });
    expect(getCurrentBudgetTracker()).toBeNull();

    await withBudgetTracker(tracker, async () => {
      expect(getCurrentBudgetTracker()).toBe(tracker);
    });

    expect(getCurrentBudgetTracker()).toBeNull();
  });

  test('preserves fail-closed no-pricing behavior under a cost cap', () => {
    const tracker = new BudgetTracker({
      label: 'downstream-test',
      maxCostUsd: 1,
      auditPath: auditPath(),
    });

    expect(() => tracker.reserve({
      modelId: 'unknown-provider:unknown-model',
      estimatedInputTokens: 1,
      maxOutputTokens: 1,
      kind: 'chat',
    })).toThrow(BudgetExhausted);
  });
});

describe('gbrain/budget/ledger', () => {
  test('preserves native input validation before touching an engine', async () => {
    const ledger = new BudgetLedger(null as never);
    let caught: unknown;
    try {
      await ledger.reserve({ resolverId: 'provider', estimateUsd: -0.01 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BudgetError);
    expect((caught as BudgetError).code).toBe('invalid_input');
  });
});

describe('gbrain/budget/mcp', () => {
  test('preserves native validation before touching an engine', async () => {
    await expect(reserveMcpSpend(null as never, {
      clientId: 'oauth-client',
      estimatedCents: Number.NaN,
      capCents: 100,
      model: 'provider:model',
      provider: 'provider',
    })).rejects.toThrow(TypeError);
  });
});
