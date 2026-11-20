/**
 * #9696: Ollama 0.35 answers HTTP 400 while the llama-server runner behind a model restarts, with a body that reports
 * the refused connection to that runner. The request is valid and succeeds once the runner is back, so it is a
 * transient outage, not a configuration error that fails an embedding effect for good. Reported by @benswinney.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeAIError } from '../src/core/ai/errors.ts';

const apiError = (statusCode: number, message: string, responseBody: string) =>
  Object.assign(new Error(message), { name: 'AI_APICallError', statusCode, responseBody });
const runnerUrl = 'http://127.0.0.1:41234';

describe('normalizeAIError: a refused connection to the local model runner (#9696)', () => {
  test('each 400 body Ollama sends during a runner restart is transient', () => {
    const detokenize = `Post "${runnerUrl}/detokenize": dial tcp 127.0.0.1:41234: connect: connection refused`;
    const bodies = [
      [detokenize, JSON.stringify({ error: { message: detokenize, type: 'invalid_request_error', param: null, code: null } })],
      ['Bad Request', JSON.stringify({ error: `do embedding request: Post "${runnerUrl}/v1/embeddings": dial tcp 127.0.0.1:41234: connect: connection refused` })],
      ['Bad Request', '{"error":"connection refused"}'],
    ];
    for (const [message, body] of bodies) expect(normalizeAIError(apiError(400, message!, body!), 'embed(ollama:embeddinggemma:300m)').name).toBe('AITransientError');
  });

  test('an ordinary 400 stays a configuration error', () => {
    expect(normalizeAIError(apiError(400, 'invalid model', '{"error":"model \\"missing\\" not found"}')).name).toBe('AIConfigError');
    expect(normalizeAIError(apiError(400, 'Bad Request', '{"error":"the connection refused to accept this input"}')).name).toBe('AIConfigError');
  });
});
