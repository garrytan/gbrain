import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRecipe } from '../../src/core/ai/recipes/index.js';
import {
  activeConfigDirectory, desktopConfigPath, getSetupInfo, markDesktopMigration, needsDesktopMigration,
  getDatabaseRuntimeConfig, getDesktopPreferences, normalizeDesktopTheme, normalizePgliteDatabasePath, preferredConfigDirectory, restoreConfig,
  isTrayHintShown, markTrayHintShown, saveDesktopPreferences, saveDesktopTheme, saveSetup, writeJsonConfig,
} from '../src/main/config-manager.js';

const originalHome = process.env.PMBRAIN_HOME;
const originalLegacyHome = process.env.GBRAIN_HOME;
const roots: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = originalHome;
  if (originalLegacyHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalLegacyHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-desktop-config-'));
  roots.push(root);
  process.env.PMBRAIN_HOME = root;
  return root;
}

describe('desktop config manager', () => {
  test('keeps legacy users local and defaults window close to tray without rewriting config', () => {
    const root = isolatedHome();
    writeJsonConfig(desktopConfigPath(), {
      engine: 'postgres',
      database_url: 'postgresql://local:secret@127.0.0.1:5433/pmbrain',
      desktop: { theme: 'dark', knowledge_source_id: 'default' },
    });
    const before = readFileSync(desktopConfigPath(), 'utf8');

    expect(getDesktopPreferences()).toEqual({
      networkMode: 'local',
      closeBehavior: 'tray',
      sharedAdapter: undefined,
      sharedIp: undefined,
      sharedResumeRequired: false,
      dockerContainerName: undefined,
    });
    expect(getDatabaseRuntimeConfig().databaseUrl).toBe('postgresql://local:secret@127.0.0.1:5433/pmbrain');
    expect(readFileSync(desktopConfigPath(), 'utf8')).toBe(before);
  });

  test('persists the tray hint once and backs up the existing config', () => {
    isolatedHome();
    writeJsonConfig(desktopConfigPath(), {
      engine: 'pglite',
      desktop: { theme: 'system' },
    });

    expect(isTrayHintShown()).toBe(false);
    const backup = markTrayHintShown();
    expect(backup).not.toBeNull();
    expect(existsSync(backup!)).toBe(true);
    expect(isTrayHintShown()).toBe(true);
    expect(JSON.parse(readFileSync(desktopConfigPath(), 'utf8')).desktop.tray_hint_shown).toBe(true);
    expect(markTrayHintShown()).toBeNull();
  });

  test('persists desktop system preferences with a config backup and preserves existing fields', () => {
    const root = isolatedHome();
    saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'brain.pglite'),
      knowledgeDirectory: join(root, 'knowledge'),
      theme: 'dark',
      keys: { zhipu: 'keep-me' },
    });

    const saved = saveDesktopPreferences({
      networkMode: 'shared',
      sharedAdapter: 'Wi-Fi',
      sharedIp: '192.168.1.20',
      closeBehavior: 'quit',
      sharedResumeRequired: true,
      dockerContainerName: 'gbrain-pg',
    });
    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));

    expect(saved.backup).not.toBeNull();
    expect(existsSync(saved.backup!)).toBe(true);
    expect(saved.preferences.networkMode).toBe('shared');
    expect(config.desktop.network_mode).toBe('shared');
    expect(config.desktop.shared_adapter).toBe('Wi-Fi');
    expect(config.desktop.shared_ip).toBe('192.168.1.20');
    expect(config.desktop.close_behavior).toBe('quit');
    expect(saved.preferences.sharedResumeRequired).toBe(true);
    expect(config.desktop.shared_resume_required).toBe(true);
    expect(config.desktop.docker_container_name).toBe('gbrain-pg');
    expect(config.desktop.theme).toBe('dark');
    expect(config.zhipu_api_key).toBe('keep-me');
    expect(getDesktopPreferences().sharedResumeRequired).toBe(true);
    saveDesktopPreferences({ sharedResumeRequired: false });
    expect(getDesktopPreferences().sharedResumeRequired).toBe(false);
    expect(JSON.parse(readFileSync(desktopConfigPath(), 'utf8')).desktop.shared_resume_required).toBeUndefined();
  });

  test('defaults, persists, and independently updates the desktop theme', () => {
    const root = isolatedHome();
    expect(normalizeDesktopTheme('unexpected')).toBe('system');

    saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'brain.pglite'),
      knowledgeDirectory: join(root, 'knowledge'),
      theme: 'dark',
      keys: { zhipu: 'zhipu-test' },
    });
    expect(getSetupInfo().current.theme).toBe('dark');

    const backup = saveDesktopTheme('light');
    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(backup).not.toBeNull();
    expect(existsSync(backup!)).toBe(true);
    expect(config.desktop.theme).toBe('light');
    expect(config.desktop.knowledge_directory).toBe(join(root, 'knowledge'));
    expect(getSetupInfo().current.theme).toBe('light');
  });

  test('derives new-install model defaults from the CLI recipe registry', () => {
    const root = isolatedHome();
    saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'brain.pglite'),
      keys: { google: 'google-test' },
    });
    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.chat_model).toBe(`google:${getRecipe('google')!.touchpoints.chat!.models[0]}`);
    expect(config.expansion_model).toBe(`google:${getRecipe('google')!.touchpoints.expansion!.models[0]}`);
    expect(config.embedding_model).toBe(`google:${getRecipe('google')!.touchpoints.embedding!.models[0]}`);
  });

  test('normalizes selected PGLite directories to a brain.pglite data directory', () => {
    const root = join(tmpdir(), 'pmbrain-selected-dir');
    expect(normalizePgliteDatabasePath(root)).toBe(join(root, 'brain.pglite'));
    expect(normalizePgliteDatabasePath(join(root, 'brain.pglite'))).toBe(join(root, 'brain.pglite'));
  });

  test('reads a legacy local config without rewriting database or API keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'pmbrain-desktop-legacy-'));
    roots.push(root);
    delete process.env.PMBRAIN_HOME;
    process.env.GBRAIN_HOME = root;
    const path = join(root, '.gbrain', 'config.json');
    const original = {
      engine: 'postgres',
      database_url: 'postgresql://local:secret@127.0.0.1:5432/pmbrain',
      deepseek_api_key: 'existing-key',
    };
    writeJsonConfig(path, original);
    const before = readFileSync(path, 'utf8');
    const info = getSetupInfo();
    expect(activeConfigDirectory()).toBe(join(root, '.gbrain'));
    expect(info.needsSetup).toBe(false);
    expect(info.current.engine).toBe('postgres');
    expect(info.current.databaseConfigured).toBe(true);
    expect(info.current.keyStatus.deepseek).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('reads a config file with a UTF-8 BOM', () => {
    const root = isolatedHome();
    const path = desktopConfigPath();
    mkdirSync(join(root, '.pmbrain'), { recursive: true });
    writeFileSync(path, `\ufeff${JSON.stringify({
      engine: 'postgres',
      database_url: 'postgresql://local:secret@127.0.0.1:5432/pmbrain',
    })}`);

    const info = getSetupInfo();
    expect(info.needsSetup).toBe(false);
    expect(info.current.engine).toBe('postgres');
    expect(info.current.databaseConfigured).toBe(true);
  });

  test('creates secure PGLite config and preserves keys on a later switch', () => {
    const root = isolatedHome();
    const pgliteParent = join(root, 'selected-db-parent');
    const pglite = join(pgliteParent, 'brain.pglite');
    const first = saveSetup({
      engine: 'pglite',
      databasePath: pgliteParent,
      knowledgeDirectory: join(root, 'knowledge'),
      keys: { zhipu: 'zhipu-test' },
      modelConfig: {
        chatModel: 'zhipu:glm-4-plus',
        embeddingModel: 'zhipu:embedding-3',
      },
    });
    const path = desktopConfigPath();
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(config.engine).toBe('pglite');
    expect(config.database_path).toBe(pglite);
    expect(config.zhipu_api_key).toBe('zhipu-test');
    expect(config.chat_model).toBe('zhipu:glm-4-plus');
    expect(config.expansion_model).toBe('zhipu:glm-4-plus');
    expect(config['models.default']).toBe('zhipu:glm-4-plus');
    expect(config.embedding_model).toBe('zhipu:embedding-3');
    expect(config.embedding_dimensions).toBe(1024);
    expect(config.provider_touchpoint_api_keys).toBeUndefined();
    expect(config.admin_bootstrap_token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(config.desktop.knowledge_source_id).toMatch(/^desktop-[0-9a-f]{8}$/);
    const setupInfo = getSetupInfo();
    expect(setupInfo.needsSetup).toBe(false);
    expect(setupInfo.current.chatModel).toBe('zhipu:glm-4-plus');
    expect(setupInfo.current.embeddingModel).toBe('zhipu:embedding-3');
    expect(setupInfo.current.embeddingDimensions).toBe(1024);
    expect(setupInfo.current.knowledgeSourceId).toBe(config.desktop.knowledge_source_id);
    expect(setupInfo.current.keyValues.zhipu).toBe('zhipu-test');
    expect(needsDesktopMigration('1.0.21')).toBe(true);
    markDesktopMigration('1.0.21');
    expect(needsDesktopMigration('1.0.21')).toBe(false);

    saveSetup({ engine: 'postgres', databaseUrl: 'postgresql://u:p@127.0.0.1:5432/brain', keys: { zhipu: '' } });
    const switched = JSON.parse(readFileSync(path, 'utf8'));
    expect(switched.engine).toBe('postgres');
    expect(switched.database_path).toBeUndefined();
    expect(switched.zhipu_api_key).toBe('zhipu-test');
    expect(existsSync(join(root, '.pmbrain', 'backups', 'config'))).toBe(true);

    restoreConfig(first.snapshot);
    expect(existsSync(path)).toBe(false);
  });

  test('persists an explicit desktop knowledge source id', () => {
    const root = isolatedHome();
    const path = join(root, 'knowledge');

    saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'db'),
      knowledgeDirectory: path,
      knowledgeSourceId: 'duwu',
      keys: {},
      modelConfig: {
        chatModel: 'zhipu:glm-4-plus',
        embeddingModel: 'zhipu:embedding-3',
      },
    });

    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.desktop.knowledge_directory).toBe(path);
    expect(config.desktop.knowledge_source_id).toBe('duwu');
    expect(getSetupInfo().current.knowledgeSourceId).toBe('duwu');
  });

  test('automatically selects the recipe recommendation for a new embedding model', () => {
    const root = isolatedHome();

    saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'selected-db-parent'),
      knowledgeDirectory: join(root, 'knowledge'),
      keys: {},
      modelConfig: {
        chatModel: 'zhipu:glm-4-plus',
        embeddingModel: 'zhipu:embedding-3',
      },
    });

    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.embedding_dimensions).toBe(1024);
  });

  test('preserves a legacy dimension until the user actively changes models', () => {
    const root = isolatedHome();
    writeJsonConfig(desktopConfigPath(), {
      engine: 'pglite',
      database_path: join(root, 'brain.pglite'),
      embedding_model: 'zhipu:embedding-3',
      embedding_dimensions: 1280,
    });

    saveSetup({
      engine: 'pglite',
      modelConfig: { embeddingModel: 'zhipu:embedding-3' },
    });
    let config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.embedding_dimensions).toBe(1280);

    saveSetup({
      engine: 'pglite',
      modelConfig: { embeddingModel: 'zhipu:embedding-2' },
    });
    config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.embedding_dimensions).toBe(1024);
  });

  test('marks an unknown custom model for one-time dimension probing', () => {
    const root = isolatedHome();
    const saved = saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'brain.pglite'),
      modelConfig: { embeddingModel: 'litellm:private-embedding-model' },
    });
    expect(saved.needsEmbeddingDimensionProbe).toBe(true);
  });

  test('marks every existing embedding model change for validation and re-embedding', () => {
    isolatedHome();
    saveSetup({
      engine: 'postgres',
      databaseUrl: 'postgresql://u:p@127.0.0.1:5432/brain',
      modelConfig: {
        chatModel: 'zhipu:glm-4-flash',
        embeddingModel: 'zhipu:embedding-3',
        embeddingDimensions: 1024,
      },
      keys: { zhipu: 'key' },
    });

    const saved = saveSetup({
      engine: 'postgres',
      databaseUrl: 'postgresql://u:p@127.0.0.1:5432/brain',
      modelConfig: {
        chatModel: 'zhipu:glm-4-flash',
        embeddingModel: 'ollama:qwen3-embedding:0.6b',
      },
      keys: { zhipu: '' },
    });

    expect(saved.embeddingModelChanged).toBe(true);
    expect(saved.previousEmbeddingModel).toBe('zhipu:embedding-3');
  });

  test('persists a local Ollama chat model without requiring an API key', () => {
    const root = isolatedHome();
    saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'brain.pglite'),
      keys: {},
      modelConfig: {
        chatModel: 'ollama:qwen3:latest',
        embeddingModel: 'ollama:nomic-embed-text',
        embeddingDimensions: 768,
      },
    });

    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.chat_model).toBe('ollama:qwen3:latest');
    expect(config.expansion_model).toBe('ollama:qwen3:latest');
    expect(config['models.default']).toBe('ollama:qwen3:latest');
    expect(config.ollama_api_key).toBeUndefined();
  });

  test('persists a validated custom OpenAI-compatible provider without losing other URLs', () => {
    const root = isolatedHome();
    writeJsonConfig(desktopConfigPath(), {
      engine: 'pglite',
      database_path: join(root, 'brain.pglite'),
      embedding_model: 'zhipu:embedding-3',
      embedding_dimensions: 1024,
      provider_base_urls: { openrouter: 'https://openrouter.example/v1' },
    });

    const saved = saveSetup({
      engine: 'pglite',
      customProvider: {
        id: 'custom-openai',
        displayName: '本地 Qwen',
        baseUrl: 'http://127.0.0.1:8000/v1/',
      },
      keys: { customOpenai: 'local-key' },
      modelConfig: {
        chatModel: 'custom-openai:Qwen3-35B-A3B',
        embeddingModel: 'custom-openai:Qwen3-Embedding-8B',
        embeddingDimensions: 4096,
      },
    });

    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.provider_base_urls.openrouter).toBe('https://openrouter.example/v1');
    expect(config.provider_base_urls['custom-openai']).toBe('http://127.0.0.1:8000/v1');
    expect(config.desktop.custom_openai_display_name).toBe('本地 Qwen');
    expect(config.custom_openai_api_key).toBe('local-key');
    expect(config.chat_model).toBe('custom-openai:Qwen3-35B-A3B');
    expect(config.embedding_model).toBe('custom-openai:Qwen3-Embedding-8B');
    expect(saved.needsEmbeddingDimensionProbe).toBe(false);

    const info = getSetupInfo();
    expect(info.current.customProvider).toEqual({
      id: 'custom-openai',
      displayName: '本地 Qwen',
      baseUrls: {
        chat: 'http://127.0.0.1:8000/v1',
        embedding: 'http://127.0.0.1:8000/v1',
      },
    });
    expect(info.current.keyStatus.customOpenai).toBe(true);
    expect(info.current.keyValues.customOpenai).toBe('local-key');
    expect(info.current.keyStatus.customOpenaiChat).toBe(true);
    expect(info.current.keyStatus.customOpenaiEmbedding).toBe(true);
    expect(info.current.keyValues.customOpenaiChat).toBe('local-key');
    expect(info.current.keyValues.customOpenaiEmbedding).toBe('local-key');
  });

  test('persists and restores separate custom OpenAI chat and embedding endpoints and keys', () => {
    const root = isolatedHome();
    writeJsonConfig(desktopConfigPath(), {
      engine: 'pglite',
      database_path: join(root, 'brain.pglite'),
      embedding_model: 'zhipu:embedding-3',
      embedding_dimensions: 1024,
      custom_openai_api_key: 'legacy-shared-key',
      provider_touchpoint_api_keys: {
        'custom-openai': { expansion: 'keep-expansion-key', reranker: 'keep-reranker-key' },
        openrouter: { chat: 'keep-other-provider-key' },
      },
    });

    saveSetup({
      engine: 'pglite',
      customProvider: {
        id: 'custom-openai',
        displayName: 'Enterprise Qwen',
        baseUrls: {
          chat: 'http://10.0.0.20:8000/v1/',
          embedding: 'http://10.0.0.20:8001/v1/',
        },
      },
      keys: {
        customOpenaiChat: 'chat-key',
        customOpenaiEmbedding: 'embedding-key',
      },
      modelConfig: {
        chatModel: 'custom-openai:Qwen3-35B-A3B',
        embeddingModel: 'custom-openai:Qwen3-Embedding-8B',
        embeddingDimensions: 4096,
      },
    });

    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.provider_touchpoint_base_urls['custom-openai']).toEqual({
      chat: 'http://10.0.0.20:8000/v1',
      embedding: 'http://10.0.0.20:8001/v1',
    });
    expect(config.provider_base_urls['custom-openai']).toBe('http://10.0.0.20:8000/v1');
    expect(config.custom_openai_api_key).toBe('legacy-shared-key');
    expect(config.provider_touchpoint_api_keys).toEqual({
      'custom-openai': {
        expansion: 'keep-expansion-key',
        reranker: 'keep-reranker-key',
        chat: 'chat-key',
        embedding: 'embedding-key',
      },
      openrouter: { chat: 'keep-other-provider-key' },
    });
    expect(getSetupInfo().current.customProvider).toEqual({
      id: 'custom-openai',
      displayName: 'Enterprise Qwen',
      baseUrls: {
        chat: 'http://10.0.0.20:8000/v1',
        embedding: 'http://10.0.0.20:8001/v1',
      },
    });
    const info = getSetupInfo();
    expect(info.current.keyValues.customOpenai).toBe('legacy-shared-key');
    expect(info.current.keyValues.customOpenaiChat).toBe('chat-key');
    expect(info.current.keyValues.customOpenaiEmbedding).toBe('embedding-key');
  });

  test('rejects unsafe custom provider URLs before writing config', () => {
    const root = isolatedHome();
    expect(() => saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'brain.pglite'),
      customProvider: {
        id: 'custom-openai',
        displayName: '本地 Qwen',
        baseUrl: 'file:///C:/models/qwen',
      },
      modelConfig: {
        chatModel: 'custom-openai:qwen',
        embeddingModel: 'custom-openai:qwen-embedding',
        embeddingDimensions: 4096,
      },
    })).toThrow('只能使用 http/https');
    expect(existsSync(desktopConfigPath())).toBe(false);
  });

  test('desktop reads and writes the same discovered legacy CLI config', () => {
    const root = mkdtempSync(join(tmpdir(), 'pmbrain-desktop-legacy-switch-'));
    roots.push(root);
    const oldUserProfile = process.env.USERPROFILE;
    const oldHome = process.env.HOME;
    delete process.env.PMBRAIN_HOME;
    delete process.env.GBRAIN_HOME;
    process.env.USERPROFILE = root;
    process.env.HOME = root;

    try {
      const legacyPath = join(root, '.gbrain', 'config.json');
      writeJsonConfig(legacyPath, {
        engine: 'postgres',
        database_url: 'postgresql://local:secret@127.0.0.1:5432/pmbrain',
        zhipu_api_key: 'existing-key',
      });
      const info = getSetupInfo();
      const legacyDefault = join(root, '.gbrain', 'brain.pglite');
      expect(activeConfigDirectory()).toBe(join(root, '.gbrain'));
      expect(preferredConfigDirectory()).toBe(join(root, '.pmbrain'));
      expect(info.defaults.databasePath).toBe(join(root, '.pmbrain', 'brain.pglite'));

      saveSetup({
        engine: 'pglite',
        databasePath: legacyDefault,
        knowledgeDirectory: join(root, 'knowledge'),
        keys: {},
      });

      const saved = JSON.parse(readFileSync(legacyPath, 'utf8'));
      expect(saved.engine).toBe('pglite');
      expect(saved.database_path).toBe(legacyDefault);
      expect(saved.zhipu_api_key).toBe('existing-key');
      expect(existsSync(legacyPath)).toBe(true);
      expect(existsSync(join(root, '.pmbrain', 'config.json'))).toBe(false);
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});
