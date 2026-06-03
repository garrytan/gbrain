import { describe, expect, test } from 'bun:test';

import {
  buildCodexResponsesBody,
  buildCodexResponsesHeaders,
  parseCodexResponsesStream,
  runCodexResponsesChat,
  type CodexCredential,
} from '../../src/core/ai/codex-responses.ts';
import type { ChatOpts } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';

const FIXTURE_DIR = new URL('../fixtures/ai/openai-codex/', import.meta.url);
const TOKEN = 'codex-stream-test-token';

function credential(token = TOKEN): CodexCredential {
  return {
    ok: true,
    source: 'env',
    accessToken: token,
    tokenType: 'bearer',
    expiresAtMs: Date.UTC(2030, 0, 1, 0, 0, 0),
    expiresAt: '2030-01-01T00:00:00.000Z',
    accountId: 'acct_fixture',
  };
}

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(name, FIXTURE_DIR)).text();
}

async function sseResponse(name: string, status = 200): Promise<Response> {
  return new Response(await fixture(name), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const baseOpts: ChatOpts = {
  model: 'openai-codex:gpt-5.5',
  system: 'You are terse.',
  messages: [
    { role: 'system', content: 'Prefer one-word answers.' },
    { role: 'user', content: 'Say OK' },
    { role: 'assistant', content: [{ type: 'text', text: 'Prior answer.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Again.' }] },
  ],
  maxTokens: 8,
};

describe('Codex Responses request builder', () => {
  test('builds a streaming, non-stored Responses request with Codex-compatible headers', () => {
    const body = buildCodexResponsesBody(baseOpts, 'gpt-5.5');
    expect(body.model).toBe('gpt-5.5');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(8);
    expect(body.instructions).toContain('You are terse.');
    expect(body.instructions).toContain('Prefer one-word answers.');
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Say OK' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Prior answer.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Again.' }] },
    ]);

    const headers = buildCodexResponsesHeaders(credential());
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toContain('codex_cli_rs');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['ChatGPT-Account-ID']).toBe('acct_fixture');
  });

  test('runCodexResponsesChat posts to {baseURL}/responses and passes the abort signal', async () => {
    const recipe = getRecipe('openai-codex')!;
    const controller = new AbortController();
    let seenUrl = '';
    let seenBody: any = null;
    let seenSignal: AbortSignal | null | undefined;
    let seenHeaders: Headers | null = null;

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      seenSignal = init?.signal;
      seenHeaders = new Headers(init?.headers);
      return sseResponse('stream-basic.sse');
    }) as typeof fetch;

    const result = await runCodexResponsesChat({
      recipe,
      modelId: 'gpt-5.5',
      opts: { ...baseOpts, abortSignal: controller.signal },
      credential: credential(),
      baseURL: 'https://chatgpt.com/backend-api/codex/',
      fetchImpl,
    });

    expect(result.text).toBe('OK');
    expect(result.stopReason).toBe('end');
    expect(result.model).toBe('openai-codex:gpt-5.5');
    expect(result.providerId).toBe('openai-codex');
    expect(seenUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(seenBody.stream).toBe(true);
    expect(seenBody.store).toBe(false);
    expect(seenBody.model).toBe('gpt-5.5');
    expect(seenSignal).toBe(controller.signal);
    expect(seenHeaders!.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(seenHeaders!.get('chatgpt-account-id')).toBe('acct_fixture');
    expect(seenHeaders!.get('originator')).toBe('codex_cli_rs');
  });
});

describe('Codex Responses SSE parsing', () => {
  test('collects response.output_text.delta events into ChatResult text', async () => {
    const result = await parseCodexResponsesStream(await sseResponse('stream-basic.sse'), {
      providerId: 'openai-codex',
      modelId: 'gpt-5.5',
    });

    expect(result.text).toBe('OK');
    expect(result.blocks).toEqual([{ type: 'text', text: 'OK' }]);
    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
    expect(result.providerMetadata?.codex?.response_id).toBe('resp_basic');
  });

  test('parses usage from completed stream events when present', async () => {
    const result = await parseCodexResponsesStream(await sseResponse('stream-usage.sse'), {
      providerId: 'openai-codex',
      modelId: 'gpt-5.5',
    });

    expect(result.text).toBe('OK');
    expect(result.usage).toEqual({
      input_tokens: 3,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_creation_tokens: 0,
    });
  });

  test('throws when stream ends before response.completed', async () => {
    const truncated = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    ].join('');

    let caught: unknown = null;
    try {
      await parseCodexResponsesStream(new Response(truncated, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }), {
        providerId: 'openai-codex',
        modelId: 'gpt-5.5',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AITransientError);
    expect((caught as Error).message).toContain('ended before response.completed');
    expect((caught as Error).message).toContain('text_chars=7');
  });

  test('throws when a 200 response has no SSE events', async () => {
    let caught: unknown = null;
    try {
      await parseCodexResponsesStream(new Response('', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }), {
        providerId: 'openai-codex',
        modelId: 'gpt-5.5',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AITransientError);
    expect((caught as Error).message).toContain('events=0');
  });

  test('redacts bearer material from stream errors', async () => {
    let caught: unknown = null;
    try {
      await parseCodexResponsesStream(await sseResponse('stream-error.sse'), {
        providerId: 'openai-codex',
        modelId: 'gpt-5.5',
        redactionSecrets: ['secret-token-must-redact'],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AITransientError);
    expect((caught as Error).message).toContain('[REDACTED]');
    expect((caught as Error).message).not.toContain('secret-token-must-redact');
  });

  test('redacts Codex access token and account id from fetch failures', async () => {
    const recipe = getRecipe('openai-codex')!;
    const fetchImpl = (async () => {
      throw new Error(`network failed for ${TOKEN} and acct_fixture`);
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await runCodexResponsesChat({
        recipe,
        modelId: 'gpt-5.5',
        opts: baseOpts,
        credential: credential(),
        baseURL: 'https://chatgpt.com/backend-api/codex',
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AITransientError);
    expect((caught as Error).message).toContain('[REDACTED]');
    expect((caught as Error).message).not.toContain(TOKEN);
    expect((caught as Error).message).not.toContain('acct_fixture');
  });

  test('redacts Codex access token from HTTP error bodies', async () => {
    const recipe = getRecipe('openai-codex')!;
    const fetchImpl = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ error: { message: `bad auth Bearer ${TOKEN}` } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await runCodexResponsesChat({
        recipe,
        modelId: 'gpt-5.5',
        opts: baseOpts,
        credential: credential(),
        baseURL: 'https://chatgpt.com/backend-api/codex',
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AIConfigError);
    expect((caught as Error).message).toContain('[REDACTED]');
    expect((caught as Error).message).not.toContain(TOKEN);
  });
});
