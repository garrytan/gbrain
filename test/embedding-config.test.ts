import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  getEmbeddingConfig,
  resetEmbeddingConfigCache,
  EMBEDDING_DEFAULTS,
} from '../src/core/embedding-config.ts';

const ENV_KEYS = [
  'GBRAIN_EMBED_MODEL',
  'GBRAIN_EMBED_DIMENSIONS',
  'GBRAIN_EMBED_COST_PER_1K',
  'GBRAIN_EMBED_URL',
  'GBRAIN_EMBED_KEY',
  'GBRAIN_EMBED_BATCH',
  'GBRAIN_EMBED_MAX_CHARS',
];

const originals: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) originals[k] = process.env[k];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetEmbeddingConfigCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    delete process.env[k];
    if (originals[k] !== undefined) process.env[k] = originals[k]!;
  }
  resetEmbeddingConfigCache();
});

describe('getEmbeddingConfig — defaults', () => {
  test('all-unset returns historical defaults', () => {
    const cfg = getEmbeddingConfig();
    expect(cfg.model).toBe('text-embedding-3-large');
    expect(cfg.dimensions).toBe(1536);
    expect(cfg.costPer1kTokens).toBe(0.00013);
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.batchSize).toBe(100);
    expect(cfg.maxChars).toBe(8000);
  });

  test('EMBEDDING_DEFAULTS is frozen', () => {
    expect(Object.isFrozen(EMBEDDING_DEFAULTS)).toBe(true);
  });

  test('EMBEDDING_DEFAULTS matches initial config', () => {
    const cfg = getEmbeddingConfig();
    expect(cfg.model).toBe(EMBEDDING_DEFAULTS.model);
    expect(cfg.dimensions).toBe(EMBEDDING_DEFAULTS.dimensions);
    expect(cfg.costPer1kTokens).toBe(EMBEDDING_DEFAULTS.costPer1kTokens);
  });
});

describe('getEmbeddingConfig — model parsing', () => {
  test('reads valid OpenAI-style model', () => {
    process.env.GBRAIN_EMBED_MODEL = 'text-embedding-3-small';
    expect(getEmbeddingConfig().model).toBe('text-embedding-3-small');
  });

  test('reads Ollama-style tagged model', () => {
    process.env.GBRAIN_EMBED_MODEL = 'nomic-embed-text:latest';
    expect(getEmbeddingConfig().model).toBe('nomic-embed-text:latest');
  });

  test('reads HuggingFace org/model', () => {
    process.env.GBRAIN_EMBED_MODEL = 'BAAI/bge-large-en';
    expect(getEmbeddingConfig().model).toBe('BAAI/bge-large-en');
  });

  test('rejects model with spaces', () => {
    process.env.GBRAIN_EMBED_MODEL = 'bad model';
    expect(getEmbeddingConfig().model).toBe('text-embedding-3-large');
  });

  test('rejects model with shell metacharacters', () => {
    process.env.GBRAIN_EMBED_MODEL = 'model; rm -rf /';
    expect(getEmbeddingConfig().model).toBe('text-embedding-3-large');
  });

  test('empty string falls back to default', () => {
    process.env.GBRAIN_EMBED_MODEL = '';
    expect(getEmbeddingConfig().model).toBe('text-embedding-3-large');
  });
});

describe('getEmbeddingConfig — dimensions parsing', () => {
  test('reads valid dimensions', () => {
    process.env.GBRAIN_EMBED_DIMENSIONS = '768';
    expect(getEmbeddingConfig().dimensions).toBe(768);
  });

  test('reads large dimensions (Mistral, Cohere v3)', () => {
    process.env.GBRAIN_EMBED_DIMENSIONS = '4096';
    expect(getEmbeddingConfig().dimensions).toBe(4096);
  });

  test('rejects non-integer', () => {
    process.env.GBRAIN_EMBED_DIMENSIONS = 'not-a-number';
    expect(getEmbeddingConfig().dimensions).toBe(1536);
  });

  test('rejects negative', () => {
    process.env.GBRAIN_EMBED_DIMENSIONS = '-100';
    expect(getEmbeddingConfig().dimensions).toBe(1536);
  });

  test('rejects zero', () => {
    process.env.GBRAIN_EMBED_DIMENSIONS = '0';
    expect(getEmbeddingConfig().dimensions).toBe(1536);
  });

  test('rejects above pgvector hnsw limit (16384)', () => {
    process.env.GBRAIN_EMBED_DIMENSIONS = '99999';
    expect(getEmbeddingConfig().dimensions).toBe(1536);
  });
});

describe('getEmbeddingConfig — cost parsing', () => {
  test('reads zero cost (local model)', () => {
    process.env.GBRAIN_EMBED_COST_PER_1K = '0';
    expect(getEmbeddingConfig().costPer1kTokens).toBe(0);
  });

  test('reads decimal cost', () => {
    process.env.GBRAIN_EMBED_COST_PER_1K = '0.00002';
    expect(getEmbeddingConfig().costPer1kTokens).toBe(0.00002);
  });

  test('reads scientific notation', () => {
    process.env.GBRAIN_EMBED_COST_PER_1K = '1.3e-4';
    expect(getEmbeddingConfig().costPer1kTokens).toBe(0.00013);
  });

  test('rejects non-numeric', () => {
    process.env.GBRAIN_EMBED_COST_PER_1K = 'free';
    expect(getEmbeddingConfig().costPer1kTokens).toBe(0.00013);
  });

  test('rejects negative cost', () => {
    process.env.GBRAIN_EMBED_COST_PER_1K = '-1';
    expect(getEmbeddingConfig().costPer1kTokens).toBe(0.00013);
  });
});

describe('getEmbeddingConfig — URL parsing', () => {
  test('reads localhost Ollama URL', () => {
    process.env.GBRAIN_EMBED_URL = 'http://localhost:11434/v1';
    expect(getEmbeddingConfig().baseUrl).toBe('http://localhost:11434/v1');
  });

  test('reads HTTPS URL', () => {
    process.env.GBRAIN_EMBED_URL = 'https://api.together.xyz/v1';
    expect(getEmbeddingConfig().baseUrl).toBe('https://api.together.xyz/v1');
  });

  test('rejects non-URL string', () => {
    process.env.GBRAIN_EMBED_URL = 'localhost:11434';
    expect(getEmbeddingConfig().baseUrl).toBeUndefined();
  });

  test('rejects file:// scheme', () => {
    process.env.GBRAIN_EMBED_URL = 'file:///etc/passwd';
    expect(getEmbeddingConfig().baseUrl).toBeUndefined();
  });

  test('rejects javascript:// scheme', () => {
    process.env.GBRAIN_EMBED_URL = 'javascript:alert(1)';
    expect(getEmbeddingConfig().baseUrl).toBeUndefined();
  });

  test('empty string returns undefined', () => {
    process.env.GBRAIN_EMBED_URL = '';
    expect(getEmbeddingConfig().baseUrl).toBeUndefined();
  });
});

describe('getEmbeddingConfig — API key', () => {
  test('reads custom key', () => {
    process.env.GBRAIN_EMBED_KEY = 'sk-local-abc123';
    expect(getEmbeddingConfig().apiKey).toBe('sk-local-abc123');
  });

  test('empty string returns undefined (falls back to OPENAI_API_KEY)', () => {
    process.env.GBRAIN_EMBED_KEY = '';
    expect(getEmbeddingConfig().apiKey).toBeUndefined();
  });

  test('whitespace-only returns undefined', () => {
    process.env.GBRAIN_EMBED_KEY = '   ';
    expect(getEmbeddingConfig().apiKey).toBeUndefined();
  });
});

describe('getEmbeddingConfig — batch size', () => {
  test('reads valid batch size', () => {
    process.env.GBRAIN_EMBED_BATCH = '50';
    expect(getEmbeddingConfig().batchSize).toBe(50);
  });

  test('rejects above ceiling (2048)', () => {
    process.env.GBRAIN_EMBED_BATCH = '99999';
    expect(getEmbeddingConfig().batchSize).toBe(100);
  });

  test('rejects zero', () => {
    process.env.GBRAIN_EMBED_BATCH = '0';
    expect(getEmbeddingConfig().batchSize).toBe(100);
  });
});

describe('getEmbeddingConfig — caching', () => {
  test('caches first read', () => {
    process.env.GBRAIN_EMBED_MODEL = 'first';
    expect(getEmbeddingConfig().model).toBe('first');

    process.env.GBRAIN_EMBED_MODEL = 'second';
    expect(getEmbeddingConfig().model).toBe('first'); // cached
  });

  test('resetEmbeddingConfigCache clears cache', () => {
    process.env.GBRAIN_EMBED_MODEL = 'first';
    expect(getEmbeddingConfig().model).toBe('first');

    resetEmbeddingConfigCache();
    process.env.GBRAIN_EMBED_MODEL = 'second';
    expect(getEmbeddingConfig().model).toBe('second');
  });
});

describe('getEmbeddingConfig — full local-model scenario', () => {
  test('Ollama-style configuration', () => {
    process.env.GBRAIN_EMBED_URL = 'http://localhost:11434/v1';
    process.env.GBRAIN_EMBED_MODEL = 'nomic-embed-text';
    process.env.GBRAIN_EMBED_DIMENSIONS = '768';
    process.env.GBRAIN_EMBED_KEY = 'ollama';
    process.env.GBRAIN_EMBED_COST_PER_1K = '0';

    const cfg = getEmbeddingConfig();
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.model).toBe('nomic-embed-text');
    expect(cfg.dimensions).toBe(768);
    expect(cfg.apiKey).toBe('ollama');
    expect(cfg.costPer1kTokens).toBe(0);
  });
});
