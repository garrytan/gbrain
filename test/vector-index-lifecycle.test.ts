import { describe, expect, test } from 'bun:test';
import {
  chunkEmbeddingIndexSql,
  applyChunkEmbeddingIndexPolicy,
  PGVECTOR_HNSW_VECTOR_MAX_DIMS,
  checkActiveBuild,
  dropZombieIndexes,
  dropAndRebuild,
  isSupabaseAutoMaintenance,
  type ActiveBuildInfo,
  type IndexSpec,
} from '../src/core/vector-index.ts';

describe('chunkEmbeddingIndexSql — pre-v0.30.1 contract', () => {
  test('emits CREATE INDEX for dims ≤ 2000', () => {
    const sql = chunkEmbeddingIndexSql(1536);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_chunks_embedding');
    expect(sql).toContain('hnsw');
  });

  test('emits skip-comment for dims > 2000 (Voyage 3072)', () => {
    const sql = chunkEmbeddingIndexSql(3072);
    expect(sql).toContain('skipped');
    expect(sql).not.toContain('CREATE INDEX');
  });

  test('boundary at exactly PGVECTOR_HNSW_VECTOR_MAX_DIMS (2000)', () => {
    const at = chunkEmbeddingIndexSql(PGVECTOR_HNSW_VECTOR_MAX_DIMS);
    expect(at).toContain('CREATE INDEX');
    const above = chunkEmbeddingIndexSql(PGVECTOR_HNSW_VECTOR_MAX_DIMS + 1);
    expect(above).toContain('skipped');
  });
});

describe('applyChunkEmbeddingIndexPolicy', () => {
  test('replaces the canonical index SQL', () => {
    const input = `BEFORE\nCREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);\nAFTER`;
    const out = applyChunkEmbeddingIndexPolicy(input, 1536);
    expect(out).toContain('idx_chunks_embedding');
    const out2 = applyChunkEmbeddingIndexPolicy(input, 3072);
    expect(out2).toContain('skipped');
  });
});

describe('checkActiveBuild', () => {
  test('PGLite returns active: false', async () => {
    const fakeEngine = { kind: 'pglite' as const } as never;
    const r = await checkActiveBuild(fakeEngine, 'idx_chunks_embedding');
    expect(r.active).toBe(false);
  });

  test('Postgres with no active builds returns active: false', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [],
    } as never;
    const r = await checkActiveBuild(fakeEngine, 'idx_chunks_embedding');
    expect(r.active).toBe(false);
  });

  test('Postgres with an active build returns the row', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [
        { pid: 12345, query: 'CREATE INDEX CONCURRENTLY idx_chunks_embedding ON ...', application_name: 'gbrain' },
      ],
    } as never;
    const r = await checkActiveBuild(fakeEngine, 'idx_chunks_embedding');
    expect(r.active).toBe(true);
    expect(r.pid).toBe(12345);
    expect(r.application_name).toBe('gbrain');
  });

  test('query failure returns active: false (best-effort)', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => { throw new Error('permission denied'); },
    } as never;
    const r = await checkActiveBuild(fakeEngine, 'idx_chunks_embedding');
    expect(r.active).toBe(false);
  });
});

describe('isSupabaseAutoMaintenance', () => {
  test('true for application_name containing "supabase"', () => {
    expect(isSupabaseAutoMaintenance({ active: true, application_name: 'supabase-cron' })).toBe(true);
    expect(isSupabaseAutoMaintenance({ active: true, application_name: 'postgres-meta' })).toBe(true);
  });

  test('false for gbrain', () => {
    expect(isSupabaseAutoMaintenance({ active: true, application_name: 'gbrain-worker' })).toBe(false);
  });

  test('false when not active', () => {
    expect(isSupabaseAutoMaintenance({ active: false })).toBe(false);
  });
});

describe('dropZombieIndexes', () => {
  test('PGLite: no-op returns dropped: []', async () => {
    const fakeEngine = { kind: 'pglite' as const } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual([]);
  });

  test('Postgres: no zombies returns dropped: []', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [],
    } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual([]);
  });

  test('Postgres: drops invalid indexes, names them in result', async () => {
    let dropCalls = 0;
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes('pg_stat_activity')) return []; // no active builds
        if (sql.includes('pg_index')) {
          return [
            { indexname: 'zombie_idx_a', tablename: 'content_chunks' },
            { indexname: 'zombie_idx_b', tablename: 'pages' },
          ];
        }
        if (sql.startsWith('DROP INDEX')) {
          dropCalls++;
          return [];
        }
        return [];
      },
    } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual(['zombie_idx_a', 'zombie_idx_b']);
    expect(dropCalls).toBe(2);
  });

  test('Postgres: skips zombie when active build present', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes('pg_stat_activity')) {
          return [{ pid: 555, query: 'CREATE INDEX zombie_idx_a ...', application_name: 'gbrain' }];
        }
        if (sql.includes('pg_index')) {
          return [{ indexname: 'zombie_idx_a', tablename: 'content_chunks' }];
        }
        return [];
      },
    } as never;
    const r = await dropZombieIndexes(fakeEngine);
    expect(r.dropped).toEqual([]);
  });
});

describe('dropAndRebuild — A3 atomic-swap', () => {
  test('PGLite: no-op returns rebuilt: false', async () => {
    const fakeEngine = { kind: 'pglite' as const } as never;
    const spec: IndexSpec = {
      name: 'idx_chunks_embedding',
      table: 'content_chunks',
      column: 'embedding',
      using: 'hnsw (embedding vector_cosine_ops)',
    };
    const r = await dropAndRebuild(fakeEngine, spec, { reason: 'test' });
    expect(r.rebuilt).toBe(false);
  });

  test('Postgres: bails when active build present (without --force)', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes('pg_stat_activity')) {
          return [{ pid: 555, query: 'CREATE INDEX idx_chunks_embedding...', application_name: 'supabase' }];
        }
        return [];
      },
      withReservedConnection: async () => { throw new Error('should not be called'); },
      transaction: async () => { throw new Error('should not be called'); },
    } as never;
    const spec: IndexSpec = {
      name: 'idx_chunks_embedding',
      table: 'content_chunks',
      column: 'embedding',
      using: 'hnsw (embedding vector_cosine_ops)',
    };
    const r = await dropAndRebuild(fakeEngine, spec, { reason: 'auto' });
    expect(r.rebuilt).toBe(false);
  });

  test('temp name format: <name>_rebuild_<unix-ms>', async () => {
    let executedSql = '';
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [], // no active build
      withReservedConnection: async (fn: any) => fn({
        executeRaw: async (sql: string) => {
          executedSql = sql;
          return [];
        },
      }),
      transaction: async (fn: any) => {
        // Provide a no-op tx with sql.unsafe.
        await fn({ sql: { unsafe: async () => [] } });
      },
    } as never;
    const spec: IndexSpec = {
      name: 'idx_chunks_embedding',
      table: 'content_chunks',
      column: 'embedding',
      using: 'hnsw (embedding vector_cosine_ops)',
    };
    const r = await dropAndRebuild(fakeEngine, spec, { reason: 'test' });
    expect(r.rebuilt).toBe(true);
    expect(r.tempName).toMatch(/^idx_chunks_embedding_rebuild_\d+$/);
    expect(executedSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(executedSql).toContain(r.tempName);
  });
});
