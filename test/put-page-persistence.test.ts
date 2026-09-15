import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withSourceFilesystemLock } from '../src/core/minions/source-filesystem.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { contentHashLegacy } from '../src/core/utils.ts';

let engine: PGLiteEngine;
let root: string;
const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };
const content = (body: string, tags = 'original') => `---\ntitle: Example\ntype: note\ntags: [${tags}]\n---\n\n${body}`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  _resetWriteThroughCacheForTest();
  root = mkdtempSync(join(tmpdir(), 'gbrain-put-persistence-'));
  await engine.setConfig('sync.repo_path', root);
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  _resetWriteThroughCacheForTest();
  rmSync(root, { recursive: true, force: true });
});

async function put(slug: string, body: string, sourceId = 'default') {
  const response = await dispatchToolCall(engine, 'put_page', { slug, content: body }, {
    remote: true,
    sourceId,
    auth: { ...auth, sourceId },
    logger: { info() {}, warn() {}, error() {} },
  });
  return { response, payload: JSON.parse((response.content[0] as { text: string }).text) };
}

async function snapshot(slug: string) {
  return {
    page: await engine.getPage(slug, { sourceId: 'default' }),
    tags: await engine.getTags(slug, { sourceId: 'default' }),
    chunks: await engine.getChunks(slug, { sourceId: 'default' }),
    versions: await engine.executeRaw('SELECT * FROM page_versions ORDER BY id'),
  };
}

describe('put_page persistence boundary', () => {
  test('contended worktree rejects existing and new pages without publishing either, while another root writes', async () => {
    const slug = 'notes/existing';
    await put(slug, content('Original durable body.'));
    const before = await snapshot(slug);
    const disk = readFileSync(join(root, `${slug}.md`), 'utf8');
    const otherRoot = mkdtempSync(join(tmpdir(), 'gbrain-put-independent-'));
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', $1)", [otherRoot]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withSourceFilesystemLock(engine, root, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      const writes = Promise.all([
        put(slug, content('Rejected replacement.', 'replacement')),
        put('notes/new', content('Rejected creation.')),
      ]);
      const independent = await put('notes/independent', content('Independent content.'), 'other');
      expect(independent.response.isError).not.toBe(true);
      expect(readFileSync(join(otherRoot, 'notes/independent.md'), 'utf8')).toContain('Independent content.');
      const rejected = await writes;
      expect(await snapshot(slug)).toEqual(before);
      expect(await engine.getPage('notes/new', { sourceId: 'default' })).toBeNull();
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(disk);
      expect(existsSync(join(root, 'notes/new.md'))).toBe(false);
      for (const result of rejected) {
        expect(result.response.isError).toBe(true);
        expect(result.payload.error).toBe('storage_busy');
        expect(result.payload.suggestion).toContain('retry');
        expect(result.payload.message).toContain('not queued');
      }
    } finally {
      release.resolve();
      await holder;
      rmSync(otherRoot, { recursive: true, force: true });
    }
    expect((await put(slug, content('Accepted replacement.'))).response.isError).not.toBe(true);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Accepted replacement.');
  }, 15_000);

  test('rename failure rolls back the existing page, tags, chunks, and version snapshot', async () => {
    const slug = 'notes/rename-failure';
    await put(slug, content('Original before failed rename.'));
    const before = await snapshot(slug);
    const file = join(root, `${slug}.md`);
    const original = readFileSync(file, 'utf8');
    renameSync(file, `${file}.original`);
    mkdirSync(file);
    const failed = await put(slug, content('Must not replace the visible page.', 'rejected'));
    expect(failed.response.isError).toBe(true);
    expect(failed.payload.error).toBe('storage_error');
    expect(await snapshot(slug)).toEqual(before);
    expect(readFileSync(`${file}.original`, 'utf8')).toBe(original);
  });

  test('an unchanged legacy-hash page also rolls back when its canonical file is refused', async () => {
    const slug = 'notes/legacy-hash';
    const body = content('Unchanged legacy body.');
    await put(slug, body);
    const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
    await engine.executeRaw('UPDATE pages SET content_hash = $1 WHERE id = $2', [contentHashLegacy(page), page.id]);
    const before = await snapshot(slug);
    const file = join(root, `${slug}.md`);
    renameSync(file, `${file}.original`);
    mkdirSync(file);
    const failed = await put(slug, body);
    expect(failed.response.isError).toBe(true);
    expect(await snapshot(slug)).toEqual(before);
  });

  test('source-path bookkeeping failure rejects before replacing the canonical file', async () => {
    const slug = 'notes/source-path-failure';
    await put(slug, content('Original canonical content.'));
    await engine.executeRaw('UPDATE pages SET source_path = NULL WHERE slug = $1', [slug]);
    const before = await snapshot(slug);
    const file = join(root, `${slug}.md`);
    const originalFile = readFileSync(file, 'utf8');
    const executeRaw = engine.executeRaw;
    let rejected = false;
    engine.executeRaw = function<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (sql.includes('SET source_path = $1')) {
        rejected = true;
        throw new Error('fixture source-path write rejected');
      }
      return executeRaw.call(this, sql, params) as Promise<T[]>;
    };
    try {
      const result = await put(slug, content('Rejected replacement.', 'replacement'));
      expect(rejected).toBe(true);
      expect(result.response.isError).toBe(true);
      expect(result.payload.error).toBe('storage_error');
    } finally {
      engine.executeRaw = executeRaw;
    }
    expect(await snapshot(slug)).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(originalFile);
  });

  test('a waiter sees no visible mutation until the holder releases, then writes exactly once', async () => {
    const slug = 'notes/short-wait';
    await put(slug, content('Before waiting.'));
    const before = await snapshot(slug);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withSourceFilesystemLock(engine, root, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = put(slug, content('After waiting.'));
    try {
      await Bun.sleep(100);
      expect(await snapshot(slug)).toEqual(before);
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Before waiting.');
    } finally {
      release.resolve();
      await holder;
      await pending;
    }
    expect((await pending).response.isError).not.toBe(true);
    expect((await snapshot(slug)).versions).toHaveLength(1);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('After waiting.');
  });

  test('canonical page is committed before an embedding failure and remains a successful persisted write', async () => {
    const slug = 'notes/embed-failure';
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    let calls = 0;
    let observedCommitted = false;
    __setEmbedTransportForTests(async () => {
      calls++;
      observedCommitted = (await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth.includes('Survives embedding failure.') === true
        && existsSync(join(root, `${slug}.md`))
        && readFileSync(join(root, `${slug}.md`), 'utf8').includes('Survives embedding failure.');
      throw new Error('fixture embedding rejected');
    });
    const result = await put(slug, content('Survives embedding failure.'));
    expect(calls).toBeGreaterThan(0);
    expect(observedCommitted).toBe(true);
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.status).toBe('created_or_updated');
    expect(result.payload.embedding?.status).toBe('failed');
    expect(result.payload.write_through.written).toBe(true);
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  });

  test('successful post-persistence embeddings fill only the written page', async () => {
    const slug = 'notes/embed-success';
    await put('notes/unrelated', content('Unrelated unembedded body.'));
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Page-scoped enrichment.');
      expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Page-scoped enrichment.');
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const result = await put(slug, content('Page-scoped enrichment.'));
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.embedding).toEqual({ status: 'embedded' });
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => !chunk.embedding_is_null)).toBe(true);
    expect((await engine.getChunks('notes/unrelated', { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  });

  test('slow optional embedding releases the worktree and cannot overwrite a newer file-backed revision', async () => {
    const slug = 'notes/slow-embedding';
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      if (values.some(value => value.includes('Older revision waiting for embedding.'))) {
        started.resolve();
        await release.promise;
      }
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const pending = put(slug, content('Older revision waiting for embedding.'));
    await started.promise;
    try {
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Older revision waiting for embedding.');
      const independent = await put('notes/independent-embedding', content('Another page in the same worktree.'));
      expect(independent.response.isError).not.toBe(true);
      expect(independent.payload.embedding).toEqual({ status: 'embedded' });
      const replacement = await put(slug, content('Newer file-backed revision.'));
      expect(replacement.response.isError).not.toBe(true);
      expect(replacement.payload.embedding).toEqual({ status: 'embedded' });
    } finally {
      release.resolve();
      await pending;
    }
    expect((await pending).payload.embedding).toEqual({ status: 'superseded' });
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Newer file-backed revision.');
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Newer file-backed revision.');
    expect((await engine.getChunks(slug, { sourceId: 'default' })).map(chunk => chunk.chunk_text)).toEqual(['Newer file-backed revision.']);
  }, 15_000);

  test('successful MCP persistence never returns credentials from an embedding error', async () => {
    const slug = 'notes/embed-error-redaction';
    const credentialUrl = 'https://fixture-user:PLACEHOLDER@embed.example/v1?token=fixture-private-token';
    const bearer = 'Bearer fixture-private-bearer';
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async () => {
      throw new Error(`Embedding request failed at ${credentialUrl}; Authorization: ${bearer}`);
    });
    const result = await put(slug, content('Persisted without disclosing provider credentials.'));
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.status).toBe('created_or_updated');
    expect(result.payload.embedding.status).toBe('failed');
    const responseText = JSON.stringify(result.response);
    for (const sensitive of [credentialUrl, 'fixture-user', 'PLACEHOLDER', 'embed.example', 'fixture-private-token', bearer, 'fixture-private-bearer']) {
      expect(responseText.includes(sensitive)).toBe(false);
    }
    expect(result.payload.embedding.error).toBe('Page content was saved, but embedding failed. Check the embedding provider and database on the brain host, then run gbrain embed --stale --source <source-id>.');
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Persisted without disclosing provider credentials.');
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Persisted without disclosing provider credentials.');
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
  });

  test('a concurrent DB-only revision cannot receive stale post-persistence chunks', async () => {
    const slug = 'notes/embed-superseded';
    await engine.setConfig('sync.repo_path', '');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      await importFromContent(engine, slug, content('Intervening revision.'), { noEmbed: true, sourceId: 'default' });
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const result = await put(slug, content('Older revision being embedded.'));
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.embedding).toEqual({ status: 'superseded' });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe('Intervening revision.');
    const chunks = await engine.getChunks(slug, { sourceId: 'default' });
    expect(chunks.map(chunk => chunk.chunk_text)).toEqual(['Intervening revision.']);
    expect(chunks.every(chunk => chunk.embedding_is_null)).toBe(true);
  });

  test('rechunking unchanged content cannot be undone by an older embedding completion', async () => {
    const slug = 'notes/rechunk-superseded';
    const body = content('Content with a replaced chunk generation.');
    await engine.setConfig('sync.repo_path', '');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      await importFromContent(engine, slug, body, { noEmbed: true, sourceId: 'default', forceRechunk: true });
      return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
    });
    const result = await put(slug, body);
    expect(result.response.isError).not.toBe(true);
    expect(result.payload.embedding).toEqual({ status: 'superseded' });
    expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
  });

  for (const action of ['soft-delete', 'hard-delete', 'recreate'] as const) {
    test(`late embedding cannot revive or replace a ${action} page`, async () => {
      const slug = 'notes/deleted-embedding';
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
      __setEmbedTransportForTests(async ({ values }) => {
        if (action === 'soft-delete') await engine.softDeletePage(slug, { sourceId: 'default' });
        else await engine.deletePage(slug, { sourceId: 'default' });
        if (action === 'recreate') {
          await importFromContent(engine, slug, content('Recreated content.'), { noEmbed: true, sourceId: 'default' });
        }
        return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
      });
      expect((await put(slug, content('Old page content.'))).payload.embedding).toEqual({ status: 'superseded' });
      const page = await engine.getPage(slug, { sourceId: 'default' });
      if (action === 'recreate') {
        expect(page?.compiled_truth).toBe('Recreated content.');
        expect((await engine.getChunks(slug, { sourceId: 'default' })).every(chunk => chunk.embedding_is_null)).toBe(true);
      } else {
        expect(page).toBeNull();
      }
    });
  }
});
