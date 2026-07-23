/**
 * #3221 — one-token doctor probes falsely fail reasoning models.
 *
 * The `gbrain models doctor` chat/expansion reachability probe used
 * `maxTokens: 1`. Reasoning models spend output budget on internal reasoning
 * before emitting any text, so a 1-token cap is either exhausted with zero
 * usable text (finishReason 'length') or rejected outright by providers that
 * require the cap to exceed the model's minimum reasoning spend — and the
 * probe then reported a failure for a perfectly reachable model.
 *
 * Pins (behavioral, via the gateway's `__setChatTransportForTests` seam —
 * no network, no gateway config needed since the transport branch returns
 * before provider resolution):
 *
 *   1. The probe grants a sufficient diagnostic output budget (the shared
 *      PROBE_MAX_OUTPUT_TOKENS constant, strictly greater than 1).
 *   2. A length-exhausted response with NO text still counts as reachable
 *      (status 'ok'), with the generation limitation surfaced in the message
 *      rather than a bare 'reachable'.
 *   3. A normal completion keeps the plain 'reachable' message (no noise for
 *      the common case).
 *   4. Provider errors are still classified as failures (the wider budget
 *      must not swallow real auth/config problems).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  __setChatTransportForTests,
  __setGenerateTextTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { probeModel, PROBE_MAX_OUTPUT_TOKENS } from '../src/commands/models.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

function stubResult(over: Partial<ChatResult> = {}): ChatResult {
  return {
    text: 'ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
    ...over,
  };
}

describe('models doctor — probe token budget (#3221)', () => {
  test('probe requests a sufficient output budget, not 1 token', async () => {
    let seenMaxTokens: number | undefined;
    __setChatTransportForTests(async (opts: ChatOpts) => {
      seenMaxTokens = opts.maxTokens;
      return stubResult();
    });

    const r = await probeModel('test:reasoner', 'chat');

    expect(r.status).toBe('ok');
    expect(seenMaxTokens).toBe(PROBE_MAX_OUTPUT_TOKENS);
    // The bug class: a tiny budget cannot accommodate reasoning burn. Pin a
    // real floor (not just > 1) so the constant can't quietly regress to a
    // value that re-triggers the false-FAIL.
    expect(PROBE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(64);
  });

  test('length-exhausted empty completion is reachable, with the limitation surfaced', async () => {
    // A direct reasoning model spends the whole probe budget on internal
    // reasoning: valid HTTP response, finishReason 'length', empty text.
    __setChatTransportForTests(async () =>
      stubResult({ text: '', blocks: [], stopReason: 'length' }),
    );

    const r = await probeModel('test:reasoner', 'chat');

    expect(r.status).toBe('ok');
    expect(r.message).toContain('reachable');
    // The generation limitation is reported, not silently folded into a
    // bare 'reachable' (the issue's "clearly reporting the generation
    // limitation" requirement).
    expect(r.message).not.toBe('reachable');
    expect(r.message).toContain('reasoning');
  });

  test('length-exhausted completion WITH text keeps the plain reachable message', async () => {
    // Non-reasoning model that simply hit the cap mid-sentence: it emitted
    // text, so generation itself was exercised — no caveat needed.
    __setChatTransportForTests(async () =>
      stubResult({ text: 'partial answ', stopReason: 'length' }),
    );

    const r = await probeModel('test:small-model', 'chat');

    expect(r.status).toBe('ok');
    expect(r.message).toBe('reachable');
  });

  test('normal completion reports plain reachable', async () => {
    __setChatTransportForTests(async () => stubResult());

    const r = await probeModel('test:small-model', 'expansion');

    expect(r.status).toBe('ok');
    expect(r.message).toBe('reachable');
    expect(r.touchpoint).toBe('expansion');
  });

  test('provider errors are still classified as failures', async () => {
    __setChatTransportForTests(async () => {
      throw Object.assign(new Error('401 unauthorized: bad api key'), { status: 401 });
    });

    const r = await probeModel('test:reasoner', 'chat');

    expect(r.status).toBe('auth');
  });

  test('probe cap widens above a configured extended-thinking budget', async () => {
    // Anthropic rejects requests where max_tokens <= thinking.budgetTokens.
    // A user who configured `provider_chat_options.anthropic.thinking`
    // (e.g. budgetTokens: 1024) would have the fixed 64-token probe cap
    // rejected outright — the same false-FAIL class. Exercised through the
    // generate-text seam so provider-option resolution stays live.
    let capturedMaxOutputTokens: number | undefined;
    __setGenerateTextTransportForTests(async (args: any) => {
      capturedMaxOutputTokens = args.maxOutputTokens;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      chat_model: 'anthropic:claude-sonnet-4-6',
      provider_chat_options: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } },
      },
      env: { ANTHROPIC_API_KEY: 'sk-fake', OPENAI_API_KEY: 'sk-fake' },
    });

    const r = await probeModel('anthropic:claude-sonnet-4-6', 'chat');

    expect(r.status).toBe('ok');
    expect(capturedMaxOutputTokens).toBe(1024 + PROBE_MAX_OUTPUT_TOKENS);
  });

  test('human output renders ok-probe caveat messages, not only failure messages', () => {
    // runModels needs a live engine, so pin the render branch structurally
    // (same source-text convention as test/models-doctor-embed.test.ts): the
    // non-json output path must print the message for an ok probe whose
    // message deviates from the bare 'reachable' (the reasoning-burn caveat
    // would otherwise be visible only under --json).
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'models.ts'), 'utf-8');
    const runIdx = src.indexOf('export async function runModels');
    expect(runIdx).toBeGreaterThan(0);
    expect(src.slice(runIdx)).toMatch(/else if \(r\.message !== 'reachable'\)\s*\{[^}]*process\.stdout\.write\(`\s+\$\{r\.message\}\\n`\)/);
  });
});
