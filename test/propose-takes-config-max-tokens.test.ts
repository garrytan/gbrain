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
});
