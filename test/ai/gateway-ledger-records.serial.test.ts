/**
 * #5585 — every gateway record site stamps the ledger contract fields
 * (requested model, purpose, failed, estimated) so `snapshot().models`
 * attributes each call to the right touchpoint and caller.
 *
 * Serial lane: installs gateway module state (chat / embed / rerank test
 * transports, configureGateway) and redirects GBRAIN_AUDIT_DIR.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chat,
  configureGateway,
  embed,
  rerank,
  resetGateway,
  toolLoop,
  withBudgetTracker,
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  __setRerankTransportForTests,
  type ChatOpts,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { DEFAULT_RERANKER_MODEL } from '../../src/core/ai/defaults.ts';
import { withEnv } from '../helpers/with-env.ts';

const SONNET = 'anthropic:claude-sonnet-4-6';

let tmp: string;
let tracker: BudgetTracker;

function reply(model: string): ChatResult {
  return {
    text: 'ok', blocks: [{ type: 'text', text: 'ok' }], stopReason: 'end',
    usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model, providerId: 'anthropic',
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-ledger-records-'));
  tracker = new BudgetTracker({ label: 'ledger-records', auditPath: join(tmp, 'budget.jsonl') });
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

describe('chat() record site', () => {
  test('success carries requested model + purpose; measured usage', async () => {
    __setChatTransportForTests(async (opts: ChatOpts) => reply(opts.model!));
    await withBudgetTracker(tracker, () => chat({ model: SONNET, messages: [{ role: 'user', content: 'hi' }], purpose: 'skillopt.judge' }));
    expect(tracker.snapshot().models).toEqual([expect.objectContaining({
      requested_model: SONNET, model: SONNET, touchpoint: 'chat', purpose: 'skillopt.judge',
      calls: 1, failed_calls: 0, input_tokens: 120, output_tokens: 30, cost_basis: 'measured',
    })]);
  });

  test('failure without reported usage -> failed call at the pessimistic estimate', async () => {
    __setChatTransportForTests(async () => { throw new Error('provider 500'); });
    await expect(withBudgetTracker(tracker, () =>
      chat({ model: SONNET, messages: [{ role: 'user', content: 'hi' }], maxTokens: 777, purpose: 'skillopt.optimizer' }),
    )).rejects.toThrow('provider 500');
    expect(tracker.snapshot().models).toEqual([expect.objectContaining({
      purpose: 'skillopt.optimizer', calls: 1, failed_calls: 1, output_tokens: 777, cost_basis: 'estimated',
    })]);
  });

  test('failure WITH reported usage stays measured', async () => {
    __setChatTransportForTests(async () => {
      throw Object.assign(new Error('cut'), { usage: { input_tokens: 50, output_tokens: 9 } });
    });
    await expect(withBudgetTracker(tracker, () => chat({ model: SONNET, messages: [{ role: 'user', content: 'hi' }] }))).rejects.toThrow();
    expect(tracker.snapshot().models).toEqual([expect.objectContaining({
      purpose: null, failed_calls: 1, input_tokens: 50, output_tokens: 9, cost_basis: 'measured',
    })]);
  });

  test('toolLoop forwards purpose to every chat turn', async () => {
    __setChatTransportForTests(async (opts: ChatOpts) => reply(opts.model!));
    await withBudgetTracker(tracker, () => toolLoop({
      model: SONNET, initialMessages: [{ role: 'user', content: 'go' }], tools: [], toolHandlers: new Map(),
      purpose: 'skillopt.target',
    }));
    expect(tracker.snapshot().models).toEqual([expect.objectContaining({ touchpoint: 'chat', purpose: 'skillopt.target', calls: 1 })]);
  });
});

describe('embed() record site', () => {
  test('char-estimated tokens -> estimated embedding row with the requested model', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 8, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests((async (args: { values: string[] }) => ({
      embeddings: args.values.map(() => Array.from({ length: 8 }, () => 0.1)),
      usage: { tokens: 3 },
    })) as never);
    await withBudgetTracker(tracker, () => embed(['alpha beta', 'gamma']));
    expect(tracker.snapshot().models).toEqual([expect.objectContaining({
      requested_model: 'openai:text-embedding-3-small', model: 'openai:text-embedding-3-small',
      touchpoint: 'embedding', calls: 1, failed_calls: 0, cost_basis: 'estimated',
    })]);
  });
});

describe('rerank() record site', () => {
  const gw = () => configureGateway({
    embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'pa-test' },
  });

  test('success -> estimated rerank row; HTTP failure -> failed call', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
      gw();
      __setRerankTransportForTests(async () => new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      await withBudgetTracker(tracker, () => rerank({ query: 'q', documents: ['d1'] }));
      __setRerankTransportForTests(async () => new Response('boom', { status: 500 }));
      await expect(withBudgetTracker(tracker, () => rerank({ query: 'q', documents: ['d1'] }))).rejects.toThrow();
    });
    expect(tracker.snapshot().models).toEqual([expect.objectContaining({
      model: DEFAULT_RERANKER_MODEL, touchpoint: 'rerank', calls: 2, attempts: 2, failed_calls: 1, cost_basis: 'estimated',
    })]);
  });
});
