import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { configureGateway, resetGateway, isAvailable, chat } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { resolveRecipe, assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import {
  ACCESS_TOKEN_REDACTION,
  loadCodexOAuthCredentials,
  redactCodexSecret,
} from '../../src/core/ai/codex-oauth.ts';

let tempRoot = '';
const oldEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in oldEnv)) oldEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  resetGateway();
  tempRoot = mkdtempSync(join(tmpdir(), 'gbrain-codex-oauth-'));
  setEnv('GBRAIN_CODEX_AUTH_JSON', undefined);
  setEnv('HOME', tempRoot);
});

afterEach(() => {
  resetGateway();
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(oldEnv)) delete oldEnv[key];
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe('openai-codex recipe', () => {
  test('registers as chat-only OAuth provider', () => {
    const recipe = getRecipe('openai-codex');
    expect(recipe).toBeDefined();
    expect(recipe!.implementation).toBe('codex-oauth');
    expect(recipe!.touchpoints.chat).toBeDefined();
    expect(recipe!.touchpoints.embedding).toBeUndefined();
    expect(recipe!.touchpoints.expansion).toBeUndefined();
    expect(recipe!.auth_env?.required ?? []).toEqual([]);
  });

  test('resolver accepts codex chat model aliases', () => {
    const { parsed } = resolveRecipe('openai-codex:gpt-5-codex');
    expect(parsed.providerId).toBe('openai-codex');
    expect(parsed.modelId).toBe('gpt-5.3-codex');
    expect(() => assertTouchpoint(getRecipe('openai-codex')!, 'chat', parsed.modelId)).not.toThrow();
  });

  test('isAvailable only requires provider support, not exported API-key env vars', () => {
    configureGateway({ chat_model: 'openai-codex:gpt-5.3-codex', env: {} });
    expect(isAvailable('chat')).toBe(true);
    expect(isAvailable('embedding')).toBe(false);
  });
});

describe('Codex OAuth auth loading', () => {
  test('redacts access and refresh tokens in strings', () => {
    const raw = 'access_token=eyJsecret refresh_token=rfr-secret and ordinary text';
    const redacted = redactCodexSecret(raw);
    expect(redacted).toContain(ACCESS_TOKEN_REDACTION);
    expect(redacted).not.toContain('eyJsecret');
    expect(redacted).not.toContain('rfr-secret');
  });

  test('loads explicit auth JSON path without exposing token values', () => {
    const path = join(tempRoot, 'auth.json');
    writeFileSync(path, JSON.stringify({
      tokens: {
        access_token: 'fake-access-token',
        refresh_token: 'fake-refresh-token',
      },
      last_refresh: '2026-05-06T00:00:00Z',
    }), { mode: 0o600 });
    setEnv('GBRAIN_CODEX_AUTH_JSON', path);

    const creds = loadCodexOAuthCredentials({ refreshIfExpiring: false });
    expect(creds.provider).toBe('openai-codex');
    expect(creds.source).toBe(path);
    expect(creds.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    expect(creds.accessToken).toBe('fake-access-token');
    expect(creds.refreshToken).toBe('fake-refresh-token');

    const serialized = JSON.stringify({ ...creds, accessToken: ACCESS_TOKEN_REDACTION, refreshToken: ACCESS_TOKEN_REDACTION });
    expect(serialized).not.toContain('fake-access-token');
    expect(serialized).not.toContain('fake-refresh-token');
  });

  test('loads Hermes auth store shape before Codex CLI fallback', () => {
    const hermesDir = join(tempRoot, '.hermes');
    const codexDir = join(tempRoot, '.codex');
    mkdirSync(hermesDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(hermesDir, 'auth.json'), JSON.stringify({
      providers: {
        'openai-codex': {
          tokens: {
            access_token: 'hermes-access',
            refresh_token: 'hermes-refresh',
          },
          base_url: 'https://chatgpt.com/backend-api/codex',
        },
      },
    }), { mode: 0o600 });
    writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'codex-access',
        refresh_token: 'codex-refresh',
      },
    }), { mode: 0o600 });

    const creds = loadCodexOAuthCredentials({ refreshIfExpiring: false });
    expect(creds.accessToken).toBe('hermes-access');
    expect(creds.refreshToken).toBe('hermes-refresh');
    expect(readFileSync(join(codexDir, 'auth.json'), 'utf-8')).toContain('codex-access');
  });
});


describe('Codex OAuth chat adapter', () => {
  test('chat posts to Codex Responses endpoint with bearer auth and redacts errors', async () => {
    const path = join(tempRoot, 'auth.json');
    writeFileSync(path, JSON.stringify({
      tokens: {
        access_token: 'fake-access-token',
        refresh_token: 'fake-refresh-token',
      },
    }), { mode: 0o600 });
    setEnv('GBRAIN_CODEX_AUTH_JSON', path);
    configureGateway({ chat_model: 'openai-codex:gpt-5.3-codex', env: {} });

    const originalFetch = globalThis.fetch;
    let captured: any = null;
    globalThis.fetch = (async (url: string, init: any) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        id: 'resp_fake',
        status: 'completed',
        output_text: 'hello from codex',
        usage: { input_tokens: 3, output_tokens: 4 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const result = await chat({
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'Say hi' }],
        maxTokens: 32,
      });
      expect(result.text).toBe('hello from codex');
      expect(result.providerId).toBe('openai-codex');
      expect(result.usage.input_tokens).toBe(3);
      expect(captured.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(captured.init.headers.Authorization).toBe('Bearer fake-access-token');
      expect(captured.body.model).toBe('gpt-5.3-codex');
      expect(captured.body.max_output_tokens).toBe(32);
      expect(captured.body.input).toEqual([
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Say hi' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
