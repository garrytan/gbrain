import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildPageChunks, importFromContent } from '../src/core/import-file.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { ChunkInput, PageInput } from '../src/core/types.ts';
import { importContentHash } from '../src/core/utils.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForFile(path: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await delay(20);
  }
  return false;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let tempDir = '';
let dbPath = '';
let engine: SQLiteEngine;

async function putPage(slug: string, overrides: Partial<PageInput> = {}) {
  return engine.putPage(slug, {
    type: 'person',
    title: slug,
    compiled_truth: `${slug} truth`,
    timeline: `${slug} timeline`,
    frontmatter: { source: 'test' },
    ...overrides,
  });
}

async function putChunks(slug: string, chunks: ChunkInput[]) {
  await engine.upsertChunks(slug, chunks);
  return engine.getChunks(slug);
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-engine-'));
  dbPath = join(tempDir, 'brain.db');
  engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: dbPath });
  await engine.initSchema();
});

afterEach(async () => {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SQLiteEngine', () => {
  test('keeps nested transaction savepoint rollback inside the outer transaction', async () => {
    await engine.transaction(async (outer) => {
      await outer.putPage('people/outer-committed.md', {
        type: 'person',
        title: 'Outer Committed',
        compiled_truth: 'Outer transaction should commit.',
        timeline: '',
        frontmatter: {},
      });

      await expect(outer.transaction(async (nested) => {
        await nested.putPage('people/nested-rolled-back.md', {
          type: 'person',
          title: 'Nested Rolled Back',
          compiled_truth: 'Nested transaction should roll back.',
          timeline: '',
          frontmatter: {},
        });
        throw new Error('rollback nested transaction');
      })).rejects.toThrow('rollback nested transaction');

      await outer.transaction(async (nested) => {
        await nested.putPage('people/nested-committed.md', {
          type: 'person',
          title: 'Nested Committed',
          compiled_truth: 'Nested transaction should commit with the outer transaction.',
          timeline: '',
          frontmatter: {},
        });
      });
    });

    expect((await engine.getPage('people/outer-committed.md'))?.title).toBe('Outer Committed');
    expect(await engine.getPage('people/nested-rolled-back.md')).toBeNull();
    expect((await engine.getPage('people/nested-committed.md'))?.title).toBe('Nested Committed');
  });

  test('serializes overlapping top-level transactions so rollback does not erase a committed peer', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();

    const first = engine.transaction(async (tx) => {
      await tx.putPage('people/rolled-back.md', {
        type: 'person',
        title: 'Rolled Back',
        compiled_truth: 'This write should roll back.',
        timeline: '',
        frontmatter: {},
      });
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new Error('rollback first transaction');
    });

    await firstStarted.promise;

    const second = engine.transaction(async (tx) => {
      await tx.putPage('people/committed-peer.md', {
        type: 'person',
        title: 'Committed Peer',
        compiled_truth: 'This write must survive the peer rollback.',
        timeline: '',
        frontmatter: {},
      });
      return 'committed';
    });

    releaseFirst.resolve();

    await expect(first).rejects.toThrow('rollback first transaction');
    await expect(second).resolves.toBe('committed');
    expect(await engine.getPage('people/rolled-back.md')).toBeNull();
    expect((await engine.getPage('people/committed-peer.md'))?.title).toBe('Committed Peer');
  });

  test('waits for a cross-process SQLite writer instead of failing schema initialization with SQLITE_BUSY', async () => {
    const firstReadyPath = join(tempDir, 'first-ready');
    const releasePath = join(tempDir, 'release-first');
    const workerCode = `
      import { existsSync, writeFileSync } from 'fs';
      import { SQLiteEngine } from './src/core/sqlite-engine.ts';

      const dbPath = process.env.MBRAIN_TEST_DB_PATH;
      const firstReadyPath = process.env.MBRAIN_TEST_FIRST_READY_PATH;
      const releasePath = process.env.MBRAIN_TEST_RELEASE_PATH;
      if (!dbPath || !firstReadyPath || !releasePath) {
        throw new Error('missing worker environment');
      }

      const engine = new SQLiteEngine();
      await engine.connect({ engine: 'sqlite', database_path: dbPath });
      await engine.initSchema();
      await engine.transaction(async (tx) => {
        await tx.putPage('people/cross-process-lock-holder.md', {
          type: 'person',
          title: 'Cross Process Lock Holder',
          compiled_truth: 'This process holds a SQLite write lock.',
          timeline: '',
          frontmatter: {},
        });
        writeFileSync(firstReadyPath, 'ready');
        while (!existsSync(releasePath)) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      });
      await engine.disconnect();
    `;
    const lockHolder = Bun.spawn({
      cmd: [process.execPath, '--eval', workerCode],
      cwd: process.cwd(),
      env: {
        ...process.env,
        MBRAIN_TEST_DB_PATH: dbPath,
        MBRAIN_TEST_FIRST_READY_PATH: firstReadyPath,
        MBRAIN_TEST_RELEASE_PATH: releasePath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(await waitForFile(firstReadyPath)).toBe(true);

    const contenderCode = `
      import { SQLiteEngine } from './src/core/sqlite-engine.ts';

      const dbPath = process.env.MBRAIN_TEST_DB_PATH;
      if (!dbPath) throw new Error('missing contender environment');

      const engine = new SQLiteEngine();
      await engine.connect({ engine: 'sqlite', database_path: dbPath });
      await engine.initSchema();
      await engine.disconnect();
    `;
    const contender = Bun.spawn({
      cmd: [process.execPath, '--eval', contenderCode],
      cwd: process.cwd(),
      env: {
        ...process.env,
        MBRAIN_TEST_DB_PATH: dbPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await delay(100);
    writeFileSync(releasePath, 'release');
    const contenderExitCode = await contender.exited;
    const contenderStderr = await new Response(contender.stderr).text();
    expect({ exitCode: contenderExitCode, stderr: contenderStderr.trim() }).toEqual({ exitCode: 0, stderr: '' });

    const exitCode = await lockHolder.exited;
    const stderr = await new Response(lockHolder.stderr).text();
    expect({ exitCode, stderr: stderr.trim() }).toEqual({ exitCode: 0, stderr: '' });
  });

  test('supports page CRUD, chunks, config, slug resolution, and slug updates', async () => {
    const page = await putPage('People/Alice.md', {
      title: 'Alice Example',
      compiled_truth: 'Alice leads product strategy.',
      timeline: '2025: promoted to staff product lead',
    });

    expect(page.slug).toBe('people/alice.md');
    expect((await engine.getPage('people/alice.md'))?.title).toBe('Alice Example');
    expect((await engine.listPages({ type: 'person' })).map(p => p.slug)).toEqual(['people/alice.md']);
    expect(await engine.resolveSlugs('people/alice.md')).toEqual(['people/alice.md']);
    expect(await engine.resolveSlugs('alice')).toContain('people/alice.md');

    await putChunks('people/alice.md', [
      {
        chunk_index: 0,
        chunk_text: 'Alice leads product strategy.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        token_count: 4,
      },
      {
        chunk_index: 1,
        chunk_text: '2025: promoted to staff product lead',
        chunk_source: 'timeline',
      },
    ]);

    const chunks = await engine.getChunks('people/alice.md');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunk_source).toBe('compiled_truth');
    expect(chunks[0].embedded_at).toBeInstanceOf(Date);
    expect(chunks[0].embedding).toBeNull();
    expect(chunks[1].embedded_at).toBeNull();

    await engine.setConfig('sync.repo_path', '/tmp/repo');
    expect(await engine.getConfig('sync.repo_path')).toBe('/tmp/repo');

    await engine.updateSlug('people/alice.md', 'People/Alice-Renamed.md');
    await engine.rewriteLinks('people/alice.md', 'people/alice-renamed.md');

    expect(await engine.getPage('people/alice.md')).toBeNull();
    expect((await engine.getPage('people/alice-renamed.md'))?.title).toBe('Alice Example');
    expect(await engine.resolveSlugs('alice-renamed')).toEqual(['people/alice-renamed.md']);

    await engine.deleteChunks('people/alice-renamed.md');
    expect(await engine.getChunks('people/alice-renamed.md')).toHaveLength(0);

    await engine.deletePage('people/alice-renamed.md');
    expect(await engine.getPage('people/alice-renamed.md')).toBeNull();
  });

  test('supports tags, links, backlinks, and graph traversal across renamed slugs', async () => {
    await putPage('people/alice.md', { title: 'Alice' });
    await putPage('companies/acme.md', { type: 'company', title: 'Acme' });
    await putPage('projects/apollo.md', { type: 'project', title: 'Apollo' });

    await engine.addTag('people/alice.md', 'founder');
    await engine.addTag('people/alice.md', 'operator');
    await engine.addTag('people/alice.md', 'founder');
    expect(await engine.getTags('people/alice.md')).toEqual(['founder', 'operator']);
    expect((await engine.listPages({ tag: 'founder' })).map(p => p.slug)).toEqual(['people/alice.md']);

    await engine.addLink('people/alice.md', 'companies/acme.md', 'founded company', 'founder_of');
    await engine.addLink('companies/acme.md', 'projects/apollo.md', 'incubated project', 'incubates');

    expect(await engine.getLinks('people/alice.md')).toEqual([
      {
        from_slug: 'people/alice.md',
        to_slug: 'companies/acme.md',
        link_type: 'founder_of',
        context: 'founded company',
      },
    ]);
    expect(await engine.getBacklinks('companies/acme.md')).toEqual([
      {
        from_slug: 'people/alice.md',
        to_slug: 'companies/acme.md',
        link_type: 'founder_of',
        context: 'founded company',
      },
    ]);

    await engine.updateSlug('companies/acme.md', 'companies/acme-ai.md');
    await engine.rewriteLinks('companies/acme.md', 'companies/acme-ai.md');

    expect((await engine.getLinks('people/alice.md'))[0]?.to_slug).toBe('companies/acme-ai.md');

    const graph = await engine.traverseGraph('people/alice.md', 2);
    expect(graph).toEqual([
      {
        slug: 'people/alice.md',
        title: 'Alice',
        type: 'person',
        depth: 0,
        links: [{ to_slug: 'companies/acme-ai.md', link_type: 'founder_of' }],
      },
      {
        slug: 'companies/acme-ai.md',
        title: 'Acme',
        type: 'company',
        depth: 1,
        links: [{ to_slug: 'projects/apollo.md', link_type: 'incubates' }],
      },
      {
        slug: 'projects/apollo.md',
        title: 'Apollo',
        type: 'project',
        depth: 2,
        links: [],
      },
    ]);

    await engine.removeLink('people/alice.md', 'companies/acme-ai.md');
    expect(await engine.getLinks('people/alice.md')).toEqual([]);

    await engine.removeTag('people/alice.md', 'operator');
    expect(await engine.getTags('people/alice.md')).toEqual(['founder']);
  });

  test('supports timeline entries, versions, raw data, ingest log, and vector placeholder behavior', async () => {
    await putPage('people/alice.md', {
      title: 'Alice',
      compiled_truth: 'Version 2',
      frontmatter: { role: 'operator' },
    });

    await delay(10);
    await engine.addTimelineEntry('people/alice.md', {
      date: '2024-01-01',
      source: 'news',
      summary: 'Joined Acme',
      detail: 'Joined as COO',
    });
    await delay(10);
    await engine.addTimelineEntry('people/alice.md', {
      date: '2025-03-10',
      source: 'press',
      summary: 'Promoted',
      detail: 'Promoted to CEO',
    });

    expect((await engine.getTimeline('people/alice.md')).map(entry => entry.summary)).toEqual(['Promoted', 'Joined Acme']);
    expect((await engine.getTimeline('people/alice.md', { after: '2025-01-01' })).map(entry => entry.summary)).toEqual(['Promoted']);

    await engine.putRawData('people/alice.md', 'linkedin', { headline: 'CEO at Acme' });
    await engine.putRawData('people/alice.md', 'linkedin', { headline: 'CEO + board member' });
    expect(await engine.getRawData('people/alice.md', 'linkedin')).toHaveLength(1);
    expect((await engine.getRawData('people/alice.md', 'linkedin'))[0]?.data).toEqual({ headline: 'CEO + board member' });

    const version = await engine.createVersion('people/alice.md');
    await engine.putPage('people/alice.md', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Version 3',
      frontmatter: { role: 'ceo' },
    });

    const versions = await engine.getVersions('people/alice.md');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.id).toBe(version.id);
    expect(versions[0]?.compiled_truth).toBe('Version 2');

    await engine.revertToVersion('people/alice.md', version.id);
    const reverted = await engine.getPage('people/alice.md');
    expect(reverted?.compiled_truth).toBe('Version 2');
    expect(reverted?.frontmatter).toEqual({ role: 'operator' });

    await engine.logIngest({
      source_type: 'git_sync',
      source_ref: '/repo@abc123',
      pages_updated: ['people/alice.md'],
      summary: 'Synced Alice page',
    });
    const ingest = await engine.getIngestLog({ limit: 5 });
    expect(ingest).toHaveLength(1);
    expect(ingest[0]?.pages_updated).toEqual(['people/alice.md']);

    expect(await engine.searchVector(new Float32Array([0.1, 0.2, 0.3]))).toEqual([]);
  });

  test('searchVector keeps the page shortlist broader than the final result limit', async () => {
    await putPage('concepts/top-centroid', {
      type: 'concept',
      title: 'Top Centroid',
      compiled_truth: 'Top centroid page',
      timeline: '',
      frontmatter: {},
    });
    await putPage('concepts/best-chunk', {
      type: 'concept',
      title: 'Best Chunk',
      compiled_truth: 'Best chunk page',
      timeline: '',
      frontmatter: {},
    });
    await putPage('concepts/irrelevant', {
      type: 'concept',
      title: 'Irrelevant',
      compiled_truth: 'Irrelevant page',
      timeline: '',
      frontmatter: {},
    });

    await putChunks('concepts/top-centroid', [
      {
        chunk_index: 0,
        chunk_text: 'top centroid chunk',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.7, 0.7]),
      },
    ]);
    await putChunks('concepts/best-chunk', [
      {
        chunk_index: 0,
        chunk_text: 'best chunk match',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0]),
      },
    ]);
    await putChunks('concepts/irrelevant', [
      {
        chunk_index: 0,
        chunk_text: 'irrelevant chunk',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0, 1]),
      },
    ]);

    await engine.updatePageEmbedding('concepts/top-centroid', new Float32Array([1, 0]));
    await engine.updatePageEmbedding('concepts/best-chunk', new Float32Array([0.97, 0.03]));
    await engine.updatePageEmbedding('concepts/irrelevant', new Float32Array([0, 1]));

    const results = await engine.searchVector(new Float32Array([1, 0]), {
      type: 'concept',
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.slug).toBe('concepts/best-chunk');
    expect(results[0]?.chunk_text).toBe('best chunk match');
  });

  test('searchVector falls back to chunk scoring when pages with embeddings are missing centroids', async () => {
    await putPage('concepts/missing-centroid', {
      type: 'concept',
      title: 'Missing Centroid',
      compiled_truth: 'Missing centroid page',
      timeline: '',
      frontmatter: {},
    });
    await putPage('concepts/centroid-present', {
      type: 'concept',
      title: 'Centroid Present',
      compiled_truth: 'Centroid present page',
      timeline: '',
      frontmatter: {},
    });

    await putChunks('concepts/missing-centroid', [
      {
        chunk_index: 0,
        chunk_text: 'exact vector match',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0]),
      },
    ]);
    await putChunks('concepts/centroid-present', [
      {
        chunk_index: 0,
        chunk_text: 'weaker vector match',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.6, 0.8]),
      },
    ]);

    await engine.updatePageEmbedding('concepts/missing-centroid', null);
    await engine.updatePageEmbedding('concepts/centroid-present', new Float32Array([0.6, 0.8]));

    const results = await engine.searchVector(new Float32Array([1, 0]), {
      type: 'concept',
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.slug).toBe('concepts/missing-centroid');
    expect(results[0]?.chunk_text).toBe('exact vector match');
  });

  test('searchVector narrows chunk scoring to a centroid-selected page set when centroids are available', async () => {
    await putPage('concepts/prefilter-alpha', {
      type: 'concept',
      title: 'Prefilter Alpha',
      compiled_truth: 'Prefilter alpha page',
      timeline: '',
      frontmatter: {},
    });
    await putPage('concepts/prefilter-beta', {
      type: 'concept',
      title: 'Prefilter Beta',
      compiled_truth: 'Prefilter beta page',
      timeline: '',
      frontmatter: {},
    });

    await putChunks('concepts/prefilter-alpha', [
      {
        chunk_index: 0,
        chunk_text: 'prefilter alpha chunk',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0]),
      },
    ]);
    await putChunks('concepts/prefilter-beta', [
      {
        chunk_index: 0,
        chunk_text: 'prefilter beta chunk',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0, 1]),
      },
    ]);

    const db = (engine as any).database as Database;
    const originalQuery = db.query.bind(db);
    const seenSql: string[] = [];
    (db as any).query = (sql: string) => {
      seenSql.push(sql);
      return originalQuery(sql);
    };

    try {
      await engine.searchVector(new Float32Array([1, 0]), {
        type: 'concept',
        limit: 1,
      });
    } finally {
      (db as any).query = originalQuery;
    }

    expect(seenSql.some((sql) => (
      sql.includes('SELECT')
      && sql.includes('p.id AS page_id')
      && sql.includes('p.page_embedding')
      && sql.includes('cc.embedding IS NOT NULL')
    ))).toBe(true);
    expect(seenSql.some((sql) => (
      sql.includes('FROM content_chunks cc')
      && sql.includes('cc.chunk_text')
      && sql.includes('cc.page_id IN')
    ))).toBe(true);
    expect(seenSql.some((sql) => (
      sql.includes('SELECT')
      && sql.includes('cc.id AS chunk_id')
      && sql.includes('cc.embedding')
      && !sql.includes('cc.chunk_text')
      && sql.includes('cc.page_id NOT IN')
    ))).toBe(true);
  });

  test('searchVector rescues omitted diluted-centroid pages via lightweight embedding scan', async () => {
    const query = new Float32Array([1, 0]);

    await putPage('concepts/diluted-exact', {
      type: 'concept',
      title: 'Diluted Exact',
      compiled_truth: 'Exact page hidden by a diluted centroid',
      timeline: '',
      frontmatter: {},
    });

    await putChunks('concepts/diluted-exact', [
      {
        chunk_index: 0,
        chunk_text: 'exact match chunk',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0]),
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        chunk_index: index + 1,
        chunk_text: `diluting chunk ${index + 1}`,
        chunk_source: 'compiled_truth' as const,
        embedding: new Float32Array([0, 1]),
      })),
    ]);

    for (let index = 0; index < 40; index++) {
      const slug = `concepts/diluted-decoy-${index + 1}`;
      await putPage(slug, {
        type: 'concept',
        title: `Diluted Decoy ${index + 1}`,
        compiled_truth: 'Decoy page',
        timeline: '',
        frontmatter: {},
      });
      await putChunks(slug, [
        ...Array.from({ length: 6 }, (_, chunkIndex) => ({
          chunk_index: chunkIndex,
          chunk_text: `decoy chunk ${index + 1}-${chunkIndex + 1}`,
          chunk_source: 'compiled_truth' as const,
          embedding: new Float32Array([0.2, 0.05]),
        })),
      ]);
    }

    const results = await engine.searchVector(query, {
      type: 'concept',
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.slug).toBe('concepts/diluted-exact');
    expect(results[0]?.chunk_text).toBe('exact match chunk');
  });

  test('revertToVersion refreshes searchable codemap state', async () => {
    await putPage('systems/revert-test.md', {
      type: 'system',
      title: 'Revert Test',
      compiled_truth: 'Original symbol map.',
      timeline: '',
      frontmatter: {
        codemap: [
          {
            system: 'systems/revert-test',
            pointers: [
              {
                path: 'src/original.ts',
                symbol: 'Old::Symbol()',
                role: 'Original implementation',
                verified_at: '2026-04-16',
              },
            ],
          },
        ],
      },
    });
    await putChunks('systems/revert-test.md', buildPageChunks('Original symbol map.', '', {
      codemap: [
        {
          system: 'systems/revert-test',
          pointers: [
            {
              path: 'src/original.ts',
              symbol: 'Old::Symbol()',
              role: 'Original implementation',
              verified_at: '2026-04-16',
            },
          ],
        },
      ],
    }));

    const version = await engine.createVersion('systems/revert-test.md');
    await putPage('systems/revert-test.md', {
      type: 'system',
      title: 'Revert Test',
      compiled_truth: 'Updated symbol map.',
      timeline: '',
      frontmatter: {
        codemap: [
          {
            system: 'systems/revert-test',
            pointers: [
              {
                path: 'src/updated.ts',
                symbol: 'New::Symbol()',
                role: 'Updated implementation',
                verified_at: '2026-04-16',
              },
            ],
          },
        ],
      },
    });
    await putChunks('systems/revert-test.md', buildPageChunks('Updated symbol map.', '', {
      codemap: [
        {
          system: 'systems/revert-test',
          pointers: [
            {
              path: 'src/updated.ts',
              symbol: 'New::Symbol()',
              role: 'Updated implementation',
              verified_at: '2026-04-16',
            },
          ],
        },
      ],
    }));

    expect((await engine.searchKeyword('New Symbol')).map(result => result.slug)).toEqual(['systems/revert-test.md']);

    await engine.revertToVersion('systems/revert-test.md', version.id);

    expect(await engine.searchKeyword('New Symbol')).toEqual([]);
    expect((await engine.searchKeyword('Old Symbol')).map(result => result.slug)).toEqual(['systems/revert-test.md']);
    const reverted = await engine.getPage('systems/revert-test.md');
    expect(reverted?.content_hash).toBe(importContentHash({
      title: 'Revert Test',
      type: 'system',
      compiled_truth: 'Original symbol map.',
      timeline: '',
      frontmatter: {
        codemap: [
          {
            system: 'systems/revert-test',
            pointers: [
              {
                path: 'src/original.ts',
                symbol: 'Old::Symbol()',
                role: 'Original implementation',
                verified_at: '2026-04-16',
              },
            ],
          },
        ],
      },
      tags: [],
    }));
    const chunks = await engine.getChunks('systems/revert-test.md');
    expect(chunks[0]?.chunk_text).toBe('Original symbol map.');
    expect(chunks[chunks.length - 1]?.chunk_text).toContain('Old::Symbol()');
    const rerun = await importFromContent(engine, 'systems/revert-test.md', `---
type: system
title: Revert Test
codemap:
  - system: systems/revert-test
    pointers:
      - path: src/original.ts
        symbol: Old::Symbol()
        role: Original implementation
        verified_at: 2026-04-16
---
Original symbol map.
`);
    expect(rerun.status).toBe('skipped');
  });

  test('reports stats and health for SQLite data', async () => {
    await putPage('people/alice.md', { title: 'Alice' });
    await putPage('companies/acme.md', { type: 'company', title: 'Acme' });

    await engine.addTag('people/alice.md', 'founder');
    await engine.addTag('companies/acme.md', 'portfolio');
    await engine.addLink('people/alice.md', 'companies/acme.md', 'founded', 'founder_of');
    await delay(10);
    await engine.addTimelineEntry('people/alice.md', {
      date: '2024-01-01',
      summary: 'Founded Acme',
      detail: 'Company launch',
    });

    await putChunks('people/alice.md', [
      {
        chunk_index: 0,
        chunk_text: 'Alice founded Acme.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.1, 0.2]),
      },
      {
        chunk_index: 1,
        chunk_text: '2024: founded Acme.',
        chunk_source: 'timeline',
      },
    ]);

    const stats = await engine.getStats();
    expect(stats).toEqual({
      page_count: 2,
      chunk_count: 2,
      embedded_count: 1,
      link_count: 1,
      tag_count: 2,
      timeline_entry_count: 1,
      pages_by_type: { company: 1, person: 1 },
    });

    const health = await engine.getHealth();
    expect(health.page_count).toBe(2);
    expect(health.embed_coverage).toBeCloseTo(0.5, 5);
    expect(health.stale_pages).toBe(1);
    expect(health.orphan_pages).toBe(1);
    expect(health.dead_links).toBe(0);
    expect(health.missing_embeddings).toBe(1);
  });

  test('supports FTS keyword search with normalized SearchResult rows', async () => {
    await putPage('people/alice.md', {
      title: 'Alice Neural',
      compiled_truth: 'Alice works on neural retrieval systems.',
      timeline: '2025: shipped offline keyword search',
    });
    await putPage('projects/apollo.md', {
      type: 'project',
      title: 'Apollo',
      compiled_truth: 'Apollo focuses on analytics dashboards.',
      timeline: '2024: launched beta',
    });

    const results = await engine.searchKeyword('neural retrieval', { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: 'people/alice.md',
      title: 'Alice Neural',
      type: 'person',
      chunk_source: 'compiled_truth',
      stale: false,
    });
    expect(results[0]!.chunk_text).toContain('neural retrieval');
    expect(results[0]!.score).toBeGreaterThanOrEqual(0);

    expect(await engine.searchKeyword('keyword', { type: 'project' })).toEqual([]);
    expect(await engine.searchKeyword('keyword', { type: 'person', exclude_slugs: ['people/alice.md'] })).toEqual([]);
  });

  test('rerunning initSchema migrates downgraded legacy SQLite slugs before reporting latest version', async () => {
    await putPage('people/alice.md', {
      title: 'Alice Legacy',
      compiled_truth: 'Legacy slug page.',
    });

    await engine.disconnect();

    const raw = new Database(dbPath);
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.run(`UPDATE config SET value = '1' WHERE key = 'version'`);
    raw.run(`UPDATE pages SET slug = 'People/Alice.md' WHERE slug = 'people/alice.md'`);
    raw.close();

    engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: dbPath });
    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect((await engine.listPages()).map(page => page.slug)).toContain('people/alice');
    expect((await engine.getPage('people/alice'))?.title).toBe('Alice Legacy');

    const verify = new Database(dbPath, { readonly: true });
    const row = verify.query(`SELECT slug FROM pages LIMIT 1`).get() as { slug: string };
    verify.close();

    expect(row.slug).toBe('people/alice');
  });

  test('rerunning initSchema treats missing version row as baseline and migrates legacy slugs', async () => {
    await putPage('people/alice.md', {
      title: 'Alice Missing Version',
      compiled_truth: 'Missing version row slug page.',
    });

    await engine.disconnect();

    const raw = new Database(dbPath);
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.run(`DELETE FROM config WHERE key = 'version'`);
    raw.run(`UPDATE pages SET slug = 'People/Alice.md' WHERE slug = 'people/alice.md'`);
    raw.close();

    engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: dbPath });
    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect((await engine.listPages()).map(page => page.slug)).toContain('people/alice');
    expect((await engine.getPage('people/alice'))?.title).toBe('Alice Missing Version');

    const verify = new Database(dbPath, { readonly: true });
    const row = verify.query(`SELECT slug FROM pages LIMIT 1`).get() as { slug: string };
    verify.close();

    expect(row.slug).toBe('people/alice');
  });

  test('searchKeyword finds codemap symbols indexed from frontmatter', async () => {
    await putPage('systems/llvm.md', {
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

    const results = await engine.searchKeyword('PassBuilder default pipeline');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.slug).toBe('systems/llvm.md');
    expect(results[0]?.chunk_source).toBe('frontmatter');
    expect(results[0]?.chunk_text).toContain('PassBuilder::buildPerModuleDefaultPipeline()');
  });

  test('searchKeyword avoids degrading C++ into a broad single-letter search', async () => {
    await putPage('systems/llvm.md', {
      type: 'system',
      title: 'LLVM',
      compiled_truth: 'Compiler infrastructure overview.',
      timeline: '',
      frontmatter: {
        language: ['C++'],
      },
    });
    await putPage('companies/builderco.md', {
      type: 'company',
      title: 'BuilderCo',
      compiled_truth: 'A company builder for new ventures.',
      timeline: '',
      frontmatter: {},
    });

    const results = await engine.searchKeyword('C++');
    expect(results.map(result => result.slug)).toEqual(['systems/llvm.md']);
  });

  test('searchKeyword matches symbol and path-heavy technical queries', async () => {
    await putPage('systems/llvm.md', {
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

    const results = await engine.searchKeyword(
      'PassBuilder::buildPerModuleDefaultPipeline() llvm/lib/Passes/PassBuilder.cpp',
    );
    expect(results.map(result => result.slug)).toEqual(['systems/llvm.md']);
  });
});

describe('SQLiteEngine migrations', () => {
  test('migration v5 resets stale SQLite embedding state', async () => {
    await putPage('concepts/legacy-vector.md', {
      type: 'concept',
      title: 'Legacy Vector',
      compiled_truth: 'Legacy vector content.',
      timeline: '',
      frontmatter: {},
    });
    await putChunks('concepts/legacy-vector.md', [
      {
        chunk_index: 0,
        chunk_text: 'Legacy vector content.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.1, 0.2]),
        model: 'legacy-model',
      },
    ]);

    const db = (engine as any).database as Database;
    db.run(`UPDATE config SET value = ? WHERE key = 'version'`, ['4']);
    db.run(`
      INSERT INTO config (key, value) VALUES ('embedding_model', 'legacy-model')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    db.run(`
      INSERT INTO config (key, value) VALUES ('embedding_dimensions', '384')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await engine.getConfig('embedding_model')).toBe('nomic-embed-text');
    expect(await engine.getConfig('embedding_dimensions')).toBe('768');

    const chunks = await engine.getChunks('concepts/legacy-vector.md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.model).toBe('nomic-embed-text');
    expect(chunks[0]?.embedding).toBeNull();
    expect(chunks[0]?.embedded_at).toBeNull();

    const row = db.query(`
      SELECT page_embedding
      FROM pages
      WHERE slug = 'concepts/legacy-vector.md'
    `).get() as { page_embedding: Uint8Array | null } | null;
    expect(row?.page_embedding).toBeNull();
  });

  test('migration v6 backfills searchable frontmatter beyond the first 100 pages', async () => {
    for (let index = 0; index < 150; index += 1) {
      await putPage(`systems/system-${index}.md`, {
        type: 'system',
        title: `System ${index}`,
        compiled_truth: `System ${index} overview.`,
        timeline: '',
        frontmatter: {
          codemap: [
            {
              system: `systems/system-${index}.md`,
              pointers: [
                {
                  path: `src/system-${index}.ts`,
                  symbol: `System${index}.run()`,
                  role: 'Entry point',
                  verified_at: '2026-04-16',
                },
              ],
            },
          ],
        },
      });
      await putChunks(`systems/system-${index}.md`, [
        {
          chunk_index: 0,
          chunk_text: `System ${index} overview.`,
          chunk_source: 'compiled_truth',
        },
      ]);
    }

    const db = (engine as any).database as Database;
    db.run(`UPDATE pages SET search_text = ''`);
    db.run(`UPDATE config SET value = ? WHERE key = 'version'`, ['5']);

    await engine.initSchema();

    const row = db.query(`
      SELECT search_text
      FROM pages
      WHERE slug = 'systems/system-149.md'
    `).get() as { search_text: string } | null;
    expect(row?.search_text).toContain('System149.run()');

    const chunks = await engine.getChunks('systems/system-149.md');
    expect(chunks.map(chunk => chunk.chunk_source)).toEqual(['compiled_truth', 'frontmatter']);

    const results = await engine.searchKeyword('System149.run');
    expect(results.map(result => result.slug)).toEqual(['systems/system-149.md']);
  });

  test('rerunning initSchema backfills missing page embeddings for migrated chunk vectors', async () => {
    await putPage('concepts/migrated-centroid.md', {
      type: 'concept',
      title: 'Migrated Centroid',
      compiled_truth: 'Migrated centroid page.',
      timeline: '',
      frontmatter: {},
    });
    await putChunks('concepts/migrated-centroid.md', [
      {
        chunk_index: 0,
        chunk_text: 'first centroid chunk',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([1, 0]),
      },
      {
        chunk_index: 1,
        chunk_text: 'second centroid chunk',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0, 1]),
      },
    ]);

    const db = (engine as any).database as Database;
    db.run(`UPDATE pages SET page_embedding = NULL WHERE slug = ?`, ['concepts/migrated-centroid.md']);
    db.run(`UPDATE config SET value = ? WHERE key = 'version'`, [String(LATEST_VERSION)]);

    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await engine.getPageEmbeddings('concept')).toContainEqual({
      page_id: expect.any(Number),
      slug: 'concepts/migrated-centroid.md',
      embedding: new Float32Array([0.5, 0.5]),
    });
  });
});
