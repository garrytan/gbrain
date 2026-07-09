import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeConfigDirectory, desktopConfigPath, getSetupInfo, markDesktopMigration, needsDesktopMigration,
  normalizePgliteDatabasePath, preferredConfigDirectory, restoreConfig, saveSetup, writeJsonConfig,
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
        embeddingDimensions: 1024,
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
        embeddingDimensions: 1024,
      },
    });

    const config = JSON.parse(readFileSync(desktopConfigPath(), 'utf8'));
    expect(config.desktop.knowledge_directory).toBe(path);
    expect(config.desktop.knowledge_source_id).toBe('duwu');
    expect(getSetupInfo().current.knowledgeSourceId).toBe('duwu');
  });

  test('requires an explicit embedding dimension when an embedding model is configured', () => {
    const root = isolatedHome();

    expect(() => saveSetup({
      engine: 'pglite',
      databasePath: join(root, 'selected-db-parent'),
      knowledgeDirectory: join(root, 'knowledge'),
      keys: {},
      modelConfig: {
        chatModel: 'zhipu:glm-4-plus',
        embeddingModel: 'zhipu:embedding-3',
      },
    })).toThrow('请填写有效的向量化维度');
  });

  test('switching from discovered legacy config to PGLite honors the selected local path', () => {
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

      const pmbrainConfigPath = join(root, '.pmbrain', 'config.json');
      const saved = JSON.parse(readFileSync(pmbrainConfigPath, 'utf8'));
      expect(saved.engine).toBe('pglite');
      expect(saved.database_path).toBe(legacyDefault);
      expect(saved.zhipu_api_key).toBe('existing-key');
      expect(existsSync(legacyPath)).toBe(true);
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});
