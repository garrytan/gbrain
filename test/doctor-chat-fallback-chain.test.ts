import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkChatFallbackChain } from '../src/commands/doctor.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

function engineWithDbValue(value: string | null): BrainEngine {
  return {
    getConfig: async (key: string) => (key === 'chat_fallback_chain' ? value : null),
  } as unknown as BrainEngine;
}

describe('chat_fallback_chain doctor check', () => {
  test('loads the effective env config in the production one-argument call shape', async () => {
    const engine = engineWithDbValue(null);
    const configHome = emptyHome();
    mkdirSync(join(configHome, '.gbrain'));
    writeFileSync(
      join(configHome, '.gbrain', 'config.json'),
      '{"engine":"pglite"}',
    );

    await withEnv(
      {
        GBRAIN_HOME: configHome,
        GBRAIN_CHAT_FALLBACK_CHAIN: 'openai:gpt-5.6-luna',
      },
      async () => {
        const check = await checkChatFallbackChain(engine);
        expect(check?.status).toBe('ok');
        expect(check?.name).toBe('chat_fallback_chain');
      },
    );
    await withEnv(
      { GBRAIN_HOME: configHome, GBRAIN_CHAT_FALLBACK_CHAIN: undefined },
      async () => {
        expect(await checkChatFallbackChain(engine)).toBeNull();
      },
    );
  });

  test('reports an ok line naming the chain when any plane holds a value', async () => {
    const check = await checkChatFallbackChain(
      engineWithDbValue('["openai:gpt-5.2"]'),
      { chat_fallback_chain: ['anthropic:claude-sonnet-4-6'] },
    );

    expect(check).toEqual({
      name: 'chat_fallback_chain',
      status: 'ok',
      message:
        '`chat_fallback_chain` is configured and consumed by `gateway.chat()`: on primary-model failure ' +
        'or a D8 structural refusal (stopReason refusal/content_filter), the chain is consulted in order.' +
        ' Entries: [anthropic:claude-sonnet-4-6].',
    });
  });

  test('ok when only the DB-plane value is non-empty', async () => {
    const check = await checkChatFallbackChain(
      engineWithDbValue('["openai:gpt-5.2"]'),
      { chat_fallback_chain: [] },
    );

    expect(check?.status).toBe('ok');
  });

  test('stays silent when the key is unset or explicitly empty', async () => {
    expect(await checkChatFallbackChain(engineWithDbValue(null), null)).toBeNull();
    expect(
      await checkChatFallbackChain(engineWithDbValue('[]'), {
        chat_fallback_chain: [],
      }),
    ).toBeNull();
  });
});