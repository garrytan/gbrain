import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { chat, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runConfig } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function reader(values: Record<string, string>, mode: 'snapshot' | 'keys' | 'sql') {
  return {
    getConfig: async (key: string) => values[key] ?? null,
    ...(mode === 'snapshot' ? { getAllConfig: async () => values } : {}),
    ...(mode === 'keys' ? { listConfigKeys: async (prefix: string) => Object.keys(values).filter(k => k.startsWith(prefix)) } : {}),
    ...(mode === 'sql' ? { executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => Object.entries(values)
      .filter(([key]) => (params?.[0] as string[] | undefined)?.includes(key) || key.startsWith('cycle.') || (sql.includes('provider_chat_options') && key.startsWith('provider_chat_options.')))
      .map(([key, value]) => ({ key, value }) as T) } : {}),
  };
}

afterEach(() => resetGateway());

for (const mode of ['snapshot', 'keys', 'sql'] as const) {
  describe(`DB provider chat options (${mode})`, () => {
    test('typed leaves and model overrides survive loading without mutating the file plane', async () => {
      const base: GBrainConfig = { engine: 'pglite', provider_chat_options: {
        deepseek: { thinking: { type: 'enabled' }, temperature: 0, flags: [false] },
      } };
      const original = JSON.stringify(base);
      const config = await loadConfigWithEngine(reader({
        'provider_chat_options.deepseek.thinking.type': 'disabled',
        'provider_chat_options.deepseek.thinking.budget': '1024',
        'provider_chat_options.deepseek.temperature': '0.8',
        'provider_chat_options.deepseek.flags': '[true]',
        'provider_chat_options.deepseek.enabled': 'false',
        'provider_chat_options.deepseek:deepseek-v4-flash.thinking.type': 'disabled',
      }, mode), base);
      expect(config?.provider_chat_options).toEqual({
        deepseek: { thinking: { type: 'enabled', budget: 1024 }, temperature: 0, flags: [false], enabled: false },
        'deepseek:deepseek-v4-flash': { thinking: { type: 'disabled' } },
      });
      expect(JSON.stringify(base)).toBe(original);
    });

    test('root JSON preserves dotted model IDs; specific leaves override root DB defaults', async () => {
      const config = await loadConfigWithEngine(reader({
        provider_chat_options: JSON.stringify({ 'openai:gpt-5.4': { reasoningEffort: 'none' }, deepseek: { thinking: { type: 'enabled', budget: 20 } } }),
        'provider_chat_options.deepseek.thinking.type': 'disabled',
      }, mode), { engine: 'pglite' });
      expect(config?.provider_chat_options).toEqual({
        'openai:gpt-5.4': { reasoningEffort: 'none' }, deepseek: { thinking: { type: 'disabled', budget: 20 } },
      });
    });

    test('invalid containers and prototype paths cannot pollute config or mask healthy options', async () => {
      const config = await loadConfigWithEngine(reader({
        provider_chat_options: '[]',
        'provider_chat_options.__proto__.polluted': 'true',
        'provider_chat_options.deepseek.constructor.prototype.polluted': 'true',
        'provider_chat_options.deepseek..thinking': 'true',
        'provider_chat_options.deepseek.thinking.type': 'disabled',
      }, mode), { engine: 'pglite' });
      expect(config?.provider_chat_options).toEqual({ deepseek: { thinking: { type: 'disabled' } } });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test('object rows, null leaves, and longest literal selectors retain their shapes', async () => {
      const config = await loadConfigWithEngine(reader({
        provider_chat_options: '{"openai:gpt-5.4":{},"openai:gpt-5":{}}',
        'provider_chat_options.openai:gpt-5.4.reasoningEffort': 'none',
        'provider_chat_options.deepseek': '{"thinking":{"type":"disabled"},"stop":["END"]}',
        'provider_chat_options.deepseek.extra': 'null',
        'provider_chat_options.deepseek.enabled': 'true',
      }, mode), { engine: 'pglite' });
      expect(config?.provider_chat_options).toEqual({
        'openai:gpt-5.4': { reasoningEffort: 'none' }, 'openai:gpt-5': {},
        deepseek: { thinking: { type: 'disabled' }, stop: ['END'], extra: null, enabled: true },
      });
    });
  });
}

test('an unavailable prefix does not suppress a healthy chat-option prefix', async () => {
  const engine = reader({ 'provider_chat_options.deepseek.thinking.type': 'disabled' }, 'keys');
  const list = engine.listConfigKeys!;
  engine.listConfigKeys = async prefix => {
    if (prefix === 'cycle.') throw new Error('unavailable');
    return list(prefix);
  };
  expect((await loadConfigWithEngine(engine, { engine: 'pglite' }))?.provider_chat_options)
    .toEqual({ deepseek: { thinking: { type: 'disabled' } } });
});

test('empty or unreachable DB preserves file options without adding a container', async () => {
  expect((await loadConfigWithEngine(reader({}, 'snapshot'), { engine: 'pglite' }))?.provider_chat_options).toBeUndefined();
  const file = { engine: 'pglite' as const, provider_chat_options: { deepseek: { thinking: { type: 'disabled' } } } };
  const engine = { getConfig: async () => { throw new Error('unavailable'); } };
  expect((await loadConfigWithEngine(engine, file))?.provider_chat_options).toEqual(file.provider_chat_options);
});

test('DB-only thinking switch reaches the real compatible SDK request body', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    bodies.push(body);
    return Response.json({ id: 'stub', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } });
  try {
    const values: Record<string, string> = {};
    const engine = { ...reader(values, 'snapshot'), setConfig: async (key: string, value: string) => { values[key] = value; } };
    await runConfig(engine as unknown as BrainEngine, ['set', 'provider_chat_options.deepseek.thinking.type', 'enabled']);
    await runConfig(engine as unknown as BrainEngine, ['set', 'provider_chat_options.deepseek:deepseek-v4-flash.thinking.type', 'disabled']);
    expect(values['provider_chat_options.deepseek:deepseek-v4-flash.thinking.type']).toBe('disabled');
    const config = await loadConfigWithEngine(engine, { engine: 'pglite' });
    configureGateway({ ...buildGatewayConfig(config!), env: { DEEPSEEK_API_KEY: 'stub' },
      base_urls: { deepseek: `http://127.0.0.1:${server.port}/v1` } });
    const result = await chat({ model: 'deepseek:deepseek-v4-flash', messages: [{ role: 'user', content: 'test' }], maxTokens: 64 });
    expect(result.text).toBe('ok');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
  } finally { server.stop(true); }
});
