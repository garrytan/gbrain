import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import type { SyncOpts, SyncResult } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const calls: SyncOpts[] = [];
const upToDateResult = (): SyncResult => ({
  status: 'up_to_date' as const,
  fromCommit: 'head',
  toCommit: 'head',
  added: 0,
  modified: 0,
  deleted: 0,
  renamed: 0,
  chunksCreated: 0,
  embedded: 0,
  pagesAffected: [] as string[],
});
let nextResult = upToDateResult();

mock.module('../src/commands/sync.ts', () => ({
  performSync: async (_engine: unknown, opts: SyncOpts) => {
    calls.push(opts);
    return nextResult;
  },
}));

const { operations } = await import('../src/core/operations.ts');

const noBacklogEngine = {
  executeRaw: async () => [{ missing: false }],
} as unknown as OperationContext['engine'];

function context(
  sourceId: string,
  engine: OperationContext['engine'] = noBacklogEngine,
): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console as OperationContext['logger'],
    dryRun: false,
    remote: false,
    sourceId,
  };
}

describe('sync_brain source routing', () => {
  beforeEach(() => {
    calls.length = 0;
    nextResult = upToDateResult();
  });

  test('explicit source_id overrides the ambient MCP source', async () => {
    const op = operations.find((candidate) => candidate.name === 'sync_brain');
    expect(op).toBeDefined();
    expect(op!.params.source_id).toBeDefined();

    await op!.handler(context('default'), {
      repo: '/tmp/devdocs-brain',
      source_id: 'devdocs-ops',
      no_pull: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sourceId).toBe('devdocs-ops');
  });

  test('ambient MCP source is threaded when source_id is omitted', async () => {
    const op = operations.find((candidate) => candidate.name === 'sync_brain');
    expect(op).toBeDefined();

    await op!.handler(context('devdocs-ops'), {
      repo: '/tmp/devdocs-brain',
      no_pull: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sourceId).toBe('devdocs-ops');
  });

  test('automatic large-sync deferral queues one source-scoped durable embed backfill', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      nextResult = {
        status: 'synced',
        fromCommit: 'before',
        toCommit: 'after',
        added: 101,
        modified: 0,
        deleted: 0,
        renamed: 0,
        chunksCreated: 101,
        embedded: 0,
        pagesAffected: ['systems/example'],
        embeddingDeferred: true,
      };

      const op = operations.find((candidate) => candidate.name === 'sync_brain');
      expect(op).toBeDefined();
      await op!.handler(context('default', engine), {
        repo: '/tmp/devdocs-brain',
        source_id: 'devdocs-ops',
        no_pull: true,
      });

      const jobs = await engine.executeRaw<{ name: string; source_id: string; reason: string }>(
        `SELECT name, data->>'sourceId' AS source_id, data->>'reason' AS reason
           FROM minion_jobs
          ORDER BY id`,
      );
      expect(jobs).toEqual([{
        name: 'embed-backfill',
        source_id: 'devdocs-ops',
        reason: 'sync_operation_deferred',
      }]);
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('up-to-date sync with missing embeddings queues one source-scoped durable embed backfill', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ('devdocs-ops', 'DevDocs Operations')
         ON CONFLICT (id) DO NOTHING`,
      );
      const pages = await engine.executeRaw<{ id: number }>(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
         VALUES ('devdocs-ops', 'systems/example', 'note', 'Example', 'body', '', '{}'::jsonb)
         RETURNING id`,
      );
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
         VALUES ($1, 0, 'unembedded body', 'compiled_truth')`,
        [pages[0]!.id],
      );

      const op = operations.find((candidate) => candidate.name === 'sync_brain');
      expect(op).toBeDefined();
      await op!.handler(context('default', engine), {
        repo: '/tmp/devdocs-brain',
        source_id: 'devdocs-ops',
        no_pull: true,
      });

      const jobs = await engine.executeRaw<{ name: string; source_id: string; reason: string }>(
        `SELECT name, data->>'sourceId' AS source_id, data->>'reason' AS reason
           FROM minion_jobs
          ORDER BY id`,
      );
      expect(jobs).toEqual([{
        name: 'embed-backfill',
        source_id: 'devdocs-ops',
        reason: 'sync_operation_backlog',
      }]);
    } finally {
      await engine.disconnect();
    }
  }, 30000);
});