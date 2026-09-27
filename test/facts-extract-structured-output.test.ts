/**
 * #4863 — facts extraction asks openai-compatible backends that honor
 * json_schema (Ollama) for schema-constrained output.
 *
 * Small local models emit malformed JSON a fraction of the time on a
 * prompt-only extraction. Ollama enforces `response_format: json_schema`
 * server-side (grammar-constrained decoding, model-independent), so the
 * extractor threads its schema through `ChatOpts.responseSchema` and chat()
 * attaches it as the AI SDK `output` for recipes that declare
 * `supports_structured_outputs` under the openai-compatible implementation.
 *
 * Pinned through the generateText transport seam — the chat transport
 * short-circuits before the SDK call, so it cannot observe `output`:
 *   - ollama: `output` is attached, its responseFormat is the facts schema,
 *     and the reply text still flows through the extractor's own parser.
 *   - the Output spec is TOLERANT: parseCompleteOutput hands the raw text
 *     back instead of throwing NoObjectGeneratedError (generateText parses
 *     eagerly on finishReason 'stop'), so a malformed reply stays a
 *     recoverable malformed_output for the extractor's retry lane.
 *   - the #2113 truncation retry re-sends at 2x with `output` still attached.
 *   - native anthropic and an openai-compatible recipe WITHOUT the flag get
 *     no `output` at all (lanes byte-identical to before).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';

const OLLAMA = 'ollama:gemma3:4b';
const GOOD_JSON = '{"facts":[{"fact":"user gave up alcohol","kind":"commitment",' +
  '"entity":null,"confidence":1.0,"notability":"high",' +
  '"metric":null,"value":null,"unit":null,"period":null}]}';

function sdkResult(text: string, finishReason: 'stop' | 'length' = 'stop'): any {
  return { content: [{ type: 'text', text }], finishReason, usage: { inputTokens: 5, outputTokens: 5 } };
}

function extract(model: string) {
  return extractFactsFromTurnWithOutcome({ turnText: 'I gave up alcohol.', source: 'test:structured', model });
}

beforeEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
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

describe('facts extraction — structured output on ollama (#4863)', () => {
  test('chat() attaches the facts schema as the SDK `output`; facts still parse from the reply text', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => { calls.push(args); return sdkResult(GOOD_JSON); });

    const outcome = await extract(OLLAMA);

    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeDefined();
    const rf = await calls[0].output.responseFormat;
    expect(rf.type).toBe('json');
    expect(rf.name).toBe('facts_extraction');
    expect(rf.schema.required).toEqual(['facts']);
    expect(rf.schema.additionalProperties).toBe(false);
    const item = rf.schema.properties.facts.items;
    // Strict-safe: every listed property is required (nullable via type unions), so an
    // openai-compatible proxy that honors `strict: true` (the SDK default) accepts it too.
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(rf.schema.required).toEqual(Object.keys(rf.schema.properties));
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.kind.enum).toContain('commitment');
    expect(item.properties.notability.enum).toEqual(['high', 'medium', 'low']);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.facts).toHaveLength(1);
      expect(outcome.facts[0]!.kind).toBe('commitment');
    }
  });

  test('the Output spec is tolerant: malformed text is handed back, not thrown, so the extractor retry lane runs', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      return sdkResult(calls.length === 1 ? 'not json' : GOOD_JSON);
    });

    const outcome = await extract(OLLAMA);

    // Output.object would throw NoObjectGeneratedError inside generateText on
    // the first reply; the tolerant spec returns the text untouched.
    await expect(calls[0].output.parseCompleteOutput({ text: 'not json' }, {} as any)).resolves.toBe('not json');
    expect(calls).toHaveLength(2);
    expect(calls[1].output).toBeDefined();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.facts).toHaveLength(1);
  });

  test('#2113 truncation retry re-sends at double the cap with `output` still attached', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      return calls.length === 1
        ? sdkResult('{"facts":[{"fact":"user gave up alco', 'length')
        : sdkResult(GOOD_JSON);
    });

    const outcome = await extract(OLLAMA);

    expect(calls).toHaveLength(2);
    expect(calls[1].maxOutputTokens).toBe(calls[0].maxOutputTokens * 2);
    expect(calls[1].output).toBeDefined();
    expect(outcome.ok).toBe(true);
  });
});

describe('facts extraction — every other lane is unchanged', () => {
  test('native anthropic: no `output` on the SDK call', async () => {
    const model = 'anthropic:claude-sonnet-4-6';
    configureGateway({ chat_model: model, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => { calls.push(args); return sdkResult(GOOD_JSON); });

    const outcome = await extract(model);

    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });

  test('openai-compatible recipe that does NOT declare structured outputs: no `output` either', async () => {
    const model = 'deepseek:deepseek-chat';
    configureGateway({ chat_model: model, env: { DEEPSEEK_API_KEY: 'sk-fake' } });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => { calls.push(args); return sdkResult(GOOD_JSON); });

    const outcome = await extract(model);

    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });
});

// Pre-landing review (#4968 adoption): a recipe that DECLARES structured
// outputs but whose backend rejects `response_format: json_schema` at call
// time (an older Ollama build, a strict proxy) must not turn every facts
// extraction into a permanent provider_error. chat() retries ONCE without the
// schema and remembers the recipe for the process lifetime — the same
// `_structuredOutputRejectedRecipes` memory expand() already keeps.
describe('facts extraction — json_schema rejected at call time falls back schemaless', () => {
  function apiError(statusCode: number, message: string): Error {
    return Object.assign(new Error(message), {
      name: 'AI_APICallError',
      statusCode,
      responseBody: JSON.stringify({ error: { message, type: 'invalid_request_error' } }),
    });
  }

  let warns: string[] = [];
  const origWarn = console.warn;
  beforeEach(() => {
    warns = [];
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  });
  afterEach(() => { console.warn = origWarn; });

  test('a 400 naming json_schema → one schemaless retry succeeds; later extractions skip the schema with no failing call', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      if (args.output) throw apiError(400, 'response_format json_schema is not supported by this model');
      return sdkResult(GOOD_JSON);
    });

    const first = await extract(OLLAMA);

    expect(first.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].output).toBeDefined();
    expect(calls[1].output).toBeUndefined();
    expect(warns.filter(w => /json_schema/.test(w))).toHaveLength(1);

    const second = await extract(OLLAMA);

    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2].output).toBeUndefined();
    expect(warns.filter(w => /json_schema/.test(w))).toHaveLength(1); // remembered: no second rejection, no second warn
  });

  test('an unrelated 500 is NOT a schema rejection: no retry, provider_error, schema still sent next time', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    let failing = true;
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      if (failing) throw apiError(500, 'internal server error: upstream timeout');
      return sdkResult(GOOD_JSON);
    });

    const failed = await extract(OLLAMA);

    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toBe('provider_error');
    expect(calls).toHaveLength(1);

    failing = false;
    const recovered = await extract(OLLAMA);

    expect(recovered.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].output).toBeDefined();
    expect(warns.filter(w => /json_schema/.test(w))).toHaveLength(0);
  });

  test('a 400 that does not name the schema (context length) is NOT a schema rejection', async () => {
    configureGateway({ chat_model: OLLAMA, env: {} });
    const calls: any[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      calls.push(args);
      throw apiError(400, "this model's maximum context length is 8192 tokens");
    });

    const failed = await extract(OLLAMA);

    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toBe('provider_error');
    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeDefined();
  });
});
