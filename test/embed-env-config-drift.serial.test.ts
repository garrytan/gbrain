import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  runEmbedCore,
} from '../src/commands/embed.ts';
import {
  assertNoEmbeddingEnvConfigDrift,
  configPath,
  saveConfig,
} from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

let configHome: string;
let originalPmbrainHome: string | undefined;
let originalGbrainHome: string | undefined;

beforeAll(() => {
  originalPmbrainHome = process.env.PMBRAIN_HOME;
  originalGbrainHome = process.env.GBRAIN_HOME;
  configHome = mkdtempSync(join(tmpdir(), 'pmbrain-embed-env-'));
  process.env.PMBRAIN_HOME = configHome;
  delete process.env.GBRAIN_HOME;
});

afterAll(() => {
  if (originalPmbrainHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = originalPmbrainHome;
  if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalGbrainHome;
  rmSync(configHome, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(configPath(), { force: true });
});

describe('ordinary embed env override guard', () => {
  test('refuses PMBRAIN model and dimension drift before embedding', () => {
    saveConfig({
      engine: 'pglite',
      embedding_model: 'ollama:qwen3-embedding:0.6b',
      embedding_dimensions: 1024,
    });

    expect(() => assertNoEmbeddingEnvConfigDrift({
      PMBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
      PMBRAIN_EMBEDDING_DIMENSIONS: '1280',
    })).toThrow('本次向量化已停止且没有修改数据');
  });

  test('runEmbedCore enforces the guard before credentials, provider calls, or DB writes', async () => {
    saveConfig({
      engine: 'pglite',
      embedding_model: 'ollama:qwen3-embedding:0.6b',
      embedding_dimensions: 1024,
    });

    await withEnv(
      {
        PMBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
        PMBRAIN_EMBEDDING_DIMENSIONS: '1280',
      },
      async () => {
        await expect(runEmbedCore({} as BrainEngine, { stale: true }))
          .rejects.toThrow('本次向量化已停止且没有修改数据');
      },
    );
  });

  test('embed, import, sync, and put_page all enforce the shared write guard', () => {
    for (const relativePath of [
      '../src/commands/embed.ts',
      '../src/commands/import.ts',
      '../src/commands/sync.ts',
      '../src/core/operations.ts',
    ]) {
      expect(readFileSync(join(import.meta.dir, relativePath), 'utf8'))
        .toContain('assertNoEmbeddingEnvConfigDrift');
    }
  });

  test('allows matching persisted config', () => {
    saveConfig({
      engine: 'pglite',
      embedding_model: 'ollama:qwen3-embedding:0.6b',
      embedding_dimensions: 1024,
    });

    expect(() => assertNoEmbeddingEnvConfigDrift({
      PMBRAIN_EMBEDDING_MODEL: 'ollama:qwen3-embedding:0.6b',
      PMBRAIN_EMBEDDING_DIMENSIONS: '1024',
    })).not.toThrow();
  });

  test('PMBRAIN aliases shadow legacy aliases exactly as loadConfig does', () => {
    saveConfig({
      engine: 'pglite',
      embedding_model: 'ollama:qwen3-embedding:0.6b',
      embedding_dimensions: 1024,
    });

    expect(() => assertNoEmbeddingEnvConfigDrift({
      PMBRAIN_EMBEDDING_MODEL: 'ollama:qwen3-embedding:0.6b',
      GBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
      PMBRAIN_EMBEDDING_DIMENSIONS: '1024',
      GBRAIN_EMBEDDING_DIMENSIONS: '1280',
    })).not.toThrow();
  });

  test('preserves explicit env-only headless deployments without config.json', () => {
    expect(() => assertNoEmbeddingEnvConfigDrift({
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
      GBRAIN_EMBEDDING_DIMENSIONS: '1536',
    })).not.toThrow();
  });

  test('refuses an env dimension when custom model dimension is not persisted', () => {
    saveConfig({
      engine: 'pglite',
      embedding_model: 'ollama:qwen3-embedding:0.6b',
    });

    expect(() => assertNoEmbeddingEnvConfigDrift({
      PMBRAIN_EMBEDDING_DIMENSIONS: '1024',
    })).toThrow('config.json=未设置');
  });

  test('refuses env-controlled embedding when config.json is unreadable', () => {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), '{not-json', 'utf8');

    expect(() => assertNoEmbeddingEnvConfigDrift({
      PMBRAIN_EMBEDDING_MODEL: 'zeroentropyai:zembed-1',
    })).toThrow('无法读取持久化配置');
  });
});
