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

import { describe, test, expect, beforeEach, afterAll, spyOn } from 'bun:test';
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
import { parsePhaseConfigValue } from '../src/core/cycle/phase-config-values.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
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

// #5958: dream.propose_takes.call_timeout_ms, read through
// cycle/phase-config-values.ts. The phase hands the extractor `callBoundMs`;
// a stored value it cannot use as written warns (key named, value never
// echoed), and the bound never outlasts the phase time left past the 90s floor.
const BOUND_KEY = 'dream.propose_takes.call_timeout_ms';

async function phaseRunWith(config: Record<string, string>, opts: { deadlineMs?: number } = {}) {
  const bounds: Array<number | undefined> = [];
  const extractor: ProposeTakesExtractor = async (input) => {
    bounds.push(input.callBoundMs);
    return [];
  };
  const result = await runPhaseProposeTakes(buildCtx(buildMockEngine(config)), { extractor, ...opts });
  const warnings = (result.details as { warnings: string[] }).warnings.filter((w) => w.includes(BOUND_KEY));
  return { bound: bounds[0], warnings, status: result.status };
}

describe('the phase resolves dream.propose_takes.call_timeout_ms into callBoundMs (#5958)', () => {
  test('an in-range whole number is passed through without a warning', async () => {
    const run = await phaseRunWith({ [BOUND_KEY]: '240000' });
    expect(run.bound).toBe(240_000);
    expect(run.warnings).toEqual([]);
  });

  test('control: unset or blank leaves the bound to the output-cap scaling, silently', async () => {
    for (const config of [{}, { [BOUND_KEY]: '' }, { [BOUND_KEY]: '   ' }] as Record<string, string>[]) {
      const run = await phaseRunWith(config);
      expect(run.bound).toBeUndefined();
      expect(run.warnings).toEqual([]);
      expect(run.status).not.toBe('warn');
    }
  });

  for (const raw of ['soon', '0', '-250', 'NaN']) {
    test(`unusable ${JSON.stringify(raw)} keeps the scaling and warns with the fix, not the value`, async () => {
      const run = await phaseRunWith({ [BOUND_KEY]: raw });
      expect(run.bound).toBeUndefined();
      expect(run.status).toBe('warn');
      expect(run.warnings).toHaveLength(1);
      expect(run.warnings[0]).toContain(`gbrain config set ${BOUND_KEY}`);
      expect(run.warnings[0]).toContain(`gbrain config get ${BOUND_KEY}`);
      if (raw.length > 2) expect(run.warnings[0]).not.toContain(raw);
    });
  }

  for (const [raw, held] of [['2500.9', 2_500], ['40', 1_000], ['450000', 300_000], ['9e15', 300_000]] as const) {
    test(`out-of-form ${raw} is held to ${held} with a warning`, async () => {
      const run = await phaseRunWith({ [BOUND_KEY]: raw });
      expect(run.bound).toBe(held);
      expect(run.status).toBe('warn');
      expect(run.warnings).toHaveLength(1);
      expect(run.warnings[0]).not.toContain(raw);
    });
  }

  test('an unreadable config row keeps the scaling and never fails the phase', async () => {
    const engine = buildMockEngine({});
    const readOther = engine.getConfig.bind(engine);
    engine.getConfig = async (key: string) => {
      if (key === BOUND_KEY) throw new Error('config table unavailable');
      return readOther(key);
    };
    const bounds: Array<number | undefined> = [];
    const result = await runPhaseProposeTakes(buildCtx(engine), {
      extractor: async (input) => { bounds.push(input.callBoundMs); return []; },
    });
    expect(bounds).toEqual([undefined]);
    expect(result.status).not.toBe('fail');
  });

  test('a short phase deadline caps the bound, but never below the 90s default', async () => {
    const roomy = await phaseRunWith({ [BOUND_KEY]: '280000' }, { deadlineMs: 200_000 });
    expect(roomy.bound!).toBeLessThanOrEqual(200_000);
    expect(roomy.bound!).toBeGreaterThan(199_000);
    const tight = await phaseRunWith({ [BOUND_KEY]: '280000' }, { deadlineMs: 5_000 });
    expect(tight.bound).toBe(90_000);
  });

  test('control: a bound already under the time left is not raised toward it', async () => {
    const run = await phaseRunWith({ [BOUND_KEY]: '120000' }, { deadlineMs: 900_000 });
    expect(run.bound).toBe(120_000);
  });
});

describe('the configured bound reaches the real gateway call (#5958)', () => {
  async function armedDuringPhase(config: Record<string, string>): Promise<number[]> {
    // The claude-cli shape: a clean stop every time, so no truncation retry.
    __setChatTransportForTests(async () => chatResult(GOOD_JSON, 'end'));
    const spy = spyOn(AbortSignal, 'timeout');
    try {
      const result = await runPhaseProposeTakes(buildCtx(buildMockEngine(config)), {});
      expect((result.details as { llm_calls_succeeded: number }).llm_calls_succeeded).toBe(1);
      return spy.mock.calls.map(([ms]) => ms);
    } finally {
      spy.mockRestore();
    }
  }

  test('a page that never truncates is bounded by the configured value', async () => {
    expect(await armedDuringPhase({ [BOUND_KEY]: '240000' })).toEqual([240_000]);
  });

  test('control: unset, the same page keeps the 90s base bound', async () => {
    expect(await armedDuringPhase({})).toEqual([90_000]);
  });
});

describe('config set validation for dream.propose_takes.call_timeout_ms (#5958)', () => {
  const KEY = 'dream.propose_takes.call_timeout_ms';
  test('the key is registered and an in-range whole number is accepted', () => {
    expect(KNOWN_CONFIG_KEYS).toContain(KEY);
    expect(parsePhaseConfigValue(KEY, '1000')).toBe(1_000);
    expect(parsePhaseConfigValue(KEY, '300000')).toBe(300_000);
  });

  for (const bad of ['999', '300001', '1500.5', 'banana', '0']) {
    test(`${JSON.stringify(bad)} is refused with the rendered contract and never echoed`, () => {
      let err: unknown;
      try { parsePhaseConfigValue(KEY, bad); } catch (e) { err = e; }
      const rendered = renderCliError(err, { json: true, command: 'config', tty: false });
      expect(rendered.exitCode).toBe(2);
      const env = JSON.parse(rendered.stdout!);
      expect(env).toMatchObject({
        code: 'invalid_params',
        fix: { argv: ['gbrain', 'config', 'set', KEY, '<VALUE>'], verify: { argv: ['gbrain', 'config', 'get', KEY] } },
      });
      expect(env.message).toContain('1000 to 300000');
      expect(env.why).toContain('Nothing was written');
      if (bad.length > 1) expect(rendered.stdout).not.toContain(bad);
    });
  }
});

