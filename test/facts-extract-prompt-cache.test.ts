/**
 * Facts extraction reads its system prompt from the Anthropic prompt cache.
 *
 * Every extractor call sends the same system prompt (about 2,200 tokens with
 * the default date-grounding and attribution blocks); the turn, observation
 * date and entity hints ride in the user message. The first call and the
 * #2113 truncation retry opt in with `cacheSystem: true`, so chat() puts an
 * explicit breakpoint on the system block and the next call reads it. The
 * malformed-output retry appends a note to the system prompt, so it does not
 * opt in: a write there would never be read.
 *
 * Pinned through the generateText transport seam, so the assertions see the
 * `system` param the Anthropic provider receives: a SystemModelMessage carrying
 * `providerOptions.anthropic.cacheControl` when caching, a bare string when not.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { buildExtractorSystem, extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';

const MODEL = 'anthropic:claude-sonnet-5-5';
const GOOD_JSON = '{"facts":[{"fact":"user gave up alcohol","kind":"commitment",' +
  '"entity":null,"confidence":1.0,"notability":"high",' +
  '"metric":null,"value":null,"unit":null,"period":null}]}';
const VARIANT = { dateGrounding: true, attribution: true };

function sdkResult(text: string, finishReason: 'stop' | 'length' = 'stop'): any {
  return { content: [{ type: 'text', text }], finishReason, usage: { inputTokens: 5, outputTokens: 5 } };
}

function extract(turnText: string, date: string, entityHints?: string[]) {
  return extractFactsFromTurnWithOutcome({
    turnText,
    source: 'test:prompt-cache',
    model: MODEL,
    variant: VARIANT,
    observationDate: { date, source: 'caller' },
    entityHints,
  });
}

/** The system param chat() handed the SDK, with its cache marker if any. */
function systemOf(call: any): { text: string; cacheControl: unknown } {
  if (typeof call.system === 'string') return { text: call.system, cacheControl: undefined };
  return { text: call.system.content, cacheControl: call.system.providerOptions?.anthropic?.cacheControl };
}

beforeEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
  configureGateway({ chat_model: MODEL, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

// Shard hygiene (same rationale as facts-extract-truncation.test.ts): restore
// the legacy 1536-d embedding pin so later fresh-schema files in this shard
// don't inherit a dimensionless gateway.
afterAll(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

describe('facts extraction — system prompt prompt-cache breakpoint', () => {
  test('consecutive calls send one identical, cache-marked system block; per-call data stays in the user message', async () => {
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => { calls.push(args); return sdkResult(GOOD_JSON); });

    const a = await extract('alice-example (2026-09-01 09:00): I gave up alcohol in March.', '2026-09-01', ['people/alice-example']);
    const b = await extract('charlie-example (2026-09-02 10:30): We closed the seed round at $2M.', '2026-09-02', ['companies/acme-example']);

    expect(a.ok && b.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const [s1, s2] = calls.map(systemOf);
    expect(s1!.cacheControl).toEqual({ type: 'ephemeral' });
    expect(s2!.cacheControl).toEqual({ type: 'ephemeral' });
    expect(s1!.text).toBe(buildExtractorSystem(true, VARIANT));
    expect(s2!.text).toBe(s1!.text);
    // The varying parts land after the breakpoint, in the user message.
    const user = (call: any) => JSON.stringify(call.messages);
    expect(s1!.text).not.toContain('2026-09-01');
    expect(user(calls[0])).toContain('2026-09-01');
    expect(user(calls[0])).toContain('people/alice-example');
    expect(user(calls[1])).toContain('companies/acme-example');
  });

  test('the #2113 truncation retry keeps the breakpoint', async () => {
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      return calls.length === 1 ? sdkResult('{"facts":[{"fact":"user gave up alco', 'length') : sdkResult(GOOD_JSON);
    });

    const outcome = await extract('alice-example (2026-09-01 09:00): I gave up alcohol in March.', '2026-09-01');

    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(systemOf(calls[1]).cacheControl).toEqual({ type: 'ephemeral' });
    expect(systemOf(calls[1]).text).toBe(systemOf(calls[0]).text);
  });

  test('the malformed-output retry, whose system prompt differs, sends no breakpoint', async () => {
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      return sdkResult(calls.length === 1 ? 'not json' : GOOD_JSON);
    });

    const outcome = await extract('alice-example (2026-09-01 09:00): I gave up alcohol in March.', '2026-09-01');

    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(systemOf(calls[0]).cacheControl).toEqual({ type: 'ephemeral' });
    expect(typeof calls[1].system).toBe('string');
    expect(calls[1].system).toContain('The previous attempt returned invalid JSON');
  });
});
