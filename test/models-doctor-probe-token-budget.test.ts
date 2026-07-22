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
import {
  __setChatTransportForTests,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { probeModel, PROBE_MAX_OUTPUT_TOKENS } from '../src/commands/models.ts';

afterEach(() => {
  __setChatTransportForTests(null);
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
    // The bug class: a 1-token budget cannot accommodate reasoning burn.
    expect(PROBE_MAX_OUTPUT_TOKENS).toBeGreaterThan(1);
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
});
