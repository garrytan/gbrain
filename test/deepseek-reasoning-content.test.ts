import { afterEach, describe, expect, test } from 'bun:test';
import {
  chat,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';

const originalFetch = globalThis.fetch;

function installDeepSeekResponse(message: Record<string, unknown>): void {
  globalThis.fetch = (async () => {
    const json = {
      id: 'fake-deepseek-chatcmpl',
      object: 'chat.completion',
      created: 0,
      model: 'deepseek-reasoner',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            ...message,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

async function runDeepSeekChat(): Promise<string> {
  configureGateway({
    chat_model: 'deepseek:deepseek-reasoner',
    env: { DEEPSEEK_API_KEY: 'sk-deepseek-fake' },
  });
  const result = await chat({
    model: 'deepseek:deepseek-reasoner',
    messages: [{ role: 'user', content: 'summarize this chunk' }],
  });
  return result.text;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGateway();
});

describe('DeepSeek reasoning_content compatibility fetch', () => {
  test('empty content + reasoning_content promotes reasoning text into chat output', async () => {
    installDeepSeekResponse({
      content: '',
      reasoning_content: 'The synopsis lives here.',
    });

    await expect(runDeepSeekChat()).resolves.toBe('The synopsis lives here.');
  });

  test('non-empty content + reasoning_content passes content through unchanged', async () => {
    installDeepSeekResponse({
      content: 'Use the final answer.',
      reasoning_content: 'Do not duplicate this reasoning.',
    });

    await expect(runDeepSeekChat()).resolves.toBe('Use the final answer.');
  });

  test('empty content + empty reasoning_content stays empty without crashing', async () => {
    installDeepSeekResponse({
      content: '',
      reasoning_content: '',
    });

    await expect(runDeepSeekChat()).resolves.toBe('');
  });
});
