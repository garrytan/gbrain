/**
 * #4737 — propose_takes model_id provenance is derived from the gateway
 * RESPONSE, not the request.
 *
 * Pre-fix, runPhaseProposeTakes stamped take_proposals.model_id with
 * `opts.model ?? getChatModel()` — the REQUESTED model string. When
 * alias/provider-recipe resolution routes the call elsewhere (NVIDIA NIM /
 * Groq-shaped gateways, provider fallbacks), ChatResult.model carries the
 * 'provider:modelId' that actually answered, and pending inbox rows lied
 * about which model produced them.
 *
 * Post-fix, defaultExtractor stamps `served_model` from ChatResult.model on
 * each ProposedTake and the phase prefers it over the requested model.
 * Injected test extractors that never set served_model keep the previous
 * requested-model stamp (fallback unchanged).
 *
 * Uses the gateway chat-transport test seam — no API key, no network.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import {
  runPhaseProposeTakes,
  defaultExtractor,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const CONFIGURED_MODEL = 'anthropic:claude-sonnet-4-6';
const SERVED_MODEL = 'openrouter:example/other-model';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: CONFIGURED_MODEL,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

// Shard hygiene (propose-takes-truncation.test.ts precedent): restore the
// legacy 1536-d embedding pin so later fresh-schema files in this shard
// don't inherit a dimensionless gateway.
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

const GOOD_JSON =
  '[{"claim_text":"Acme doubles ARR by Q4","kind":"bet","holder":"brain","weight":0.7}]';

function chatResult(text: string, model: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model,
    providerId: 'anthropic',
  } as ChatResult;
}

interface CapturedSql { sql: string; params: unknown[] }

function buildMockEngine(): { engine: BrainEngine; captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  const engine = {
    kind: 'pglite',
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes('SELECT slug, source_id, compiled_truth')) {
        return [{
          slug: 'wiki/one-page',
          source_id: 'default',
          compiled_truth: 'I bet Acme doubles ARR by Q4. They ship weekly.',
        }] as T[];
      }
      if (sql.includes('SELECT id FROM take_proposals')) return [];
      if (sql.includes('INSERT INTO take_proposals')) return [{ id: 1 } as unknown as T];
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, captured };
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

describe('defaultExtractor served-model stamp (#4737)', () => {
  test('attaches ChatResult.model as served_model on every take', async () => {
    __setChatTransportForTests(async () => chatResult(GOOD_JSON, SERVED_MODEL));
    const takes = await defaultExtractor({
      pagePath: 'companies/acme-example',
      pageBody: 'I bet Acme doubles ARR by Q4.',
      existingTakes: [],
    });
    expect(takes).toHaveLength(1);
    expect(takes[0]!.served_model).toBe(SERVED_MODEL);
  });
});

describe('defaultExtractor served-model stamp — blank response model is dropped (#4737)', () => {
  test.each([
    ['empty string', ''],
    ['whitespace-only', '   '],
    ['undefined', undefined],
  ])('a %s ChatResult.model leaves served_model unset on every take', async (_label, model) => {
    __setChatTransportForTests(async () => chatResult(GOOD_JSON, model as unknown as string));
    const takes = await defaultExtractor({
      pagePath: 'companies/acme-example',
      pageBody: 'I bet Acme doubles ARR by Q4.',
      existingTakes: [],
    });
    expect(takes).toHaveLength(1);
    expect(takes[0]!.served_model).toBeUndefined();
    expect('served_model' in takes[0]!).toBe(false);
  });
});

describe('runPhaseProposeTakes model_id provenance (#4737)', () => {
  test('blank served model: persisted model_id falls back to the configured model', async () => {
    // A transport that answers but reports no model must not stamp '' into
    // take_proposals.model_id — the requested (configured) model is the
    // honest fallback.
    __setChatTransportForTests(async () => chatResult(GOOD_JSON, ''));
    const { engine, captured } = buildMockEngine();
    const result = await runPhaseProposeTakes(buildCtx(engine), {});
    expect((result.details as Record<string, unknown>).proposals_inserted).toBe(1);

    const inserts = captured.filter(
      (c) => c.sql.includes('INSERT INTO take_proposals') && !c.sql.includes("'rejected'"),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[11]).toBe(CONFIGURED_MODEL);
    expect(inserts[0]!.params[11]).not.toBe('');
  });

  test('default extractor: model_id comes from the response, not the configured model', async () => {
    __setChatTransportForTests(async () => chatResult(GOOD_JSON, SERVED_MODEL));
    const { engine, captured } = buildMockEngine();
    const result = await runPhaseProposeTakes(buildCtx(engine), {});

    const details = result.details as Record<string, unknown>;
    expect(details.proposals_inserted).toBe(1);

    const inserts = captured.filter(
      (c) => c.sql.includes('INSERT INTO take_proposals') && !c.sql.includes("'rejected'"),
    );
    expect(inserts).toHaveLength(1);
    // Param 12 (index 11) is model_id.
    expect(inserts[0]!.params[11]).toBe(SERVED_MODEL);
    expect(inserts[0]!.params[11]).not.toBe(CONFIGURED_MODEL);
  });

  test('injected extractor without served_model: requested-model fallback unchanged', async () => {
    const { engine, captured } = buildMockEngine();
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: 'one good claim', kind: 'take', holder: 'brain', weight: 0.6 },
    ];
    await runPhaseProposeTakes(buildCtx(engine), { extractor, model: 'test:injected-model' });

    const inserts = captured.filter(
      (c) => c.sql.includes('INSERT INTO take_proposals') && !c.sql.includes("'rejected'"),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[11]).toBe('test:injected-model');
  });
});
