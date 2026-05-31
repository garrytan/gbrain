/**
 * longmemeval answer-gen routes through gateway.chat() (not `new Anthropic()`).
 *
 * Proves the fix for the provider-prefix 404 class: `resolveModel` returns a
 * provider-prefixed id (`anthropic:claude-sonnet-4-6` from the `sonnet`
 * fallback). The old code passed that raw to `new Anthropic().messages.create`,
 * which 404s because the Anthropic SDK only accepts a bare model id. Routing
 * through the gateway (via the exported `tryBuildGatewayClient` adapter, the
 * same seam `think` uses) accepts the prefixed id and dispatches it correctly.
 *
 * Hermetic: PGLite in-memory + a stubbed gateway chat transport (no real API
 * call). Critically, NO client is injected via runOpts, so the
 * `tryBuildGatewayClient` path actually runs — the existing
 * `longmemeval-trajectory-routing` tests inject `runOpts.client` and therefore
 * never exercise this path. `--keyword-only` skips embeddings; `--no-trajectory`
 * isolates the single answer-gen call.
 *
 * Mirrors test/longmemeval-trajectory-routing.test.ts (harness setup) +
 * test/think-gateway-adapter.test.ts (transport stub).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import type { LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';

let tmpDir: string;
let datasetPath: string;
let outputPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lme-gateway-'));
  datasetPath = join(tmpDir, 'dataset.jsonl');
  outputPath = join(tmpDir, 'output.jsonl');

  const questions: LongMemEvalQuestion[] = [
    {
      question_id: 'q1',
      question_type: 'single-session-user',
      question: 'What coffee did I mention?',
      answer: 'placeholder',
      haystack_sessions: [
        { session_id: 'sess-1', turns: [
          { role: 'user', content: 'I had a Blue Bottle coffee this morning' },
        ]},
      ],
      answer_session_ids: ['sess-1'],
      haystack_dates: ['2026-01-15'],
    },
  ];
  writeFileSync(datasetPath, questions.map(q => JSON.stringify(q)).join('\n'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

function readOutput(): Array<Record<string, unknown>> {
  const raw = readFileSync(outputPath, 'utf-8').trim();
  return raw.split('\n').map(line => JSON.parse(line));
}

describe('runEvalLongMemEval — answer-gen routes through the gateway', () => {
  test('a provider-prefixed model id reaches gateway.chat (the case new Anthropic() 404s on)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake' }, async () => {
      let receivedModel = '';
      let calls = 0;
      __setChatTransportForTests(async (opts): Promise<ChatResult> => {
        receivedModel = opts.model ?? '';
        calls++;
        return {
          text: 'Blue Bottle',
          blocks: [],
          stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: opts.model ?? 'unknown',
          providerId: 'anthropic',
        };
      });

      // No --model → resolveModel falls back to `sonnet` →
      // `anthropic:claude-sonnet-4-6`. No injected client → tryBuildGatewayClient
      // builds the gateway-routed client. The dummy ANTHROPIC_API_KEY satisfies
      // tryBuildGatewayClient's key probe.
      await runEvalLongMemEval(
        [datasetPath, '--keyword-only', '--no-trajectory', '--output', outputPath],
        {},
      );

      // The answer-gen call dispatched through the gateway...
      expect(calls).toBeGreaterThan(0);
      // ...carrying the PROVIDER-PREFIXED id. Under the old `new Anthropic()`
      // path this exact string 404'd; the gateway accepts and routes it.
      expect(receivedModel).toBe('anthropic:claude-sonnet-4-6');

      // And the run completed end-to-end, emitting a per-question row.
      const out = readOutput();
      expect(out.length).toBe(1);
    });
  });

  test('an already-bare model id (--model claude-sonnet-4-6) also routes cleanly', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake' }, async () => {
      let receivedModel = '';
      __setChatTransportForTests(async (opts): Promise<ChatResult> => {
        receivedModel = opts.model ?? '';
        return {
          text: 'Blue Bottle',
          blocks: [],
          stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: opts.model ?? 'unknown',
          providerId: 'anthropic',
        };
      });

      await runEvalLongMemEval(
        [datasetPath, '--keyword-only', '--no-trajectory', '--model', 'claude-sonnet-4-6', '--output', outputPath],
        {},
      );

      // tryBuildGatewayClient normalizes a bare id by adding the anthropic:
      // prefix, so the gateway sees the canonical provider:model form either way.
      expect(receivedModel).toBe('anthropic:claude-sonnet-4-6');
      expect(readOutput().length).toBe(1);
    });
  });
});

describe('runEvalLongMemEval — trajectory ON (the nightly-probe production path)', () => {
  test('extractor AND answer-gen both route through the gateway, and the answer round-trips', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake' }, async () => {
      let extractorModelSeen = '';
      let answerModelSeen = '';
      const ANSWER_TEXT = 'Blue Bottle (gateway round-trip)';
      // One global transport for BOTH call sites; branch on the model. The
      // extractor resolves to the utility tier (haiku); the answer-gen to the
      // sonnet fallback. No clients injected → both go through
      // tryBuildGatewayClient, which is the production default since the nightly
      // probe runs WITHOUT --no-trajectory.
      __setChatTransportForTests(async (opts): Promise<ChatResult> => {
        const model = opts.model ?? '';
        const base = {
          blocks: [] as [],
          stopReason: 'end' as const,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model,
          providerId: 'anthropic',
        };
        if (model.includes('haiku')) {
          extractorModelSeen = model;
          return { ...base, text: JSON.stringify([]) }; // extractor: empty claims array (valid JSON)
        }
        answerModelSeen = model;
        return { ...base, text: ANSWER_TEXT };
      });

      await runEvalLongMemEval(
        [datasetPath, '--keyword-only', '--output', outputPath],
        {},
      );

      // Extractor (utility tier → haiku) reached the gateway with a PREFIXED id.
      expect(extractorModelSeen).toContain('haiku');
      expect(extractorModelSeen.startsWith('anthropic:')).toBe(true);
      // Answer-gen (sonnet fallback) reached the gateway with the prefixed id.
      expect(answerModelSeen).toBe('anthropic:claude-sonnet-4-6');
      // The stubbed answer round-tripped through chatResultToMessage into the
      // output `hypothesis` field — proves the single-text-block adapter shape
      // is consumed correctly by generateAnswer (not just "didn't crash").
      const out = readOutput();
      expect(out.length).toBe(1);
      expect(out[0].hypothesis).toContain(ANSWER_TEXT);
    });
  });
});

describe('runEvalLongMemEval — --retrieval-only needs no chat client', () => {
  test('runs with no client and no key (must NOT build/require the gateway client)', async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      // Regression guard: --retrieval-only never calls the answer-gen client.
      // The gateway refactor must skip building it in this mode rather than
      // process.exit(1) when no key is configured — otherwise the keyless CI
      // e2e (test/eval-longmemeval-e2e.slow.test.ts) dies. No transport stub,
      // no injected client, no key on purpose: if process.exit fired, this test
      // process would be killed before the assertions run.
      await runEvalLongMemEval(
        [datasetPath, '--keyword-only', '--retrieval-only', '--no-trajectory', '--output', outputPath],
        {},
      );
      const out = readOutput();
      expect(out.length).toBe(1);
      // hypothesis is the retrieved-sessions text block, not an LLM answer.
      expect(typeof out[0].hypothesis).toBe('string');
    });
  });
});
