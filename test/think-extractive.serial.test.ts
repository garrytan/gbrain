/**
 * WP2/T5 + E2 — synthesize compose status + extractive fallback.
 *
 * Pins the compose-failure precedence (registry refinement):
 *   - compose failed + NON-EMPTY gather → extractive fallback wins
 *     (synthesis_status: 'extractive_fallback'; answer digests + cites ONLY
 *     gathered pages)
 *   - compose failed + EMPTY gather → typed verbError('unavailable',
 *     'retrieved 0 pages; compose failed: <warning-code>')
 *   - no LLM configured → the [c10] `unavailable` error REGARDLESS of gather
 *     (an extractive digest would mask the misconfiguration forever)
 *   - client.create() throws (429/timeout/5xx/network) → 'llm_error' status
 *     (ENG-10 reachability), routed like any other compose failure
 *   - NEVER fabricate (ENG-19): extractive answers quote/cite only gathered
 *     pages; an empty gather never produces an answer.
 *
 * Serial (env-mutating): withEnv / withoutAnthropicKey touch process.env.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { RESPONSE_SCHEMAS } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';
import {
  runThink,
  persistSynthesis,
  composeExtractiveFallback,
  classifyLlmCallFailure,
  type ThinkLLMClient,
} from '../src/core/think/index.ts';
import type { SearchResult } from '../src/core/types.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { __setUsageLogPathForTests } from '../src/core/verbs/usage-log.ts';
import { withEnv } from './helpers/with-env.ts';
import { withoutAnthropicKey } from './helpers/no-anthropic-key.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-think-extractive-'));
  __setUsageLogPathForTests(join(home, 'usage.jsonl'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setUsageLogPathForTests(null);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
});

function localCtx(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  } as unknown as OperationContext;
}

const SEED_SLUG = 'notes/zephyrine-payments';
const SEED_TITLE = 'Zephyrine Payments';
const SEED_FACT = 'The Zephyrine payments migration finished in March with zero downtime.';

async function seedZephyrinePage() {
  const put = operationsByName['put_page'];
  await put.handler(localCtx(), {
    slug: SEED_SLUG,
    content: `---\ntitle: ${SEED_TITLE}\ntype: note\n---\n\n# ${SEED_TITLE}\n\n${SEED_FACT}\n`,
  });
}

/** Remote-shaped synthesize call through the shared dispatcher. */
async function callSynthesize(question: string) {
  const res = await dispatchToolCall(engine, 'synthesize', { question }, {
    remote: true,
    takesHoldersAllowList: ['world'],
    sourceId: 'default',
  });
  return { isError: res.isError === true, body: JSON.parse(res.content[0].text) };
}

function chatResultOf(text: string): ChatResult {
  return {
    text,
    blocks: [],
    stopReason: 'end' as const,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5-20251001',
    providerId: 'anthropic',
  } as ChatResult;
}

/** Every `[slug]` marker in an extractive answer. */
function citedSlugs(answer: string): string[] {
  return [...answer.matchAll(/\[([a-z0-9][a-z0-9\-]*(?:\/[a-z0-9][a-z0-9\-]*)*)\]/g)].map(m => m[1]);
}

describe('composeExtractiveFallback — ENG-19 never-fabricate pins', () => {
  const pages = [
    { slug: 'notes/alpha', title: 'Alpha Note', chunk_text: 'Alpha content about zebras migrating north in spring.' },
    { slug: 'notes/beta', title: 'Beta Note', chunk_text: 'Beta content: quokkas photographed on the island.' },
  ] as unknown as SearchResult[];

  it('empty gather NEVER produces an answer — returns null', () => {
    expect(composeExtractiveFallback([], 'anything at all')).toBeNull();
  });

  it('quotes + cites ONLY the gathered pages (page-level citations, gather order)', () => {
    const r = composeExtractiveFallback(pages, 'zebras migrating');
    expect(r).not.toBeNull();
    expect(r!.citations.map(c => c.page_slug)).toEqual(['notes/alpha', 'notes/beta']);
    expect(r!.citations.every(c => c.row_num === null)).toBe(true);
    expect(r!.citations.map(c => c.citation_index)).toEqual([1, 2]);
    // Every [slug] marker in the answer is one of the inputs — nothing invented.
    expect([...new Set(citedSlugs(r!.answer))].sort()).toEqual(['notes/alpha', 'notes/beta']);
    // The digest quotes input content verbatim (title + excerpt window).
    expect(r!.answer).toContain('Alpha content about zebras');
    expect(r!.answer).toContain('quokkas');
    expect(r!.answer).toContain('Alpha Note');
  });

  it('caps the digest at the top 5 pages', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      slug: `notes/p-${i}`, title: `Page ${i}`, chunk_text: `Content number ${i}.`,
    })) as unknown as SearchResult[];
    const r = composeExtractiveFallback(many, 'content');
    expect(r!.citations).toHaveLength(5);
    expect(citedSlugs(r!.answer)).toHaveLength(5);
  });
});

describe('classifyLlmCallFailure — D6 closed vocabulary', () => {
  it('maps error shapes onto the closed set (raw detail never rides the wire)', () => {
    expect(classifyLlmCallFailure(new Error('Request timed out after 60000ms'))).toBe('timeout');
    expect(classifyLlmCallFailure(new Error('429 rate limited'))).toBe('rate_limited');
    expect(classifyLlmCallFailure(new Error('rate_limit_error: overloaded'))).toBe('rate_limited');
    expect(classifyLlmCallFailure(new Error('fetch failed: ECONNREFUSED 10.0.0.1'))).toBe('network');
    expect(classifyLlmCallFailure(new Error('internal server error'))).toBe('provider_error');
    expect(classifyLlmCallFailure('not even an Error')).toBe('provider_error');
  });
});

describe('runThink — llm_error reachability (ENG-10: create() throws)', () => {
  it('a thrown 429/network error becomes synthesis_status llm_error + LLM_CALL_FAILED warning', async () => {
    await seedZephyrinePage();
    const throwing: ThinkLLMClient = {
      create: async () => { throw new Error('simulated 429 rate limited'); },
    };
    const result = await runThink(engine, {
      question: 'Zephyrine payments migration status',
      client: throwing,
      withTrajectory: false,
    });
    expect(result.synthesis_status).toBe('llm_error');
    expect(result.synthesisOk).toBe(false);
    // D6 closed vocabulary: the wire carries the coarse class, never the raw
    // provider message.
    expect(result.warnings).toContain('LLM_CALL_FAILED: rate_limited');
    expect(result.warnings.some(w => w.includes('simulated'))).toBe(false);
    expect(result.usage).toBeNull();
    // Gather found the seeded page → extractive material rides the result.
    expect(result.pagesGathered).toBeGreaterThanOrEqual(1);
    expect(result.extractive).toBeDefined();
    expect(result.extractive!.citations.map(c => c.page_slug)).toContain(SEED_SLUG);
    // #1698 persist gate holds: an llm_error result is never persisted.
    const saved = await persistSynthesis(engine, result);
    expect(saved.slug).toBe('');
    expect(saved.warnings).toContain('SYNTHESIS_EMPTY_NOT_PERSISTED');
  });

  it('explicit-model AIConfigError stays a HARD error (#1698 contract preserved)', async () => {
    const throwing: ThinkLLMClient = {
      create: async () => { throw new AIConfigError('key revoked mid-run'); },
    };
    await expect(
      runThink(engine, { question: 'x', client: throwing, modelExplicit: true, withTrajectory: false }),
    ).rejects.toThrow('key revoked mid-run');
  });

  it('BudgetExhausted propagates — spend control must stop the enclosing loop', async () => {
    class FakeBudgetExhausted extends Error {
      constructor() { super('budget gone'); this.name = 'BudgetExhausted'; }
    }
    const throwing: ThinkLLMClient = {
      create: async () => { throw new FakeBudgetExhausted(); },
    };
    await expect(
      runThink(engine, { question: 'x', client: throwing, withTrajectory: false }),
    ).rejects.toThrow('budget gone');
  });
});

describe('synthesize verb — compose-failure precedence (via dispatch)', () => {
  it('not_json (refusal prose) + non-empty gather → extractive_fallback citing only gathered pages', async () => {
    await seedZephyrinePage();
    __setChatTransportForTests(async () => chatResultOf('I cannot help with that request.'));
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
      callSynthesize('Zephyrine payments migration status?'),
    );
    expect(isError).toBe(false);
    expect(body.synthesis_status).toBe('extractive_fallback');
    expect(body.warnings).toContain('LLM_OUTPUT_NOT_JSON');
    expect(body.pages_gathered).toBeGreaterThanOrEqual(1);
    expect(typeof body.takes_gathered).toBe('number');
    expect(body.sources).toContain(SEED_SLUG);
    // ENG-19: every citation in the answer is a gathered page; the digest
    // quotes gathered content, not the refusal prose.
    expect(citedSlugs(body.answer)).toContain(SEED_SLUG);
    expect(citedSlugs(body.answer).every(s => s === SEED_SLUG)).toBe(true);
    expect(body.answer).toContain('Zephyrine');
    expect(body.answer).not.toContain('I cannot help');
    expect(body.protocol_version).toBe(1);
    expect(validateAgainstSchema(body, RESPONSE_SCHEMAS.synthesize)).toEqual([]);
  });

  it('empty_answer (valid JSON, empty answer) + non-empty gather → extractive_fallback', async () => {
    await seedZephyrinePage();
    __setChatTransportForTests(async () =>
      chatResultOf(JSON.stringify({ answer: '', citations: [], gaps: [] })),
    );
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
      callSynthesize('Zephyrine payments migration status?'),
    );
    expect(isError).toBe(false);
    expect(body.synthesis_status).toBe('extractive_fallback');
    expect(body.warnings).toContain('SYNTHESIS_EMPTY_ANSWER');
    expect(body.sources).toContain(SEED_SLUG);
    expect(validateAgainstSchema(body, RESPONSE_SCHEMAS.synthesize)).toEqual([]);
  });

  it('llm_error (chat transport throws) + non-empty gather → extractive_fallback', async () => {
    await seedZephyrinePage();
    __setChatTransportForTests(async () => { throw new Error('simulated 503 upstream'); });
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
      callSynthesize('Zephyrine payments migration status?'),
    );
    expect(isError).toBe(false);
    expect(body.synthesis_status).toBe('extractive_fallback');
    // '503 upstream' carries no timeout/rate-limit/network shape → provider_error.
    expect(body.warnings).toContain('LLM_CALL_FAILED: provider_error');
    expect(body.warnings.some((w: string) => w.includes('simulated'))).toBe(false);
    expect(body.sources).toContain(SEED_SLUG);
    expect(validateAgainstSchema(body, RESPONSE_SCHEMAS.synthesize)).toEqual([]);
  });

  it('llm_error + EMPTY gather → typed unavailable ("retrieved 0 pages; compose failed: LLM_CALL_FAILED")', async () => {
    // No pages seeded — gather retrieves nothing; an answer must NOT appear.
    __setChatTransportForTests(async () => { throw new Error('simulated 503 upstream'); });
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
      callSynthesize('question with no matching content anywhere'),
    );
    expect(isError).toBe(true);
    expect(body.error).toBe('unavailable');
    expect(body.message).toMatch(/retrieved 0 pages; compose failed: LLM_CALL_FAILED/);
    expect(body.suggestion.length).toBeGreaterThan(0);
    expect(body.detail).toContain('LLM_CALL_FAILED');
    expect(body.protocol_version).toBe(1);
  });

  it('not_json + EMPTY gather → typed unavailable naming LLM_OUTPUT_NOT_JSON', async () => {
    __setChatTransportForTests(async () => chatResultOf('plain prose, not JSON'));
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
      callSynthesize('question with no matching content anywhere'),
    );
    expect(isError).toBe(true);
    expect(body.error).toBe('unavailable');
    expect(body.message).toMatch(/retrieved 0 pages; compose failed: LLM_OUTPUT_NOT_JSON/);
  });

  it('no-key stub stays the [c10] unavailable error even with a NON-EMPTY gather', async () => {
    await seedZephyrinePage();
    const { isError, body } = await withoutAnthropicKey(() =>
      callSynthesize('Zephyrine payments migration status?'),
    );
    expect(isError).toBe(true);
    expect(body.error).toBe('unavailable');
    expect(body.message).toBe('synthesize needs an LLM and none is configured.');
    expect(body.suggestion).toContain('API key');
  });

  it('model_unusable + non-empty gather → extractive_fallback with the MODEL_NOT_USABLE warning', async () => {
    // voyage has no chat touchpoint — the deterministic unknown_model trigger
    // (same fixture think-pipeline.serial uses).
    await engine.setConfig('models.think', 'voyage:voyage-3');
    try {
      await seedZephyrinePage();
      const { isError, body } = await withoutAnthropicKey(() =>
        callSynthesize('Zephyrine payments migration status?'),
      );
      expect(isError).toBe(false);
      expect(body.synthesis_status).toBe('extractive_fallback');
      expect(body.warnings).toContain('MODEL_NOT_USABLE:unknown_model');
      expect(body.sources).toContain(SEED_SLUG);
      expect(validateAgainstSchema(body, RESPONSE_SCHEMAS.synthesize)).toEqual([]);
    } finally {
      await engine.unsetConfig('models.think');
    }
  });

  it('model_unusable + EMPTY gather → typed unavailable naming MODEL_NOT_USABLE', async () => {
    await engine.setConfig('models.think', 'voyage:voyage-3');
    try {
      const { isError, body } = await withoutAnthropicKey(() =>
        callSynthesize('question with no matching content anywhere'),
      );
      expect(isError).toBe(true);
      expect(body.error).toBe('unavailable');
      expect(body.message).toMatch(/retrieved 0 pages; compose failed: MODEL_NOT_USABLE/);
    } finally {
      await engine.unsetConfig('models.think');
    }
  });

  it('ok path carries the additive fields and synthesis_status ok', async () => {
    await seedZephyrinePage();
    __setChatTransportForTests(async () =>
      chatResultOf(JSON.stringify({
        answer: `Migration done [${SEED_SLUG}].`,
        citations: [{ page_slug: SEED_SLUG, row_num: null, citation_index: 1 }],
        gaps: [],
      })),
    );
    const { isError, body } = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
      callSynthesize('Zephyrine payments migration status?'),
    );
    expect(isError).toBe(false);
    expect(body.synthesis_status).toBe('ok');
    expect(body.answer).toContain('Migration done');
    expect(body.pages_gathered).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(validateAgainstSchema(body, RESPONSE_SCHEMAS.synthesize)).toEqual([]);
  });
});
