/**
 * #5691 / #3783: `embedding_query_prefix` is an opt-in, per-brain query
 * instruction for instruction-style embedding models. Search reads it once per
 * request from the selected brain's config and prepends the exact bytes to the
 * query embedding only; documents and keyword search never see it, it takes
 * effect on the next query without a restart, it keys the query cache, and
 * doctor suggests (never applies) the documented value for known families.
 *
 * PGLite in-memory; the embedding transport is stubbed ($0).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, embed, embedQuery, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { hybridSearchCached } from '../src/core/search/hybrid.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';
import { loadEmbeddingQueryPrefix, shellQuoteConfigValue, suggestedQueryPrefix } from '../src/core/search/query-prefix.ts';
import { embeddingQueryPrefixEntry } from '../src/commands/doctor/checks/embedding-health.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

const QWEN = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';
let brainA: PGLiteEngine;
let brainB: PGLiteEngine;
let seen: string[] = [];

function configureEmbedding(model = 'openai:text-embedding-3-large'): void {
  configureGateway({ embedding_model: model, embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
  __setEmbedTransportForTests((async (args: { values: string[] }) => {
    seen.push(...args.values);
    return { embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)) };
  }) as never);
}

beforeAll(async () => {
  brainA = new PGLiteEngine(); await brainA.connect({}); await brainA.initSchema();
  brainB = new PGLiteEngine(); await brainB.connect({}); await brainB.initSchema();
  for (const engine of [brainA, brainB]) {
    await importFromContent(engine, 'notes/widget-roadmap',
      '---\ntype: note\ntitle: Widget roadmap\n---\n\nThe widget roadmap covers the next release.\n', { noEmbed: true });
  }
}, 60_000);

afterAll(async () => {
  await brainA?.disconnect();
  await brainB?.disconnect();
}, 60_000);

afterEach(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  seen = [];
  for (const engine of [brainA, brainB]) await engine.unsetConfig('embedding_query_prefix');
});

describe('embedQuery', () => {
  test('prepends the given prefix to the query only; documents stay bare', async () => {
    configureEmbedding();
    await embedQuery('what did alice promise?', { queryPrefix: `${QWEN}` });
    await embed(['a stored document']);
    expect(seen).toEqual([`${QWEN}what did alice promise?`, 'a stored document']);
  });

  test('no prefix embeds the bare query', async () => {
    configureEmbedding();
    await embedQuery('bare query');
    expect(seen).toEqual(['bare query']);
  });
});

describe('search reads the selected brain prefix per request', () => {
  test('two brains in one MCP process use their own prefixes, with exact bytes', async () => {
    configureEmbedding();
    await brainA.setConfig('embedding_query_prefix', 'query: ');
    await brainB.setConfig('embedding_query_prefix', 'search_query: \n');
    for (const engine of [brainA, brainB]) {
      const result = await dispatchToolCall(engine, 'query', { query: 'widget roadmap', expand: false }, { remote: true, sourceId: 'default' });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    }
    expect(seen).toContain('query: widget roadmap');
    expect(seen).toContain('search_query: \nwidget roadmap');
    expect(seen.every(v => v.endsWith('widget roadmap'))).toBe(true);
  });

  test('a set takes effect on the next query and unset restores the bare query, without a restart', async () => {
    configureEmbedding();
    await hybridSearchCached(brainA, 'widget roadmap');
    await brainA.setConfig('embedding_query_prefix', 'query: ');
    await hybridSearchCached(brainA, 'widget roadmap');
    await brainA.unsetConfig('embedding_query_prefix');
    await hybridSearchCached(brainA, 'widget roadmap');
    expect(seen).toEqual(['widget roadmap', 'query: widget roadmap', 'widget roadmap']);
  });

  test('keyword search uses the original query', async () => {
    await brainA.setConfig('embedding_query_prefix', 'query: ');
    const results = await hybridSearchCached(brainA, 'widget roadmap');
    expect(results.map(r => r.slug)).toContain('notes/widget-roadmap');
  });
});

describe('query-cache key', () => {
  test('a prefix changes the key; unset returns to the unprefixed key', () => {
    const knobs = resolveSearchMode({});
    const bare = knobsHash(knobs, { embeddingColumn: 'embedding' });
    const prefixed = knobsHash(knobs, { embeddingColumn: 'embedding', queryPrefix: 'query: ' });
    const trailing = knobsHash(knobs, { embeddingColumn: 'embedding', queryPrefix: 'query:' });
    expect(prefixed).not.toBe(bare);
    expect(trailing).not.toBe(prefixed);
    expect(knobsHash(knobs, { embeddingColumn: 'embedding', queryPrefix: '' })).toBe(bare);
  });
});

describe('gbrain config set round-trip', () => {
  test('the printed command stores trailing whitespace and a newline exactly, and unset clears it', async () => {
    expect(KNOWN_CONFIG_KEYS).toContain('embedding_query_prefix');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-query-prefix-'));
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
    try {
      const init = spawnSync('bun', ['run', cli, 'init', '--pglite', '--no-embedding', '--non-interactive'], { env, encoding: 'utf8' });
      expect(init.status, init.stderr).toBe(0);
      const value = `${QWEN} \t`;
      const printed = `gbrain config set embedding_query_prefix ${shellQuoteConfigValue(value)}`;
      const set = spawnSync('bash', ['-c', printed.replace(/^gbrain /, `bun run ${JSON.stringify(cli)} `)], { env, encoding: 'utf8' });
      expect(set.status, set.stderr).toBe(0);
      const get = spawnSync('bun', ['run', cli, 'config', 'get', 'embedding_query_prefix', '--raw'], { env, encoding: 'utf8' });
      expect(get.status, get.stderr).toBe(0);
      expect(get.stdout).toBe(`${value}\n`);
      const unset = spawnSync('bun', ['run', cli, 'config', 'unset', 'embedding_query_prefix'], { env, encoding: 'utf8' });
      expect(unset.status, unset.stderr).toBe(0);
      const after = spawnSync('bun', ['run', cli, 'config', 'get', 'embedding_query_prefix', '--raw'], { env, encoding: 'utf8' });
      expect(after.stdout).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('an unset key reads as no prefix', async () => {
    expect(await loadEmbeddingQueryPrefix(brainA)).toBe('');
  });
});

describe('doctor advisory', () => {
  const ctx = (engine: PGLiteEngine) => ({ engine, progress: { heartbeat: () => {} } }) as unknown as DoctorContext;

  test('suggests the documented value for known instruction-style families', () => {
    expect(suggestedQueryPrefix('openai-compatible:Qwen/Qwen3-Embedding-8B')?.value).toBe(QWEN);
    expect(suggestedQueryPrefix('ollama:qwen3-embedding:0.6b')?.family).toBe('Qwen3-Embedding');
    expect(suggestedQueryPrefix('openai-compatible:intfloat/multilingual-e5-large')?.value).toBe('query: ');
    expect(suggestedQueryPrefix('openai-compatible:BAAI/bge-large-en-v1.5')?.family).toBe('BGE');
    expect(suggestedQueryPrefix('ollama:nomic-embed-text')?.value).toBe('search_query: ');
    expect(suggestedQueryPrefix('openai:text-embedding-3-large')).toBeNull();
    expect(suggestedQueryPrefix('openai-compatible:BAAI/bge-m3')).toBeNull();
  });

  test('appears for a matching model with no prefix, and prints a command that runs as printed', async () => {
    configureEmbedding('ollama:qwen3-embedding:8b');
    const [check] = await embeddingQueryPrefixEntry.run(ctx(brainA)) as Check[];
    expect(check?.name).toBe('embedding_query_prefix');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain("gbrain config set embedding_query_prefix $'Instruct: Given a web search query, retrieve relevant passages that answer the query\\nQuery:'");
    expect(check?.message).toContain('stored document vectors are not re-embedded');
    expect(check?.message).toContain('gbrain config unset embedding_query_prefix');
  });

  test('stays silent once a prefix is set, and for other models', async () => {
    configureEmbedding('ollama:qwen3-embedding:8b');
    await brainA.setConfig('embedding_query_prefix', QWEN);
    expect(await embeddingQueryPrefixEntry.run(ctx(brainA))).toEqual([]);
    resetGateway();
    configureEmbedding('openai:text-embedding-3-large');
    expect(await embeddingQueryPrefixEntry.run(ctx(brainB))).toEqual([]);
  });
});
