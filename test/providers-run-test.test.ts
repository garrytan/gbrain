import { beforeEach, describe, expect, mock, test } from 'bun:test';

const configureGatewayCalls: Array<Record<string, unknown>> = [];

mock.module('../src/core/config.ts', () => ({
  loadConfig: () => ({
    embedding_model: 'ollama:bge-m3',
    embedding_dimensions: 1024,
  }),
}));

mock.module('../src/core/ai/gateway.ts', () => ({
  configureGateway: (opts: Record<string, unknown>) => {
    configureGatewayCalls.push(opts);
  },
  embedOne: async () => new Array(1024).fill(0),
  isAvailable: () => true,
  chat: async () => ({
    text: 'pong',
    model: 'mock',
    stopReason: 'stop',
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
}));

mock.module('../src/core/ai/probes.ts', () => ({
  probeOllama: async () => ({ ok: true }),
  probeLMStudio: async () => ({ ok: true }),
}));

const { runProviders } = await import('../src/commands/providers.ts');

describe('runProviders test --model embedding override', () => {
  beforeEach(() => {
    configureGatewayCalls.length = 0;
  });

  test('uses configured embedding dimensions when the override matches the active model', async () => {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};

    try {
      await runProviders('test', ['--model', 'ollama:bge-m3']);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(configureGatewayCalls.at(-1)).toMatchObject({
      embedding_model: 'ollama:bge-m3',
      embedding_dimensions: 1024,
    });
  });
});
