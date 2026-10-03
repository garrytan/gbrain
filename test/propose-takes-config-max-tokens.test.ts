/**
 * #4494 — propose_takes extractor output caps are configurable.
 *
 * Pre-fix, PROPOSE_TAKES_MAX_TOKENS=2048 / PROPOSE_TAKES_RETRY_MAX_TOKENS=4096
 * were hardcoded exports with no config read. Thinking models spend reasoning
 * tokens INSIDE maxTokens, so dense pages truncated at 2048, retried at 4096,
 * truncated again, threw, and were re-billed every cycle forever.
 *
 * Post-fix: dream.propose_takes.max_tokens / dream.propose_takes.retry_max_tokens
 * (floor 256; retry clamped >= base) resolve at the phase's engine.getConfig
 * seam (dream.triage.max_tokens precedent) and thread into defaultExtractor.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  AI_CHAT_TIMEOUT_MS,
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import {
  runPhaseProposeTakes,
  defaultExtractor,
  PROPOSE_TAKES_MAX_TOKENS,
  PROPOSE_TAKES_RETRY_MAX_TOKENS,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function chatResult(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

const GOOD_JSON = '[{"claim_text":"Acme doubles ARR by Q4","kind":"bet","holder":"brain","weight":0.7}]';

const baseInput = {
  pagePath: 'companies/acme-example',
  pageBody: 'I bet Acme doubles ARR by Q4.',
  existingTakes: [],
};

describe('defaultExtractor configurable caps (#4494)', () => {
  test('input.maxTokens overrides the base cap', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor({ ...baseInput, maxTokens: 8192 });
    expect(seen).toHaveLength(1);
    expect(seen[0].maxTokens).toBe(8192);
  });

  test('truncation retry uses retryMaxTokens (clamped >= base)', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return seen.length === 1
        ? chatResult('[{"claim_text":"tru', 'length')
        : chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor({ ...baseInput, maxTokens: 6000, retryMaxTokens: 3000 });
    expect(seen).toHaveLength(2);
    expect(seen[0].maxTokens).toBe(6000);
    // retry clamp: a retry cap below base escalates to at least base.
    expect(seen[1].maxTokens).toBe(6000);
  });

  test('floor: sub-256 maxTokens is raised to 256', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor({ ...baseInput, maxTokens: 16 });
    expect(seen[0].maxTokens).toBe(256);
  });

  test('defaults unchanged when no overrides are passed', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return seen.length === 1
        ? chatResult('trunc', 'length')
        : chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor(baseInput);
    expect(seen[0].maxTokens).toBe(PROPOSE_TAKES_MAX_TOKENS);
    expect(seen[1].maxTokens).toBe(PROPOSE_TAKES_RETRY_MAX_TOKENS);
  });
});

// ─── phase-level config threading ───────────────────────────────────

function buildMockEngine(config: Record<string, string>): BrainEngine {
  return {
    kind: 'pglite',
    async getConfig(key: string): Promise<string | null> {
      return config[key] ?? null;
    },
    async executeRaw<T>(sql: string): Promise<T[]> {
      if (sql.includes('SELECT slug, source_id, compiled_truth')) {
        return [{
          slug: 'wiki/page-0',
          source_id: 'default',
          compiled_truth: 'prose with a bold claim in it',
        }] as T[];
      }
      if (sql.includes('SELECT id FROM take_proposals')) return [];
      if (sql.includes('INSERT INTO take_proposals')) return [{ id: 1 } as unknown as T];
      return [];
    },
  } as unknown as BrainEngine;
}

function buildCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

describe('runPhaseProposeTakes threads dream.propose_takes.* config (#4494)', () => {
  test('configured caps reach the extractor input', async () => {
    const engine = buildMockEngine({
      'dream.propose_takes.max_tokens': '5000',
      'dream.propose_takes.retry_max_tokens': '9000',
    });
    const seen: Array<{ maxTokens?: number; retryMaxTokens?: number }> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push({ maxTokens: input.maxTokens, retryMaxTokens: input.retryMaxTokens });
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].maxTokens).toBe(5000);
    expect(seen[0].retryMaxTokens).toBe(9000);
  });

  test('unset config keeps the #3763 defaults; retry clamps to >= base', async () => {
    const engine = buildMockEngine({ 'dream.propose_takes.max_tokens': '6000' });
    const seen: Array<{ maxTokens?: number; retryMaxTokens?: number }> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push({ maxTokens: input.maxTokens, retryMaxTokens: input.retryMaxTokens });
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen[0].maxTokens).toBe(6000);
    // Default retry (4096) < configured base (6000) → clamped up to base.
    expect(seen[0].retryMaxTokens).toBe(6000);
  });

  test('garbage values fall back to defaults', async () => {
    const engine = buildMockEngine({
      'dream.propose_takes.max_tokens': 'banana',
      'dream.propose_takes.retry_max_tokens': '',
    });
    const seen: Array<{ maxTokens?: number; retryMaxTokens?: number }> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push({ maxTokens: input.maxTokens, retryMaxTokens: input.retryMaxTokens });
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen[0].maxTokens).toBe(PROPOSE_TAKES_MAX_TOKENS);
    expect(seen[0].retryMaxTokens).toBe(PROPOSE_TAKES_RETRY_MAX_TOKENS);
  });

  // #5874: the per-call timeout override. Blank reads as unset (as for the
  // caps above); a set value the phase cannot use as given warns instead of
  // vanishing, and a value above the gateway's own chat timeout is held to it.
  test.each([
    ['a positive value threads through', '240000', 240_000, false],
    ['a fractional value floors', '1500.7', 1_500, false],
    ['unset keeps the output-cap scaling', undefined, undefined, false],
    ['blank reads as unset', '  ', undefined, false],
    ['a non-number is ignored with a warning', 'banana', undefined, true],
    ['zero is ignored with a warning', '0', undefined, true],
    ['a negative value is ignored with a warning', '-5', undefined, true],
    ['above the gateway chat timeout is held to it with a warning', String(AI_CHAT_TIMEOUT_MS + 1), AI_CHAT_TIMEOUT_MS, true],
    ['a value AbortSignal.timeout rejects is held to the gateway chat timeout', '1e16', AI_CHAT_TIMEOUT_MS, true],
  ] as const)('call_timeout_ms: %s', async (_name, raw, expectedMs, warns) => {
    const engine = buildMockEngine(raw === undefined ? {} : { 'dream.propose_takes.call_timeout_ms': raw });
    const seen: Array<number | undefined> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push(input.callTimeoutMs);
      return [];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen).toEqual([expectedMs]);
    const warnings = (result.details as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('dream.propose_takes.call_timeout_ms'))).toBe(warns);
  });

  test('call_timeout_ms: a failed config read keeps the default and says so', async () => {
    const engine = buildMockEngine({});
    const getConfig = engine.getConfig.bind(engine);
    engine.getConfig = async (key: string) => {
      if (key === 'dream.propose_takes.call_timeout_ms') throw new Error('config plane down');
      return getConfig(key);
    };
    const seen: Array<number | undefined> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push(input.callTimeoutMs);
      return [];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen).toEqual([undefined]);
    const warnings = (result.details as { warnings: string[] }).warnings;
    expect(warnings).toContainEqual(expect.stringContaining('could not read dream.propose_takes.call_timeout_ms (config plane down)'));
  });
});
