/**
 * Do operator prompt overrides actually reach the model, and do the caches
 * keyed on prompt version notice?
 *
 * The sibling unit test (prompts-registry.test.ts) pins the registry and the
 * resolve/validate helpers in isolation. That is not enough: a call site can
 * import `resolvePromptText` and still send the built-in text, or send the
 * override while reusing verdicts a different prompt produced. These tests
 * drive real call sites end to end through their existing test seams and
 * assert on the text that reaches the model plus the version the cache is
 * keyed on.
 *
 * Three properties, one per describe:
 *   1. propose_takes — the override reaches the extractor AND digest-suffixes
 *      the prompt version written to take_proposals (cache invalidation).
 *   2. facts.extractor — the override REPLACES the built-in variant while the
 *      #3852 operator appendix still composes after it (the two mechanisms
 *      stack, they do not compete).
 *   3. think.system — the override replaces the base block and the
 *      conditional blocks still append after it.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import {
  runPhaseProposeTakes,
  EXTRACT_TAKES_PROMPT,
  PROPOSE_TAKES_PROMPT_VERSION,
  type ProposeTakesExtractor,
} from '../../src/core/cycle/propose-takes.ts';
import { buildExtractorSystem, extractFactsFromTurn } from '../../src/core/facts/extract.ts';
import { buildThinkSystemPrompt, THINK_SYSTEM_PROMPT_BASE } from '../../src/core/think/prompt.ts';
import { promptConfigKey } from '../../src/core/prompts/resolve.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Page } from '../../src/core/types.ts';

// ─── propose_takes ──────────────────────────────────────────────────

interface CapturedSql {
  sql: string;
  params: unknown[];
}

function proposeTakesEngine(config: Record<string, string>): { engine: BrainEngine; captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  const page = {
    id: 1,
    slug: 'wiki/concepts/network-effects',
    type: 'analysis',
    title: 'network effects',
    compiled_truth: 'Marketplaces with cold-start liquidity always win.',
    timeline: '',
    frontmatter: {},
    source_id: 'default',
    created_at: new Date(),
    updated_at: new Date(),
  } as Page;
  const engine = {
    kind: 'pglite',
    getConfig: async (key: string) => config[key] ?? null,
    async listPages() {
      return [page];
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes('SELECT slug, source_id, compiled_truth')) {
        return [{ slug: page.slug, source_id: page.source_id, compiled_truth: page.compiled_truth }] as T[];
      }
      if (sql.includes('SELECT id FROM take_proposals')) return [];
      if (sql.includes('INSERT INTO take_proposals')) return [{ id: 1 } as unknown as T];
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, captured };
}

function ctxFor(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

/** Runs the phase and reports what the extractor saw + what the INSERT banked. */
async function runProposeTakes(config: Record<string, string>): Promise<{
  templateSeen: string | undefined;
  promptVersion: unknown;
}> {
  const { engine, captured } = proposeTakesEngine(config);
  let templateSeen: string | undefined;
  const extractor: ProposeTakesExtractor = async (input) => {
    templateSeen = input.promptTemplate;
    return [{ claim_text: 'Cold-start liquidity decides marketplaces', kind: 'bet', holder: 'brain', weight: 0.7 }];
  };
  const result = await runPhaseProposeTakes(ctxFor(engine), { extractor });
  expect(result.status).toBe('ok');
  const insert = captured.find((c) => c.sql.includes('INSERT INTO take_proposals'));
  expect(insert).toBeDefined();
  // prompt_version is the 4th bound parameter (source_id, page_slug,
  // content_hash, prompt_version, …).
  return { templateSeen, promptVersion: insert!.params[3] };
}

describe('propose_takes honors a prompt override and re-keys its cache', () => {
  test('no override: the extractor gets the built-in prompt and the base version', async () => {
    const { templateSeen, promptVersion } = await runProposeTakes({});
    expect(templateSeen).toBe(EXTRACT_TAKES_PROMPT);
    expect(promptVersion).toBe(PROPOSE_TAKES_PROMPT_VERSION);
  });

  test('override: the extractor gets the override text', async () => {
    const custom = `${EXTRACT_TAKES_PROMPT}\n\nAlso reject claims with no named subject.`;
    const { templateSeen } = await runProposeTakes({ [promptConfigKey('cycle.propose_takes')]: custom });
    expect(templateSeen).toBe(custom);
  });

  test('override: prompt_version gains a content digest so cached pages re-judge', async () => {
    const custom = `${EXTRACT_TAKES_PROMPT}\n\nAlso reject claims with no named subject.`;
    const { promptVersion } = await runProposeTakes({ [promptConfigKey('cycle.propose_takes')]: custom });
    expect(promptVersion).not.toBe(PROPOSE_TAKES_PROMPT_VERSION);
    expect(String(promptVersion)).toMatch(
      new RegExp(`^${PROPOSE_TAKES_PROMPT_VERSION.replace(/[.+]/g, '\\$&')}\\+[0-9a-f]{8}$`),
    );
  });

  test('two different overrides key two different versions', async () => {
    const a = await runProposeTakes({ [promptConfigKey('cycle.propose_takes')]: `${EXTRACT_TAKES_PROMPT}\nA` });
    const b = await runProposeTakes({ [promptConfigKey('cycle.propose_takes')]: `${EXTRACT_TAKES_PROMPT}\nB` });
    expect(a.promptVersion).not.toBe(b.promptVersion);
  });
});

// ─── facts.extractor × the #3852 appendix ───────────────────────────

function chatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

// Shard hygiene: restore the legacy 1536-d embedding pin so later
// fresh-schema files in this shard don't inherit a dimensionless gateway.
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

async function factsSystemSentFor(config: Record<string, string>): Promise<string> {
  const engine = { getConfig: async (key: string) => config[key] ?? null } as unknown as BrainEngine;
  const seen: ChatOpts[] = [];
  __setChatTransportForTests(async (opts) => {
    seen.push(opts);
    return chatResult(JSON.stringify({
      facts: [{ fact: 'user gave up alcohol', kind: 'commitment', notability: 'high' }],
    }));
  });
  await extractFactsFromTurn({ turnText: 'I gave up alcohol.', source: 'test:prompt-override', engine });
  expect(seen).toHaveLength(1);
  return seen[0]!.system ?? '';
}

describe('facts.extractor override composes with the operator appendix', () => {
  const OVERRIDE = 'Extract only commitments. Output {"facts":[]} when there are none.';
  const APPENDIX = 'Durable-vs-ephemeral rubric: work-session narration is never a fact.';

  test('no override, no appendix: the built-in variant is sent unchanged', async () => {
    expect(await factsSystemSentFor({})).toBe(buildExtractorSystem(true));
  });

  test('override replaces the built-in variant wholesale', async () => {
    expect(await factsSystemSentFor({ [promptConfigKey('facts.extractor')]: OVERRIDE })).toBe(OVERRIDE);
  });

  test('override + appendix: the appendix still composes AFTER the override', async () => {
    expect(await factsSystemSentFor({
      [promptConfigKey('facts.extractor')]: OVERRIDE,
      'facts.extraction_prompt_appendix': APPENDIX,
    })).toBe(`${OVERRIDE}\n\n${APPENDIX}`);
  });

  test('appendix alone keeps its pre-existing behavior', async () => {
    expect(await factsSystemSentFor({ 'facts.extraction_prompt_appendix': APPENDIX }))
      .toBe(`${buildExtractorSystem(true)}\n\n${APPENDIX}`);
  });
});

// ─── think.system ───────────────────────────────────────────────────

describe('think.system override replaces the base block only', () => {
  test('no override: the prompt opens with the built-in base', () => {
    expect(buildThinkSystemPrompt({}).startsWith(THINK_SYSTEM_PROMPT_BASE)).toBe(true);
  });

  test('override replaces the base and the conditional blocks still append', () => {
    const out = buildThinkSystemPrompt({ baseOverride: 'CUSTOM BASE', anchor: 'acme-example' });
    expect(out.startsWith('CUSTOM BASE')).toBe(true);
    expect(out).not.toContain(THINK_SYSTEM_PROMPT_BASE);
    expect(out).toContain('acme-example');
  });
});
