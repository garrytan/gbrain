/**
 * C-N5: the nightly probe runs inside the autopilot daemon, so its two eval
 * commands must leave the daemon's process-global gateway as they found it.
 *
 * Protects: after the real LongMemEval adapter runs, an embed call still
 * goes through the transport the daemon had (the eval embed cache used to
 * swap the transport for the run and restore the SDK default afterwards);
 * after the real cross-modal adapter runs, the chat model, provider chat
 * options and provider env the daemon configured are unchanged (the batch
 * used to rebuild the gateway from the file plane).
 * Fails when: the probe's LongMemEval call installs the embed cache, or the
 * cross-modal call reconfigures the gateway.
 * Seams: gateway test transports for chat and embed, an empty GBRAIN_HOME,
 * the committed 5-question mini fixture; no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  embed,
  getChatModel,
  requireConfig,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { runCrossModalBatchForProbe, runLongMemEvalForProbe } from '../src/core/cycle/nightly-probe-adapters.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const DAEMON_CHAT_MODEL = 'anthropic:claude-sonnet-4-6';
const DAEMON_CHAT_OPTIONS = { anthropic: { temperature: 0.1 } };

let dir: string;
let embedCalls: string[][];

function reply(model: string): ChatResult {
  return {
    text: 'widget-co',
    blocks: [{ type: 'text', text: 'widget-co' }],
    stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model,
    providerId: model.split(':')[0]!,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'probe-gateway-'));
  embedCalls = [];
  configureGateway({
    chat_model: DAEMON_CHAT_MODEL,
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: DIMS,
    provider_chat_options: DAEMON_CHAT_OPTIONS,
    env: { OPENAI_API_KEY: 'sk-fake', ANTHROPIC_API_KEY: 'sk-ant-fake' },
  } as Parameters<typeof configureGateway>[0]);
  __setEmbedTransportForTests((async (params: { values: string[] }) => {
    embedCalls.push([...params.values]);
    return {
      embeddings: params.values.map((_, i) => Array.from({ length: DIMS }, (__, j) => ((i + j) % 7) / 7)),
      values: params.values,
      warnings: [],
      usage: { tokens: params.values.length },
    };
  }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
  __setChatTransportForTests(async (opts) => reply(opts.model ?? DAEMON_CHAT_MODEL));
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  rmSync(dir, { recursive: true, force: true });
});

describe('the probe leaves the daemon gateway as it found it (C-N5)', () => {
  test('LongMemEval stage: embeds use the daemon transport during and after the run', async () => {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_MODEL: undefined }, async () => {
      await runLongMemEvalForProbe({
        fixturePath: join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl'),
        outputPath: join(dir, 'lme.jsonl'),
        searchConfigSnapshot: { 'search.reranker.enabled': 'false' },
      });
    });
    expect(embedCalls.length).toBeGreaterThan(0);
    const during = embedCalls.length;
    await embed(['after the probe']);
    expect(embedCalls.length).toBe(during + 1);
    expect(embedCalls.at(-1)).toEqual(['after the probe']);
  }, 120_000);

  test('cross-modal stage: chat model, provider chat options and provider env are unchanged', async () => {
    const before = requireConfig();
    const batchPath = join(dir, 'lme.jsonl');
    writeFileSync(batchPath, JSON.stringify({ question_id: 'q1', question: 'Where?', hypothesis: 'widget-co', answer: 'widget-co' }) + '\n');
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, () => runCrossModalBatchForProbe({
      batchPath,
      summaryPath: join(dir, 'summary.json'),
      maxUsd: 1,
      modelRoutes: {
        reader: { model: DAEMON_CHAT_MODEL, source: 'tier_config' },
        extractor: { model: 'anthropic:claude-haiku-4-5', source: 'tier_config' },
        slots: {},
      },
    }));
    const after = requireConfig();
    expect(getChatModel()).toBe(DAEMON_CHAT_MODEL);
    expect(after.provider_chat_options).toEqual(DAEMON_CHAT_OPTIONS);
    expect(after.env).toEqual(before.env);
    expect(after.embedding_model).toBe(before.embedding_model);
  }, 120_000);
});
