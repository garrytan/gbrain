/**
 * #9466: a provider that answers a non-streaming chat request with a success status and a body that is not one JSON
 * document (a route that streams Server-Sent Events when `stream` is omitted) fails the same way on every call. It was
 * classed as transient, so the job that made the call retried it and its recorded error said only
 * `cause=AITransientError`. It is now a non-retryable configuration error with a registry code: the call is made once,
 * the job ends on its first attempt, and the recorded text says the response could not be parsed without carrying any of
 * the response body.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { AIConfigError, AITransientError, normalizeAIError } from '../../src/core/ai/errors.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { FactsExtractionError } from '../../src/core/facts/extract.ts';
import { classifyDeadFactsAbsorb } from '../../src/core/facts/dead-absorb-retry.ts';
import { jobRefusal } from '../../src/core/minions/refusal.ts';

const BODY_MARKER = 'streamed-body-text-9466';
let server: ReturnType<typeof Bun.serve>;
let requests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      requests++;
      const chunk = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: BODY_MARKER } }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
});

afterAll(() => {
  server.stop(true);
  resetGateway();
});

beforeEach(() => {
  requests = 0;
  resetGateway();
});

const model = () => `groq:${getRecipe('groq')!.touchpoints.chat!.models[0]}`;

async function streamedChat(): Promise<Error> {
  configureGateway({ chat_model: model(), env: { GROQ_API_KEY: 'stub' }, base_urls: { groq: `http://127.0.0.1:${server.port}/v1` } });
  return chat({ model: model(), system: 'Reply.', messages: [{ role: 'user', content: 'hello' }], maxTokens: 50 }).then(
    () => { throw new Error('chat resolved on an unparseable body'); }, (error: Error) => error);
}

describe('#9466 a success response whose body is not JSON', () => {
  test('is one request, classed as a non-retryable configuration error that names the parse failure and no body text', async () => {
    const error = await streamedChat();
    expect(requests).toBe(1);
    expect(error).toBeInstanceOf(AIConfigError);
    expect(error).toMatchObject({ code: 'provider_response_unparseable', retryable: false });
    expect(error.message).toContain('could not be parsed');
    expect(error.message).not.toContain(BODY_MARKER);
    expect((error as AIConfigError).fix).toContain('provider_chat_options');
  });

  test('a facts job that hits it is refused on its first attempt, and its recorded error says why without the body', async () => {
    const extraction = new FactsExtractionError('provider_error', model(), await streamedChat());
    expect(extraction.message).toContain('(cause=AIConfigError provider_response_unparseable)');
    expect(extraction.message).not.toContain(BODY_MARKER);
    const refusal = jobRefusal(extraction);
    expect(refusal).toMatchObject({ code: 'provider_response_unparseable' });
    expect(refusal!.message).not.toContain(BODY_MARKER);
    expect(classifyDeadFactsAbsorb(extraction.message)).toBe('not_retryable');
  });

  test('a bare SDK parse error is classed the same way, and its text is not carried', () => {
    const parse = Object.assign(new Error(`JSON parsing failed: Text: data: {"content":"${BODY_MARKER}"}.`), { name: 'AI_JSONParseError', text: `data: ${BODY_MARKER}` });
    const error = normalizeAIError(parse, 'chat(groq:x)');
    expect(error).toBeInstanceOf(AIConfigError);
    expect(error).toMatchObject({ code: 'provider_response_unparseable', retryable: false });
    expect(error.message).not.toContain(BODY_MARKER);
  });

  test('a parsed body that fails the schema, and a 5xx whose error body did not parse, stay transient', () => {
    const schema = Object.assign(new Error('Invalid JSON response'), { name: 'AI_APICallError', statusCode: 200,
      cause: Object.assign(new Error('Type validation failed'), { name: 'AI_TypeValidationError' }) });
    const upstream = Object.assign(new Error('Failed to process error response'), { name: 'AI_APICallError', statusCode: 502,
      cause: Object.assign(new Error('JSON parsing failed'), { name: 'AI_JSONParseError' }) });
    for (const err of [schema, upstream]) expect(normalizeAIError(err, 'chat(groq:x)')).toBeInstanceOf(AITransientError);
  });
});
