// #6290: DB-plane provider_chat_options rows reach the gateway. One JSON
// object per selector (model ids carry dots, so a dotted leaf is ambiguous);
// the file plane wins per leaf; prototype keys are dropped; `config set`
// refuses a dotted leaf with the exact JSON-form command.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';
import { _resetDbPlaneMergeMemoForTests, assertProviderChatOptionsSetValue } from '../src/core/config-db-merge.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { __setGenerateTextTransportForTests, chat, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function fakeEngine(map: Record<string, string>) {
  return {
    async getConfig(key: string) { return map[key]; },
    async listConfigKeys(prefix: string) { return Object.keys(map).filter(k => k.startsWith(prefix)); },
  };
}

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  _resetDbPlaneMergeMemoForTests();
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'provider_chat_options.%'");
});
afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

describe('DB-plane provider_chat_options merge', () => {
  test('a JSON object row per selector reaches the gateway request (batched read, real PGLite)', async () => {
    await engine.setConfig('provider_chat_options.anthropic:claude-sonnet-4-6', '{"thinking":{"type":"disabled"}}');
    const merged = await loadConfigWithEngine(engine, { engine: 'pglite', chat_model: 'anthropic:claude-sonnet-4-6', anthropic_api_key: 'fake' } as GBrainConfig);
    expect(merged?.provider_chat_options?.['anthropic:claude-sonnet-4-6']).toEqual({ thinking: { type: 'disabled' } });
    let captured: Record<string, unknown> | undefined;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args.providerOptions;
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    configureGateway({ ...buildGatewayConfig(merged!), env: { ANTHROPIC_API_KEY: 'fake' } });
    await chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] });
    expect((captured?.anthropic as Record<string, unknown>)?.thinking).toEqual({ type: 'disabled' });
  });

  test('the file plane wins per leaf; the DB fills siblings', async () => {
    const base = { engine: 'pglite', provider_chat_options: { anthropic: { thinking: { type: 'enabled', budget_tokens: 1024 } } } } as GBrainConfig;
    const merged = await loadConfigWithEngine(fakeEngine({
      'provider_chat_options.anthropic': '{"thinking":{"type":"disabled"},"temperature":0.2}',
    }), base);
    expect(merged?.provider_chat_options?.anthropic).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 }, temperature: 0.2 });
  });

  test('prototype keys are dropped at every depth', async () => {
    const merged = await loadConfigWithEngine(fakeEngine({
      'provider_chat_options.anthropic': '{"__proto__":{"polluted":true},"thinking":{"constructor":{"x":1},"type":"disabled"}}',
      'provider_chat_options.__proto__': '{"polluted":true}',
    }), { engine: 'pglite' } as GBrainConfig);
    expect(merged?.provider_chat_options?.anthropic).toEqual({ thinking: { type: 'disabled' } });
    expect(Object.keys(merged?.provider_chat_options ?? {})).toEqual(['anthropic']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('a legacy dotted row is read only when its selector has no dot', async () => {
    const merged = await loadConfigWithEngine(fakeEngine({
      'provider_chat_options.deepseek:deepseek-v4.thinking.type': 'disabled',
      'provider_chat_options.openai:gpt-5.4.reasoningEffort': 'low',
    }), { engine: 'pglite' } as GBrainConfig);
    expect(merged?.provider_chat_options?.['deepseek:deepseek-v4']).toEqual({ thinking: { type: 'disabled' } });
    expect(merged?.provider_chat_options?.['openai:gpt-5.4']).toBeUndefined();
    expect(merged?.provider_chat_options?.['openai:gpt-5']).toBeUndefined();
  });
});

describe('config set provider_chat_options validation', () => {
  test('a JSON object per selector is accepted, dotted model ids included', () => {
    expect(() => assertProviderChatOptionsSetValue('provider_chat_options.openai:gpt-5.4', '{"reasoningEffort":"low"}')).not.toThrow();
    expect(() => assertProviderChatOptionsSetValue('provider_chat_options.anthropic', '{"thinking":{"type":"disabled"}}')).not.toThrow();
  });

  test('a dotted leaf is refused with the exact JSON-form command', () => {
    expect(() => assertProviderChatOptionsSetValue('provider_chat_options.deepseek:deepseek-v4.thinking.type', 'disabled'))
      .toThrow(`gbrain config set provider_chat_options.deepseek:deepseek-v4 '{"thinking":{"type":"disabled"}}'`);
  });

  test('a non-object value is refused', () => {
    expect(() => assertProviderChatOptionsSetValue('provider_chat_options.anthropic', 'disabled')).toThrow('takes one JSON object per selector');
    expect(() => assertProviderChatOptionsSetValue('provider_chat_options.anthropic', '[1]')).toThrow('nothing was written');
  });
});
