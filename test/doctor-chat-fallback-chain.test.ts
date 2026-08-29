import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkChatFallbackChainInert } from '../src/commands/doctor.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

function engineWithDbValue(value: string | null): BrainEngine {
  return {
    getConfig: async (key: string) => key === 'chat_fallback_chain' ? value : null,
  } as unknown as BrainEngine;
}

describe('chat_fallback_chain doctor warning', () => {
  test('loads the effective env config in the production one-argument call shape', async () => {
    const engine = engineWithDbValue(null);
    const configHome = emptyHome();
    mkdirSync(join(configHome, '.gbrain'));
    writeFileSync(join(configHome, '.gbrain', 'config.json'), '{"engine":"pglite"}');

    await withEnv(
      { GBRAIN_HOME: configHome, GBRAIN_CHAT_FALLBACK_CHAIN: 'openai:gpt-5.6-luna' },
      async () => {
        expect((await checkChatFallbackChainInert(engine))?.status).toBe('warn');
      },
    );
    await withEnv(
      { GBRAIN_HOME: configHome, GBRAIN_CHAT_FALLBACK_CHAIN: undefined },
      async () => {
        expect(await checkChatFallbackChainInert(engine)).toBeNull();
      },
    );
  });

  test('warns with the full remediation message when both planes hold a value', async () => {
    const check = await checkChatFallbackChainInert(
      engineWithDbValue('["openai:gpt-5.2"]'),
      { chat_fallback_chain: ['anthropic:claude-sonnet-4-6'] },
    );

    expect(check).toEqual({
      name: 'chat_fallback_chain_inert',
      status: 'warn',
      message:
        '`chat_fallback_chain` is set but currently has no effect: no production chat path consumes it. ' +
        'If you set it expecting fallback behavior, clear it from every plane that still holds a value: ' +
        'the DB (`gbrain config unset chat_fallback_chain`), `~/.gbrain/config.json`, and `GBRAIN_CHAT_FALLBACK_CHAIN`.',
    });
  });

  test('warns when only the DB-plane value is non-empty', async () => {
    const check = await checkChatFallbackChainInert(
      engineWithDbValue('["openai:gpt-5.2"]'),
      { chat_fallback_chain: [] },
    );

    expect(check?.status).toBe('warn');
  });

  test('stays silent when the key is unset or explicitly empty', async () => {
    expect(await checkChatFallbackChainInert(engineWithDbValue(null), null)).toBeNull();
    expect(
      await checkChatFallbackChainInert(engineWithDbValue('[]'), { chat_fallback_chain: [] }),
    ).toBeNull();
  });
});
