/**
 * Foreground batch commands are normally reached after cli.ts configures the
 * process-global gateway. Keep the command boundary defensive as well: an
 * embedding/CLI loader can leave that singleton cold while the persisted chat
 * configuration and provider credentials are valid (#2590).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAvailable, resetGateway } from '../src/core/ai/gateway.ts';
import { runExtractConversationFacts } from '../src/commands/extract-conversation-facts.ts';
import { runEnrich } from '../src/commands/enrich.ts';

let home: string;
const originalHome = process.env.GBRAIN_HOME;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-foreground-gateway-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: join(home, '.gbrain', 'brain.pglite'),
    chat_model: 'openai:example-chat-model',
  }));
  process.env.GBRAIN_HOME = home;
  process.env.OPENAI_API_KEY = 'test-key';
  resetGateway();
});

afterEach(() => {
  resetGateway();
  if (originalHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalHome;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  rmSync(home, { recursive: true, force: true });
});

describe('foreground chat gateway initialization (#2590)', () => {
  test('extract-conversation-facts initializes a cold gateway from persisted config before its availability gate', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('unexpected process.exit');
    }) as never);

    try {
      await runExtractConversationFacts({
        executeRaw: async () => [],
      } as never, []);
    } finally {
      exit.mockRestore();
    }

    expect(exit).not.toHaveBeenCalled();
    expect(isAvailable('chat')).toBe(true);
  });

  test('enrich initializes a cold gateway from persisted config before its availability gate', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('unexpected process.exit');
    }) as never);

    try {
      await runEnrich({
        executeRaw: async () => [],
        getConfig: async () => null,
      } as never, ['--yes']);
    } finally {
      exit.mockRestore();
    }

    expect(exit).not.toHaveBeenCalled();
    expect(isAvailable('chat')).toBe(true);
  });
});
