import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { getChatModel, getExpansionModel, isOcrEnabled, resetGateway } from '../../src/core/ai/gateway.ts';
import { reloadLiveGateway } from '../../src/core/ai/reload-live-gateway.ts';
import { withEnv } from '../helpers/with-env.ts';

test('运行中的模型配置可以从新的 config.json 热刷新', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pmbrain-gateway-reload-'));
  try {
    await withEnv({
      PMBRAIN_HOME: home,
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
      PMBRAIN_DATABASE_URL: undefined,
    }, async () => {
      const directory = join(home, '.pmbrain');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'config.json'), JSON.stringify({
        engine: 'pglite',
        database_path: join(directory, 'brain.pglite'),
        chat_model: 'ollama:live-chat',
        expansion_model: 'ollama:live-chat',
        'models.default': 'ollama:live-chat',
        ocr_enabled: true,
        ocr_model: 'ollama:live-ocr',
        embedding_disabled: true,
        provider_base_urls: { ollama: 'http://127.0.0.1:11434/v1' },
      }));
      const engine = { getConfig: async () => null, unsetConfig: async () => undefined } as unknown as BrainEngine;
      await reloadLiveGateway(engine);
      expect(getChatModel()).toBe('ollama:live-chat');
      expect(getExpansionModel()).toBe('ollama:live-chat');
      expect(isOcrEnabled()).toBe(true);
    });
  } finally {
    resetGateway();
    rmSync(home, { recursive: true, force: true });
  }
});
