import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  chat,
  configureGateway,
  isAvailable,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

let tempDir: string;
let originalFetch: typeof fetch;

function fakeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: expSeconds,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function writeHermesAuth(accessToken: string): string {
  const hermesHome = join(tempDir, '.hermes');
  writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
    providers: {
      'openai-codex': {
        tokens: { access_token: accessToken, refresh_token: 'refresh_1' },
      },
    },
  }, null, 2));
  return hermesHome;
}

function sseEvents(events: Record<string, unknown>[]): string {
  return events
    .map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

beforeEach(() => {
  resetGateway();
  originalFetch = globalThis.fetch;
  tempDir = mkdtempSync(join(tmpdir(), 'gbrain-gateway-codex-'));
  mkdirSync(join(tempDir, '.hermes'), { recursive: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGateway();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('openai-codex gateway route', () => {
  test('recipe is registered as a chat-capable provider', () => {
    const { recipe } = resolveRecipe('openai-codex:gpt-5.5');
    expect(recipe.id).toBe('openai-codex');
    expect(recipe.touchpoints.chat?.supports_subagent_loop).toBe(true);
  });

  test('chat returns text from the Codex Responses endpoint without OPENAI_API_KEY', async () => {
    const access = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const hermesHome = writeHermesAuth(access);
    let requestUrl = '';
    let authHeader = '';
    let accountHeader = '';
    let requestPayload: Record<string, unknown> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      const headers = new Headers(init?.headers);
      authHeader = headers.get('authorization') ?? '';
      accountHeader = headers.get('ChatGPT-Account-ID') ?? '';
      requestPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(sseEvents([
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello from codex' }],
          },
        },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [],
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: { HERMES_HOME: hermesHome },
    });

    expect(isAvailable('chat')).toBe(true);
    const result = await chat({
      messages: [{ role: 'user', content: 'say hello' }],
    });

    expect(requestUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(authHeader).toBe(`Bearer ${access}`);
    expect(accountHeader).toBe('acct_123');
    expect(requestPayload?.stream).toBe(true);
    expect(requestPayload?.instructions).toBe('You are a helpful assistant.');
    expect(result.text).toBe('hello from codex');
    expect(result.model).toBe('openai-codex:gpt-5.5');
    expect(result.usage.input_tokens).toBe(3);
  });

  test('normalizes Codex function_call output to gateway tool-call blocks', async () => {
    const access = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const hermesHome = writeHermesAuth(access);

    globalThis.fetch = (async () => new Response(sseEvents([
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          status: 'completed',
          call_id: 'call_1',
          name: 'echo',
          arguments: '{"value":"v1"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [],
        },
      },
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;

    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: { HERMES_HOME: hermesHome },
    });

    const result = await chat({
      messages: [{ role: 'user', content: 'use tool' }],
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    });

    expect(result.stopReason).toBe('tool_calls');
    expect(result.blocks).toEqual([
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'echo', input: { value: 'v1' } },
    ]);
  });

  test('still accepts non-stream JSON responses from compatible test doubles', async () => {
    const access = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const hermesHome = writeHermesAuth(access);

    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello from json' }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: { HERMES_HOME: hermesHome },
    });

    const result = await chat({
      messages: [{ role: 'user', content: 'say hello' }],
    });

    expect(result.text).toBe('hello from json');
    expect(result.usage.input_tokens).toBe(3);
  });

  test('normalizes Codex function_call output from JSON to gateway tool-call blocks', async () => {
    const access = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const hermesHome = writeHermesAuth(access);

    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'echo',
          arguments: '{"value":"v1"}',
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: { HERMES_HOME: hermesHome },
    });

    const result = await chat({
      messages: [{ role: 'user', content: 'use tool' }],
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    });

    expect(result.stopReason).toBe('tool_calls');
    expect(result.blocks).toEqual([
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'echo', input: { value: 'v1' } },
    ]);
  });

  test('missing Codex auth fails as config error', async () => {
    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: {
        HERMES_HOME: join(tempDir, 'missing-hermes'),
        CODEX_HOME: join(tempDir, 'missing-codex'),
      },
    });

    expect(isAvailable('chat')).toBe(false);
    await expect(chat({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects
      .toThrow(AIConfigError);
  });
});
