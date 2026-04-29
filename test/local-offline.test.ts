import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEmbed } from '../src/commands/embed.ts';
import { createLocalConfigDefaults } from '../src/core/config.ts';
import { embedChunks, getEmbeddingProvider, resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from '../src/core/embedding.ts';
import { getEngineCapabilities } from '../src/core/engine-capabilities.ts';
import { buildPageChunks, importFile } from '../src/core/import-file.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const originalEnv = { ...process.env };
let tempDir = '';
let dbPath = '';
let engine: SQLiteEngine;

function createFakeProvider() {
  const batches: string[][] = [];
  return {
    batches,
    provider: {
      capability: {
        available: true,
        mode: 'local' as const,
        implementation: 'test-local' as const,
        model: 'test-local-v1',
        dimensions: 3,
      },
      embedBatch: async (texts: string[]) => {
        batches.push([...texts]);
        return texts.map((text, index) => new Float32Array([text.length, index + 1, texts.length]));
      },
    },
  };
}

function createCapturingProvider(model: string) {
  const batches: string[][] = [];
  return {
    batches,
    provider: {
      capability: {
        available: true,
        mode: 'local' as const,
        implementation: 'test-local' as const,
        model,
        dimensions: 3,
      },
      embedBatch: async (texts: string[]) => {
        batches.push([...texts]);
        return texts.map((_text, index) => new Float32Array([index + 1, texts.length, model.length]));
      },
    },
  };
}

function createMappedProvider(vectors: Record<string, number[]>) {
  return {
    capability: {
      available: true,
      mode: 'local' as const,
      implementation: 'test-local' as const,
      model: 'test-local-v1',
      dimensions: Object.values(vectors)[0]?.length ?? null,
    },
    embedBatch: async (texts: string[]) => texts.map((text) => {
      const vector = vectors[text];
      if (!vector) {
        throw new Error(`No test embedding configured for "${text}"`);
      }
      return new Float32Array(vector);
    }),
  };
}

function createUnavailableProvider(reason: string) {
  return {
    capability: {
      available: false,
      mode: 'none' as const,
      implementation: 'none' as const,
      model: null,
      dimensions: null,
      reason,
    },
    embedBatch: async () => {
      throw new Error(reason);
    },
  };
}



function writeUserConfig(config: Record<string, unknown>) {
  const configDir = join(tempDir, '.mbrain');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2));
}

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const stdout: string[] = [];
  const logSpy = mock((msg?: unknown) => { logs.push(String(msg ?? '')); });
  const errorSpy = mock((msg?: unknown) => { errors.push(String(msg ?? '')); });
  const exitSpy = mock((_code?: number) => undefined as never);
  const stdoutSpy = mock((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;

  console.log = logSpy as typeof console.log;
  console.error = errorSpy as typeof console.error;
  process.exit = exitSpy as typeof process.exit;
  process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;

  return {
    logs,
    errors,
    stdout,
    exitSpy,
    restore() {
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
      process.stdout.write = originalStdoutWrite;
    },
  };
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'mbrain-local-offline-'));
  dbPath = join(tempDir, 'brain.db');
  process.env.HOME = tempDir;
  delete process.env.MBRAIN_CONFIG_DIR;
  delete process.env.MBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: dbPath });
  await engine.initSchema();
});

afterEach(async () => {
  process.env = { ...originalEnv };
  resetEmbeddingProviderForTests();
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('local/offline profile semantics', () => {
  test('sqlite capability policy allows staged import concurrency without multi-writer fanout', () => {
    expect(getEngineCapabilities({ engine: 'sqlite' } as any)).toMatchObject({
      parallelWorkers: false,
      stagedImportConcurrency: true,
    });
  });

  test('offline profile marks cloud-only capabilities unsupported in local mode', async () => {
    const { resolveOfflineProfile } = await import('../src/core/offline-profile.ts');

    const profile = resolveOfflineProfile(createLocalConfigDefaults({
      engine: 'sqlite',
      database_path: dbPath,
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    }));

    expect(profile.status).toBe('local_offline');
    expect(profile.offline).toBe(true);
    expect(profile.engine.type).toBe('sqlite');
    expect(profile.embedding.mode).toBe('local');
    expect(profile.rewrite.mode).toBe('heuristic');
    expect(profile.capabilities.check_update.supported).toBe(false);
    expect(profile.capabilities.check_update.reason).toMatch(/local\/offline/i);
    expect(profile.capabilities.files.supported).toBe(false);
    expect(profile.capabilities.files.reason).toMatch(/sqlite\/local mode/i);
  });

  test('init --local writes sqlite offline defaults without a cloud database URL', async () => {
    const capture = captureConsole();

    try {
      const { runInit } = await import('../src/commands/init.ts');
      await runInit(['--local', '--json']);
    } finally {
      capture.restore();
    }

    const { loadConfig } = await import('../src/core/config.ts');
    const config = loadConfig();

    expect(config).toMatchObject({
      engine: 'sqlite',
      database_path: join(tempDir, '.mbrain', 'brain.db'),
      offline: true,
      embedding_provider: 'local',
      embedding_model: 'nomic-embed-text',
      query_rewrite_provider: 'heuristic',
    });
    expect(readFileSync(join(tempDir, '.mbrain', 'config.json'), 'utf-8')).toContain('"engine": "sqlite"');
  });

  test('query rewrite provider none returns the original query without contacting a runtime', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async () => new Response('{}'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const { expandQuery } = await import('../src/core/search/expansion.ts');
      const result = await expandQuery('offline query rewrite stays disabled', {
        config: {
          engine: 'sqlite',
          database_path: dbPath,
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'none',
        },
      });

      expect(result).toEqual(['offline query rewrite stays disabled']);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('local_llm rewrite uses MBRAIN_LOCAL_LLM_URL JSON mode', async () => {
    process.env.MBRAIN_LOCAL_LLM_URL = 'http://127.0.0.1:4010/rewrite';
    process.env.MBRAIN_LOCAL_LLM_MODEL = 'test-local-rewrite';

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:4010/rewrite');
      return new Response(JSON.stringify({
        alternatives: ['local semantic recall', 'semantic retrieval phrasing'],
      }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const { expandQuery } = await import('../src/core/search/expansion.ts');
      const result = await expandQuery('offline rewrite finds related concepts', {
        config: {
          engine: 'sqlite',
          database_path: dbPath,
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'local_llm',
        },
      });

      expect(result).toEqual([
        'offline rewrite finds related concepts',
        'local semantic recall',
        'semantic retrieval phrasing',
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.MBRAIN_LOCAL_LLM_URL;
      delete process.env.MBRAIN_LOCAL_LLM_MODEL;
    }
  });

  test('local_llm rewrite uses OLLAMA_HOST generate mode', async () => {
    process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
    process.env.MBRAIN_LOCAL_LLM_MODEL = 'qwen-test';

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:11434/api/generate');
      return new Response(JSON.stringify({
        response: JSON.stringify({
          alternatives: ['vector search recall', 'keyword + vector retrieval'],
        }),
      }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const { expandQuery } = await import('../src/core/search/expansion.ts');
      const result = await expandQuery('hybrid search finds nearby matches', {
        config: {
          engine: 'sqlite',
          database_path: dbPath,
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'local_llm',
        },
      });

      expect(result).toEqual([
        'hybrid search finds nearby matches',
        'vector search recall',
        'keyword + vector retrieval',
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OLLAMA_HOST;
      delete process.env.MBRAIN_LOCAL_LLM_MODEL;
    }
  });

  test('local_llm rewrite falls back cleanly on malformed non-JSON payloads', async () => {
    process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async () => new Response(JSON.stringify({
      response: 'totally not structured rewrite output',
    }), {
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const { expandQuery } = await import('../src/core/search/expansion.ts');
      const result = await expandQuery('offline rewrite must fail safely', {
        config: {
          engine: 'sqlite',
          database_path: dbPath,
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'local_llm',
        },
      });

      expect(result).toEqual(['offline rewrite must fail safely']);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OLLAMA_HOST;
    }
  });

  test('local_llm rewrite falls back to original query on non-200 responses', async () => {
    process.env.MBRAIN_LOCAL_LLM_URL = 'http://127.0.0.1:4010/rewrite';

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async () => new Response('upstream unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const { expandQuery } = await import('../src/core/search/expansion.ts');
      const result = await expandQuery('offline rewrite keeps original terms', {
        config: {
          engine: 'sqlite',
          database_path: dbPath,
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'local_llm',
        },
      });

      expect(result).toEqual(['offline rewrite keeps original terms']);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.MBRAIN_LOCAL_LLM_URL;
    }
  });

  test('check-update skips remote checks when offline is enabled', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: dbPath,
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async () => new Response('{}'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const capture = captureConsole();

    try {
      const { runCheckUpdate } = await import('../src/commands/check-update.ts');
      await runCheckUpdate(['--json']);
    } finally {
      globalThis.fetch = originalFetch;
      capture.restore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    const output = JSON.parse(capture.logs.join('\n'));
    expect(output.update_available).toBe(false);
    expect(output.error).toBe('offline_mode');
    expect(output.reason).toMatch(/offline/i);
  });

  test('check-update skips remote checks for pglite local-path execution', async () => {
    writeUserConfig({
      engine: 'pglite',
      database_path: join(tempDir, 'brain.pglite'),
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async () => new Response('{}'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const capture = captureConsole();

    try {
      const { runCheckUpdate } = await import('../src/commands/check-update.ts');
      await runCheckUpdate(['--json']);
    } finally {
      globalThis.fetch = originalFetch;
      capture.restore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    const output = JSON.parse(capture.logs.join('\n'));
    expect(output.update_available).toBe(false);
    expect(output.error).toBe('offline_mode');
    expect(output.reason).toMatch(/check-update/i);
    expect(output.reason).toMatch(/local\/offline|pglite/i);
  });

  test('files commands explain that local/offline mode does not support file storage yet', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: dbPath,
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    const capture = captureConsole();

    try {
      const { runFiles } = await import('../src/commands/files.ts');
      await runFiles(engine, ['list']);
    } finally {
      capture.restore();
    }

    expect(capture.exitSpy).toHaveBeenCalledWith(1);
    expect(capture.errors.join('\n')).toMatch(/files\/storage commands/i);
    expect(capture.errors.join('\n')).toMatch(/offline|sqlite\/local mode/i);
  });

  test('files commands reject pglite local-path execution before touching raw Postgres access', async () => {
    writeUserConfig({
      engine: 'pglite',
      database_path: join(tempDir, 'brain.pglite'),
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    const capture = captureConsole();

    try {
      const { runFiles } = await import('../src/commands/files.ts');
      await runFiles(engine, ['list']);
    } finally {
      capture.restore();
    }

    expect(capture.exitSpy).toHaveBeenCalledWith(1);
    expect(capture.errors.join('\n')).toMatch(/files\/storage commands/i);
    expect(capture.errors.join('\n')).toMatch(/pglite|local mode/i);
  });
});

describe('local/offline embedding flow', () => {
  test('embedding provider none stays unavailable even if OPENAI_API_KEY is set', () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      const provider = getEmbeddingProvider({
        config: {
          engine: 'postgres',
          database_url: 'postgres://example',
          offline: false,
          embedding_provider: 'none',
          query_rewrite_provider: 'none',
        },
      });

      expect(provider.capability.available).toBe(false);
      expect(provider.capability.mode).toBe('none');
      expect(provider.capability.implementation).toBe('none');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  test('local provider auto-detects the default Ollama endpoint when env vars are unset', async () => {
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousLocalUrl = process.env.MBRAIN_LOCAL_EMBEDDING_URL;
    const previousOllama = process.env.OLLAMA_HOST;
    const previousModel = process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;
    const previousDimensions = process.env.MBRAIN_LOCAL_EMBEDDING_DIMENSIONS;

    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.MBRAIN_LOCAL_EMBEDDING_URL;
    delete process.env.OLLAMA_HOST;
    delete process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;
    delete process.env.MBRAIN_LOCAL_EMBEDDING_DIMENSIONS;

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:11434/api/embed');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
        model: 'nomic-embed-text',
        input: ['hello from default ollama'],
      });

      return new Response(JSON.stringify({
        embeddings: [[1, 2, 3]],
      }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const provider = getEmbeddingProvider({
        config: {
          engine: 'sqlite',
          database_path: join(tempDir, 'brain.db'),
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'heuristic',
        },
      });

      expect(provider.capability.available).toBe(true);
      expect(provider.capability.mode).toBe('local');
      expect(provider.capability.implementation).toBe('local-http');
      expect(provider.capability.model).toBe('nomic-embed-text');
      expect(provider.capability.dimensions).toBeNull();

      const embeddings = await provider.embedBatch(['hello from default ollama']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(Array.from(embeddings[0] ?? [])).toEqual([1, 2, 3]);
    } finally {
      globalThis.fetch = originalFetch;

      if (previousOpenAI === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAI;
      }

      if (previousLocalUrl === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_URL;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_URL = previousLocalUrl;
      }

      if (previousOllama === undefined) {
        delete process.env.OLLAMA_HOST;
      } else {
        process.env.OLLAMA_HOST = previousOllama;
      }

      if (previousModel === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_MODEL = previousModel;
      }

      if (previousDimensions === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_DIMENSIONS;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_DIMENSIONS = previousDimensions;
      }
    }
  });

  test('local provider prefers config embedding_model when env vars are unset', async () => {
    const previousLocalUrl = process.env.MBRAIN_LOCAL_EMBEDDING_URL;
    const previousOllama = process.env.OLLAMA_HOST;
    const previousModel = process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;

    delete process.env.MBRAIN_LOCAL_EMBEDDING_URL;
    delete process.env.OLLAMA_HOST;
    delete process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
        model: 'custom-bge-profile',
        input: ['config-driven model'],
      });

      return new Response(JSON.stringify({
        embeddings: [[4, 5, 6]],
      }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const provider = getEmbeddingProvider({
        config: {
          engine: 'sqlite',
          database_path: join(tempDir, 'brain.db'),
          offline: true,
          embedding_provider: 'local',
          embedding_model: 'custom-bge-profile',
          query_rewrite_provider: 'heuristic',
        },
      });

      expect(provider.capability.model).toBe('custom-bge-profile');
      const embeddings = await provider.embedBatch(['config-driven model']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(Array.from(embeddings[0] ?? [])).toEqual([4, 5, 6]);
    } finally {
      globalThis.fetch = originalFetch;

      if (previousLocalUrl === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_URL;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_URL = previousLocalUrl;
      }

      if (previousOllama === undefined) {
        delete process.env.OLLAMA_HOST;
      } else {
        process.env.OLLAMA_HOST = previousOllama;
      }

      if (previousModel === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_MODEL = previousModel;
      }
    }
  });

  test('local provider times out slow embedding requests with diagnostics', async () => {
    const previousLocalUrl = process.env.MBRAIN_LOCAL_EMBEDDING_URL;
    const previousModel = process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;
    const previousTimeout = process.env.MBRAIN_EMBED_TIMEOUT_MS;

    process.env.MBRAIN_LOCAL_EMBEDDING_URL = 'http://127.0.0.1:4010/embed';
    process.env.MBRAIN_LOCAL_EMBEDDING_MODEL = 'slow-test-model';
    process.env.MBRAIN_EMBED_TIMEOUT_MS = '1';

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error('missing abort signal');
      }

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const provider = getEmbeddingProvider({
        config: {
          engine: 'sqlite',
          database_path: join(tempDir, 'brain.db'),
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'heuristic',
        },
      });

      await expect(provider.embedBatch(['slow text'])).rejects.toThrow(
        /Local embedding runtime timed out after 1ms.*slow-test-model.*batch size 1.*MBRAIN_EMBED_TIMEOUT_MS/s,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;

      if (previousLocalUrl === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_URL;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_URL = previousLocalUrl;
      }

      if (previousModel === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_MODEL = previousModel;
      }

      if (previousTimeout === undefined) {
        delete process.env.MBRAIN_EMBED_TIMEOUT_MS;
      } else {
        process.env.MBRAIN_EMBED_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  test('local provider timeout covers stalled response body reads', async () => {
    const previousLocalUrl = process.env.MBRAIN_LOCAL_EMBEDDING_URL;
    const previousModel = process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;
    const previousTimeout = process.env.MBRAIN_EMBED_TIMEOUT_MS;

    process.env.MBRAIN_LOCAL_EMBEDDING_URL = 'http://127.0.0.1:4010/embed';
    process.env.MBRAIN_LOCAL_EMBEDDING_MODEL = 'slow-body-model';
    process.env.MBRAIN_EMBED_TIMEOUT_MS = '1';

    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error('missing abort signal');
      }

      return {
        ok: true,
        json: async () => new Promise((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error('body read was not aborted')), 20);
          signal.addEventListener('abort', () => {
            clearTimeout(fallback);
            const error = new Error('aborted while reading body');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      } as Response;
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const provider = getEmbeddingProvider({
        config: {
          engine: 'sqlite',
          database_path: join(tempDir, 'brain.db'),
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'heuristic',
        },
      });

      await expect(provider.embedBatch(['slow body'])).rejects.toThrow(
        /Local embedding runtime timed out after 1ms.*slow-body-model.*batch size 1.*MBRAIN_EMBED_TIMEOUT_MS/s,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;

      if (previousLocalUrl === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_URL;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_URL = previousLocalUrl;
      }

      if (previousModel === undefined) {
        delete process.env.MBRAIN_LOCAL_EMBEDDING_MODEL;
      } else {
        process.env.MBRAIN_LOCAL_EMBEDDING_MODEL = previousModel;
      }

      if (previousTimeout === undefined) {
        delete process.env.MBRAIN_EMBED_TIMEOUT_MS;
      } else {
        process.env.MBRAIN_EMBED_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  test('embedChunks prefixes nomic documents for retrieval tasks', async () => {
    const provider = createCapturingProvider('nomic-embed-text');

    await embedChunks([{
      chunk_index: 0,
      chunk_text: 'document body',
      chunk_source: 'compiled_truth',
    }], { provider: provider.provider });

    expect(provider.batches).toEqual([['search_document: document body']]);
  });

  test('embedChunks leaves non-nomic document text unchanged', async () => {
    const provider = createCapturingProvider('bge-m3');

    await embedChunks([{
      chunk_index: 0,
      chunk_text: 'document body',
      chunk_source: 'compiled_truth',
    }], { provider: provider.provider });

    expect(provider.batches).toEqual([['document body']]);
  });

  test('deferred re-import marks rewritten chunks as missing embeddings', async () => {
    const firstProvider = createFakeProvider();
    setEmbeddingProviderForTests(firstProvider.provider);

    const filePath = join(tempDir, 'rewritten.md');
    writeFileSync(filePath, `---
type: concept
title: Rewritten
---

Original chunk content for the page.
`);

    await importFile(engine, filePath, 'concepts/rewritten.md');
    await runEmbed(engine, ['concepts/rewritten']);

    const embeddedBeforeRewrite = await engine.getChunks('concepts/rewritten');
    expect(embeddedBeforeRewrite.every(chunk => chunk.embedded_at instanceof Date)).toBe(true);
    expect(await engine.getPageEmbeddings('concept')).toContainEqual({
      page_id: expect.any(Number),
      slug: 'concepts/rewritten',
      embedding: new Float32Array([embeddedBeforeRewrite[0]!.chunk_text.length, 1, 1]),
    });

    writeFileSync(filePath, `---
type: concept
title: Rewritten
---

Updated chunk content for the same page.
`);

    const secondImport = await importFile(engine, filePath, 'concepts/rewritten.md');
    expect(secondImport.status).toBe('imported');

    const chunksAfterRewrite = await engine.getChunks('concepts/rewritten');
    expect(chunksAfterRewrite).toHaveLength(1);
    expect(chunksAfterRewrite[0].chunk_text).toContain('Updated chunk content');
    expect(chunksAfterRewrite[0].embedded_at).toBeNull();
    expect(chunksAfterRewrite[0].model).toBe('nomic-embed-text');
    expect(await engine.getPageEmbeddings('concept')).toContainEqual({
      page_id: expect.any(Number),
      slug: 'concepts/rewritten',
      embedding: null,
    });
  });

  test('stale-only embedding repairs stale chunk layouts before embedding missing chunks', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);

    await engine.putPage('concepts/stale-only', {
      type: 'concept',
      title: 'Stale Only',
      compiled_truth: 'already embedded\nneeds embedding',
      timeline: 'still missing',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/stale-only', [
      {
        chunk_index: 0,
        chunk_text: 'already embedded',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([9, 9, 9]),
        model: 'seed-model',
        token_count: 3,
      },
      {
        chunk_index: 1,
        chunk_text: 'needs embedding',
        chunk_source: 'compiled_truth',
      },
      {
        chunk_index: 2,
        chunk_text: 'still missing',
        chunk_source: 'timeline',
      },
    ]);

    await runEmbed(engine, ['--stale']);

    expect(fake.batches).toEqual([['already embedded\nneeds embedding', 'still missing']]);

    const after = await engine.getChunks('concepts/stale-only');
    expect(after).toHaveLength(2);
    expect(after[0].chunk_text).toBe('already embedded\nneeds embedding');
    expect(after[0].model).toBe('test-local-v1');
    expect(after[0].embedded_at).toBeInstanceOf(Date);
    expect(after[1].embedded_at).toBeInstanceOf(Date);
    expect(after[1].model).toBe('test-local-v1');
    expect(after[1].chunk_text).toBe('still missing');
  });

  test('stale-only embedding backfills missing frontmatter chunks for existing pages', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);

    await engine.putPage('systems/llvm', {
      type: 'system',
      title: 'LLVM',
      compiled_truth: 'Compiler infrastructure overview.',
      timeline: '',
      frontmatter: {
        codemap: [
          {
            system: 'systems/llvm',
            pointers: [
              {
                path: 'llvm/lib/Passes/PassBuilder.cpp',
                symbol: 'PassBuilder::buildPerModuleDefaultPipeline()',
                role: 'Builds the default optimization pipeline',
                verified_at: '2026-04-15',
              },
            ],
          },
        ],
      },
    });
    await engine.upsertChunks('systems/llvm', [
      {
        chunk_index: 0,
        chunk_text: 'Compiler infrastructure overview.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 2, 3]),
        model: 'test-local-v1',
        token_count: 3,
      },
    ]);

    await runEmbed(engine, ['--stale']);

    const after = await engine.getChunks('systems/llvm');
    expect(after).toHaveLength(2);
    expect(after[0]?.chunk_source).toBe('compiled_truth');
    expect(after[0]?.embedded_at).toBeInstanceOf(Date);
    expect(after[1]?.chunk_source).toBe('frontmatter');
    expect(after[1]?.chunk_text).toContain('PassBuilder::buildPerModuleDefaultPipeline()');
    expect(after[1]?.embedded_at).toBeInstanceOf(Date);
  });

  test('stale-only embedding removes obsolete frontmatter chunks after codemap deletion', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);

    await engine.putPage('systems/llvm', {
      type: 'system',
      title: 'LLVM',
      compiled_truth: 'Compiler infrastructure overview.',
      timeline: '',
      frontmatter: {
        codemap: [
          {
            system: 'systems/llvm',
            pointers: [
              {
                path: 'llvm/lib/Passes/PassBuilder.cpp',
                symbol: 'PassBuilder::buildPerModuleDefaultPipeline()',
                role: 'Builds the default optimization pipeline',
                verified_at: '2026-04-15',
              },
            ],
          },
        ],
      },
    });
    await engine.upsertChunks('systems/llvm', [
      {
        chunk_index: 0,
        chunk_text: 'Compiler infrastructure overview.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 2, 3]),
        model: 'test-local-v1',
        token_count: 3,
      },
      {
        chunk_index: 1,
        chunk_text: 'pointer llvm/lib/Passes/PassBuilder.cpp PassBuilder::buildPerModuleDefaultPipeline()',
        chunk_source: 'frontmatter',
        embedding: new Float32Array([4, 5, 6]),
        model: 'test-local-v1',
        token_count: 6,
      },
    ]);

    await engine.putPage('systems/llvm', {
      type: 'system',
      title: 'LLVM',
      compiled_truth: 'Compiler infrastructure overview.',
      timeline: '',
      frontmatter: {},
    });

    await runEmbed(engine, ['--stale']);

    const after = await engine.getChunks('systems/llvm');
    expect(after).toHaveLength(1);
    expect(after[0]?.chunk_source).toBe('compiled_truth');
    expect(after[0]?.chunk_text).toBe('Compiler infrastructure overview.');
  });

  test('stale-only embedding accepts shared boolean normalization forms', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const capture = captureConsole();

    try {
      await engine.putPage('concepts/stale-bool', {
        type: 'concept',
        title: 'Stale Bool',
        compiled_truth: 'already embedded\nneeds embedding',
        timeline: '',
        frontmatter: {},
      });
      await engine.upsertChunks('concepts/stale-bool', [
        {
          chunk_index: 0,
          chunk_text: 'already embedded',
          chunk_source: 'compiled_truth',
          embedding: new Float32Array([9, 9, 9]),
          model: 'seed-model',
          token_count: 3,
        },
        {
          chunk_index: 1,
          chunk_text: 'needs embedding',
          chunk_source: 'compiled_truth',
        },
      ]);

      await runEmbed(engine, ['--stale=true']);
    } finally {
      capture.restore();
    }

    expect(capture.exitSpy).not.toHaveBeenCalled();
    expect(fake.batches).toEqual([['already embedded\nneeds embedding']]);
    const after = await engine.getChunks('concepts/stale-bool');
    expect(after).toHaveLength(1);
    expect(after[0]?.embedded_at).toBeInstanceOf(Date);
    expect(after[0]?.model).toBe('test-local-v1');
  });

  test('stale-only embedding reports the active page and provider batch progress', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);
    const capture = captureConsole();
    const compiledTruth = Array.from({ length: 60_000 }, (_, index) => `word${index}`).join(' ');
    const expectedChunks = buildPageChunks(compiledTruth, '', {});
    const expectedBatchCount = Math.ceil(expectedChunks.length / 100);

    try {
      await engine.putPage('concepts/large-progress', {
        type: 'concept',
        title: 'Large Progress',
        compiled_truth: compiledTruth,
        timeline: '',
        frontmatter: {},
      });

      await runEmbed(engine, ['--stale']);
    } finally {
      capture.restore();
    }

    expect(expectedChunks.length).toBeGreaterThan(100);
    const output = [...capture.logs, ...capture.stdout].join('\n');
    expect(output).toContain(`Embedding 1/1 concepts/large-progress: ${expectedChunks.length} chunks`);
    expect(output).toContain(`batch 1/${expectedBatchCount}, 100/${expectedChunks.length} chunks`);
    expect(output).toContain(`batch ${expectedBatchCount}/${expectedBatchCount}, ${expectedChunks.length}/${expectedChunks.length} chunks`);
    expect(output).toContain(`1/1 pages, ${expectedChunks.length} chunks embedded`);
  });

  test('unchanged content does not trigger re-embedding', async () => {
    const fake = createFakeProvider();
    setEmbeddingProviderForTests(fake.provider);

    const filePath = join(tempDir, 'unchanged.md');
    writeFileSync(filePath, `---
type: concept
title: Unchanged
---

This page should only be embedded during explicit backfill.
`);

    const first = await importFile(engine, filePath, 'concepts/unchanged.md');
    expect(first.status).toBe('imported');
    expect(fake.batches).toEqual([]);

    await runEmbed(engine, ['concepts/unchanged']);
    expect(fake.batches).toHaveLength(1);

    const before = await engine.getChunks('concepts/unchanged');
    const second = await importFile(engine, filePath, 'concepts/unchanged.md');
    const after = await engine.getChunks('concepts/unchanged');

    expect(second.status).toBe('skipped');
    expect(fake.batches).toHaveLength(1);
    expect(after.map(chunk => chunk.model)).toEqual(before.map(chunk => chunk.model));
    expect(after.map(chunk => chunk.embedded_at?.toISOString())).toEqual(
      before.map(chunk => chunk.embedded_at?.toISOString()),
    );
  });

  test('page-level explicit embed rebuilds already-embedded chunks', async () => {
    const firstProvider = createFakeProvider();
    setEmbeddingProviderForTests(firstProvider.provider);

    const filePath = join(tempDir, 'page-rebuild.md');
    writeFileSync(filePath, `---
type: concept
title: Page Rebuild
---

First chunk sentence.

---

Timeline sentence.
`);

    await importFile(engine, filePath, 'concepts/page-rebuild.md');
    await runEmbed(engine, ['concepts/page-rebuild']);

    const initialChunks = await engine.getChunks('concepts/page-rebuild');
    expect(initialChunks.every(chunk => chunk.model === 'test-local-v1')).toBe(true);

    const rebuildBatches: string[][] = [];
    setEmbeddingProviderForTests({
      capability: {
        available: true,
        mode: 'local',
        implementation: 'test-local' as const,
        model: 'test-local-v2',
        dimensions: 3,
      },
      embedBatch: async (texts: string[]) => {
        rebuildBatches.push([...texts]);
        return texts.map((text, index) => new Float32Array([text.length, index + 10, 2]));
      },
    });

    await runEmbed(engine, ['concepts/page-rebuild']);

    expect(rebuildBatches).toEqual([initialChunks.map(chunk => chunk.chunk_text)]);

    const rebuiltChunks = await engine.getChunks('concepts/page-rebuild');
    expect(rebuiltChunks.every(chunk => chunk.model === 'test-local-v2')).toBe(true);
    expect(rebuiltChunks.every(chunk => chunk.embedded_at instanceof Date)).toBe(true);
  });

  test('sqlite local vector search ranks embedded chunks by cosine similarity', async () => {
    await engine.putPage('concepts/vector-top', {
      type: 'concept',
      title: 'Vector Top',
      compiled_truth: 'Highest cosine similarity match.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/vector-top', [
      {
        chunk_index: 0,
        chunk_text: 'Highest cosine similarity match.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0, 0]),
      },
    ]);

    await engine.putPage('concepts/vector-second', {
      type: 'concept',
      title: 'Vector Second',
      compiled_truth: 'Second-best cosine similarity match.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/vector-second', [
      {
        chunk_index: 0,
        chunk_text: 'Second-best cosine similarity match.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.5, 0.5, 0]),
      },
    ]);

    const results = await engine.searchVector(new Float32Array([1, 0, 0]), { limit: 2 });

    expect(results.map(result => result.slug)).toEqual([
      'concepts/vector-top',
      'concepts/vector-second',
    ]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  test('hybrid search falls back to keyword-only when query embeddings are unavailable', async () => {
    setEmbeddingProviderForTests(createUnavailableProvider('offline embedding runtime unavailable'));

    await engine.putPage('concepts/keyword-only', {
      type: 'concept',
      title: 'Keyword Only',
      compiled_truth: 'Offline retrieval fallback keeps keyword search working.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/keyword-only', [
      {
        chunk_index: 0,
        chunk_text: 'Offline retrieval fallback keeps keyword search working.',
        chunk_source: 'compiled_truth',
      },
    ]);

    const keywordResults = await engine.searchKeyword('offline retrieval fallback', { limit: 5 });
    const hybridResults = await hybridSearch(engine, 'offline retrieval fallback', { limit: 5 });

    expect(hybridResults).toEqual(keywordResults);
  });

  test('hybrid search prefixes nomic queries for retrieval tasks', async () => {
    const provider = createCapturingProvider('nomic-embed-text');
    setEmbeddingProviderForTests(provider.provider);

    const mockEngine = {
      searchKeyword: async () => [],
      searchVector: async () => [],
    } as any;

    await hybridSearch(mockEngine, 'who is alice?', { limit: 5 });

    expect(provider.batches).toEqual([['search_query: who is alice?']]);
  });

  test('hybrid search leaves non-nomic queries unchanged', async () => {
    const provider = createCapturingProvider('bge-m3');
    setEmbeddingProviderForTests(provider.provider);

    const mockEngine = {
      searchKeyword: async () => [],
      searchVector: async () => [],
    } as any;

    await hybridSearch(mockEngine, 'who is alice?', { limit: 5 });

    expect(provider.batches).toEqual([['who is alice?']]);
  });

  test('hybrid search fuses vector and keyword rankings when both are available', async () => {
    setEmbeddingProviderForTests(createMappedProvider({
      'hybrid fusion': [1, 0, 0],
    }));

    await engine.putPage('concepts/semantic-match', {
      type: 'project',
      title: 'Semantic Match',
      compiled_truth: 'A concept about dense embeddings and latent neighbors.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/semantic-match', [
      {
        chunk_index: 0,
        chunk_text: 'Dense embedding neighbors line up with the intent.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.92, 0.08, 0]),
      },
    ]);

    await engine.putPage('concepts/overlap-match', {
      type: 'concept',
      title: 'Overlap Match',
      compiled_truth: 'Hybrid fusion keeps exact hybrid fusion phrasing near the top.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/overlap-match', [
      {
        chunk_index: 0,
        chunk_text: 'hybrid fusion stays strong when keyword and vector evidence agree',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0, 0]),
      },
    ]);

    const results = await hybridSearch(engine, 'hybrid fusion', { limit: 5 });

    expect(results[0]?.slug).toBe('concepts/overlap-match');
    expect(results.some(result => result.slug === 'concepts/semantic-match')).toBe(true);
    const semanticResult = results.find(result => result.slug === 'concepts/semantic-match');
    expect(results[0]?.score).toBeGreaterThan(semanticResult?.score ?? 0);
  });

  test('hybrid search fuses available vector results when embedding coverage is partial', async () => {
    setEmbeddingProviderForTests(createMappedProvider({
      'partial coverage': [1, 0, 0],
    }));

    await engine.putPage('concepts/vector-covered', {
      type: 'concept',
      title: 'Vector Covered',
      compiled_truth: 'Semantic chunk without exact query terms.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/vector-covered', [
      {
        chunk_index: 0,
        chunk_text: 'Nearest-neighbor recall from the local vector store.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0, 0]),
      },
    ]);

    await engine.putPage('concepts/keyword-only-partial', {
      type: 'concept',
      title: 'Keyword Only Partial',
      compiled_truth: 'partial coverage must still surface keyword hits without stored embeddings.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/keyword-only-partial', [
      {
        chunk_index: 0,
        chunk_text: 'partial coverage must still surface keyword hits without stored embeddings.',
        chunk_source: 'compiled_truth',
      },
    ]);

    const results = await hybridSearch(engine, 'partial coverage', { limit: 5 });

    expect(results.map(result => result.slug)).toEqual([
      'concepts/vector-covered',
      'concepts/keyword-only-partial',
    ]);
    expect(results[1]?.chunk_text).toContain('partial coverage');
  });

  test('hybrid search keeps successful vector variants when one expanded query embedding fails', async () => {
    setEmbeddingProviderForTests(createMappedProvider({
      'hybrid fusion': [1, 0, 0],
    }));

    await engine.putPage('concepts/semantic-resilient', {
      type: 'project',
      title: 'Semantic Resilient',
      compiled_truth: 'Semantic result should survive one failed expansion embedding.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/semantic-resilient', [
      {
        chunk_index: 0,
        chunk_text: 'Dense vector recall survives per-query embedding failures.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0, 0]),
      },
    ]);

    await engine.putPage('concepts/keyword-resilient', {
      type: 'concept',
      title: 'Keyword Resilient',
      compiled_truth: 'hybrid fusion remains available through keyword search.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/keyword-resilient', [
      {
        chunk_index: 0,
        chunk_text: 'hybrid fusion remains available through keyword search.',
        chunk_source: 'compiled_truth',
      },
    ]);

    const results = await hybridSearch(engine, 'hybrid fusion', {
      limit: 5,
      expansion: true,
      expandFn: async () => ['missing expansion'],
    });

    expect(results.some(result => result.slug === 'concepts/semantic-resilient')).toBe(true);
    expect(results.some(result => result.slug === 'concepts/keyword-resilient')).toBe(true);
  });

  test('hybrid search keeps successful vector variants when one vector search path fails', async () => {
    setEmbeddingProviderForTests(createMappedProvider({
      'hybrid vector resilience': [1, 0, 0],
      'related expansion': [0, 1, 0],
    }));

    await engine.putPage('concepts/vector-resilient', {
      type: 'project',
      title: 'Vector Resilient',
      compiled_truth: 'A successful vector search path should still contribute.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/vector-resilient', [
      {
        chunk_index: 0,
        chunk_text: 'Successful vector retrieval survives sibling failures.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0, 0]),
      },
    ]);

    await engine.putPage('concepts/keyword-vector-resilient', {
      type: 'concept',
      title: 'Keyword Vector Resilient',
      compiled_truth: 'hybrid vector resilience also remains available through keyword search.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('concepts/keyword-vector-resilient', [
      {
        chunk_index: 0,
        chunk_text: 'hybrid vector resilience also remains available through keyword search.',
        chunk_source: 'compiled_truth',
      },
    ]);

    const originalSearchVector = engine.searchVector.bind(engine);
    engine.searchVector = async (embedding, opts) => {
      if (embedding[1] === 1) {
        throw new Error('simulated vector path failure');
      }
      return originalSearchVector(embedding, opts);
    };

    try {
      const results = await hybridSearch(engine, 'hybrid vector resilience', {
        limit: 5,
        expansion: true,
        expandFn: async () => ['related expansion'],
      });

      expect(results.some(result => result.slug === 'concepts/vector-resilient')).toBe(true);
      expect(results.some(result => result.slug === 'concepts/keyword-vector-resilient')).toBe(true);
    } finally {
      engine.searchVector = originalSearchVector;
    }
  });
});
