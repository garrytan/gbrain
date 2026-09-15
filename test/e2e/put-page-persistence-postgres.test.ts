import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { resetPgliteStateNarrow } from '../helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { withSourceFilesystemLock } from '../../src/core/minions/source-filesystem.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';

const d = hasDatabase() ? describe : describe.skip;
let root: string;
const slug = 'notes/persistence-example';
const content = (body: string) => `---\ntitle: Example\ntype: note\n---\n\n${body}`;

async function put(body: string, pageSlug = slug) {
  const response = await dispatchToolCall(getEngine(), 'put_page', { slug: pageSlug, content: content(body) }, {
    remote: true,
    sourceId: 'default',
    auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default' },
    logger: { info() {}, warn() {}, error() {} },
  });
  return { response, payload: JSON.parse((response.content[0] as { text: string }).text) };
}

d('Postgres put_page persistence', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => {
    await resetPgliteStateNarrow(getEngine(), ['pages', 'config', 'gbrain_cycle_locks', 'minion_jobs']);
    resetGateway();
    _resetWriteThroughCacheForTest();
    root = mkdtempSync(join(tmpdir(), 'gbrain-put-pg-'));
    await getEngine().setConfig('sync.repo_path', root);
  });
  afterEach(() => {
    __setEmbedTransportForTests(null);
    resetGateway();
    _resetWriteThroughCacheForTest();
    rmSync(root, { recursive: true, force: true });
  });

  test('remote lock contention preserves the prior revision and the MCP error is retryable', async () => {
    await put('Original canonical revision.');
    const engine = getEngine();
    const before = await engine.getPage(slug, { sourceId: 'default' });
    const disk = readFileSync(join(root, `${slug}.md`), 'utf8');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withSourceFilesystemLock(engine, root, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      const failed = await put('Rejected revision.');
      expect(await engine.getPage(slug, { sourceId: 'default' })).toEqual(before);
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(disk);
      expect(failed.response.isError).toBe(true);
      expect(failed.payload.error).toBe('storage_busy');
      expect(failed.payload.message).toContain('not queued');
    } finally {
      release.resolve();
      await holder;
    }
    expect((await put('Accepted revision.')).response.isError).not.toBe(true);
  }, 15_000);

  test('file rename failure rolls back page, chunks, and version in the real transaction', async () => {
    await put('Before failed rename.');
    const engine = getEngine();
    const before = await engine.getPage(slug, { sourceId: 'default' });
    const chunks = await engine.getChunks(slug, { sourceId: 'default' });
    const file = join(root, `${slug}.md`);
    renameSync(file, `${file}.original`);
    mkdirSync(file);
    const failed = await put('Rejected replacement.');
    expect(failed.response.isError).toBe(true);
    expect(failed.payload.error).toBe('storage_error');
    expect(await engine.getPage(slug, { sourceId: 'default' })).toEqual(before);
    expect(await engine.getChunks(slug, { sourceId: 'default' })).toEqual(chunks);
    expect(await engine.executeRaw('SELECT id FROM page_versions')).toHaveLength(0);
  });

  test('pgvector failure is reported after the canonical write, without rolling back the page', async () => {
    const engine = getEngine();
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Persists before vector validation.');
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Persists before vector validation.');
      return { values, warnings: [], embeddings: values.map(() => [0.1, 0.2]), usage: { tokens: 1 } };
    });
    const result = await put('Persists before vector validation.');
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.status).toBe('created_or_updated');
    expect(result.payload.embedding.status).toBe('failed');
    expect(result.payload.write_through.written).toBe(true);
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
  });

  test('slow embedding releases the worktree before other writes and rejects superseded vectors', async () => {
    const engine = getEngine();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      if (values.some(value => value.includes('Older pending revision.'))) {
        started.resolve();
        await release.promise;
      }
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const pending = put('Older pending revision.');
    await started.promise;
    try {
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Older pending revision.');
      expect((await put('Independent saved page.', 'notes/independent')).response.isError).not.toBe(true);
      expect((await put('Replacement saved revision.')).response.isError).not.toBe(true);
    } finally {
      release.resolve();
      await pending;
    }
    expect((await pending).payload.embedding).toEqual({ status: 'superseded' });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Replacement saved revision.');
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Replacement saved revision.');
    expect((await engine.getChunks(slug, { sourceId: 'default' })).map(chunk => chunk.chunk_text)).toEqual(['Replacement saved revision.']);
  }, 15_000);
});
