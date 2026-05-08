import { describe, expect, test } from 'bun:test';
import { runBackfill, ensureBackfillIndex, clearBackfillCheckpoint } from '../src/core/backfill-base.ts';
import type { BackfillSpec } from '../src/core/backfill-base.ts';

interface FakeRow {
  id: number;
  needs_backfill: boolean;
}

class FakeEngine {
  readonly kind = 'postgres' as const;
  rows: FakeRow[] = [];
  config = new Map<string, string>();
  reservedCalls = 0;
  errorOnSelect: Error | null = null;
  computedCallCount = 0;

  // Just enough surface for runBackfill: executeRaw, withReservedConnection,
  // setConfig, batchLoadEmotionalInputs.
  async executeRaw<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    if (this.errorOnSelect && /^SELECT/.test(sql)) throw this.errorOnSelect;
    // DELETE branch checked BEFORE the broader SELECT-FROM-config branch
    // because the SELECT substring would otherwise swallow it.
    if (sql.includes('DELETE FROM config WHERE key')) {
      const key = (params?.[0] as string) ?? '';
      this.config.delete(key);
      return [] as T[];
    }
    if (sql.includes('FROM config WHERE key')) {
      const key = (params?.[0] as string) ?? '';
      const value = this.config.get(key);
      return (value !== undefined ? [{ value }] : []) as T[];
    }
    if (sql.includes('FROM pages')) {
      const lastId = (params?.[0] as number) ?? 0;
      const limit = (params?.[1] as number) ?? 100;
      const matching = this.rows
        .filter(r => r.id > lastId && r.needs_backfill)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      return matching as unknown as T[];
    }
    if (sql.startsWith('UPDATE')) {
      const id = params?.[0] as number;
      const row = this.rows.find(r => r.id === id);
      if (row) row.needs_backfill = false;
      return [] as T[];
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [] as T[];
    if (sql.startsWith('SET LOCAL')) return [] as T[];
    if (sql.includes('pg_indexes')) return [{ exists: true }] as T[];
    return [] as T[];
  }

  async withReservedConnection<T>(fn: (c: { executeRaw: typeof FakeEngine.prototype.executeRaw }) => Promise<T>): Promise<T> {
    this.reservedCalls++;
    return fn({ executeRaw: this.executeRaw.bind(this) });
  }

  async setConfig(key: string, value: string): Promise<void> {
    this.config.set(key, value);
  }
}

function makeSpec(): BackfillSpec<FakeRow> {
  return {
    name: 'test_backfill',
    table: 'pages',
    selectColumns: ['needs_backfill'],
    needsBackfill: 'needs_backfill = true',
    compute: async (rows) => rows.map(r => ({ id: r.id, updates: { needs_backfill: false } })),
  };
}

describe('runBackfill — happy path', () => {
  test('walks all rows, calls compute, persists checkpoint', async () => {
    const engine = new FakeEngine();
    engine.rows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, needs_backfill: true }));
    const result = await runBackfill(engine as never, makeSpec(), { batchSize: 10 });
    expect(result.examined).toBe(25);
    expect(result.updated).toBe(25);
    expect(result.errors).toBe(0);
    expect(result.lastId).toBe(25);
    expect(engine.config.get('backfill.test_backfill.last_id')).toBe('25');
  });

  test('dry-run does not write, does not advance checkpoint', async () => {
    const engine = new FakeEngine();
    engine.rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, needs_backfill: true }));
    const result = await runBackfill(engine as never, makeSpec(), { dryRun: true });
    expect(result.examined).toBe(5);
    expect(result.updated).toBe(0);
    expect(engine.config.get('backfill.test_backfill.last_id')).toBeUndefined();
  });

  test('resume picks up from checkpoint', async () => {
    const engine = new FakeEngine();
    engine.rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, needs_backfill: true }));
    engine.config.set('backfill.test_backfill.last_id', '20');
    const result = await runBackfill(engine as never, makeSpec(), { batchSize: 50 });
    expect(result.examined).toBe(10); // only ids > 20
    expect(result.updated).toBe(10);
  });

  test('fresh ignores checkpoint', async () => {
    const engine = new FakeEngine();
    engine.rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, needs_backfill: true }));
    engine.config.set('backfill.test_backfill.last_id', '50');
    const result = await runBackfill(engine as never, makeSpec(), { fresh: true });
    expect(result.examined).toBe(10); // all rows touched
  });

  test('maxRows caps the run', async () => {
    const engine = new FakeEngine();
    engine.rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, needs_backfill: true }));
    const result = await runBackfill(engine as never, makeSpec(), { maxRows: 25, batchSize: 10 });
    expect(result.cappedByMaxRows).toBe(true);
    expect(result.examined).toBeLessThanOrEqual(30); // batchSize 10 may slightly exceed 25
  });

  test('writes go through withReservedConnection (T3 pinned-backend)', async () => {
    const engine = new FakeEngine();
    engine.rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, needs_backfill: true }));
    await runBackfill(engine as never, makeSpec(), { batchSize: 10 });
    // Two batches → 2 reserved-connection acquisitions.
    expect(engine.reservedCalls).toBe(2);
  });
});

describe('runBackfill — error handling', () => {
  test('non-retryable error during SELECT throws', async () => {
    const engine = new FakeEngine();
    engine.rows = [{ id: 1, needs_backfill: true }];
    engine.errorOnSelect = Object.assign(new Error('foreign key violation'), { code: '23503' });
    await expect(runBackfill(engine as never, makeSpec(), { batchSize: 10 })).rejects.toThrow();
  });

  test('returns done with no rows when no work to do', async () => {
    const engine = new FakeEngine();
    engine.rows = [{ id: 1, needs_backfill: false }]; // already done
    const result = await runBackfill(engine as never, makeSpec(), { batchSize: 10 });
    expect(result.examined).toBe(0);
    expect(result.updated).toBe(0);
  });
});

describe('clearBackfillCheckpoint', () => {
  test('removes the config key', async () => {
    const engine = new FakeEngine();
    engine.config.set('backfill.test_backfill.last_id', '99');
    await clearBackfillCheckpoint(engine as never, 'test_backfill');
    expect(engine.config.get('backfill.test_backfill.last_id')).toBeUndefined();
  });
});

describe('ensureBackfillIndex — P2/X4', () => {
  test('returns existed: true when index already present', async () => {
    const engine = new FakeEngine();
    const spec: BackfillSpec<FakeRow> = {
      ...makeSpec(),
      requiredIndex: { name: 'test_idx', sql: 'CREATE INDEX test_idx ON pages(id)' },
    };
    const result = await ensureBackfillIndex(engine as never, spec);
    expect(result.existed).toBe(true);
    expect(result.created).toBe(false);
  });

  test('returns existed: true on PGLite (no CONCURRENTLY)', async () => {
    const engine = { kind: 'pglite' as const } as unknown as Parameters<typeof ensureBackfillIndex<FakeRow>>[0];
    const spec: BackfillSpec<FakeRow> = {
      ...makeSpec(),
      requiredIndex: { name: 'test_idx', sql: 'CREATE INDEX test_idx ON pages(id)' },
    };
    const result = await ensureBackfillIndex<FakeRow>(engine, spec);
    expect(result.existed).toBe(true);
    expect(result.created).toBe(false);
  });
});
