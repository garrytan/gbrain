import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runBackfill, ensureBackfillIndex, clearBackfillCheckpoint } from '../src/core/backfill-base.ts';
import type { BackfillSpec } from '../src/core/backfill-base.ts';
import { getBackfill, listBackfills } from '../src/core/backfill-registry.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

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

/**
 * #5730: a write batch runs inside BEGIN on a reserved connection. Its
 * statements are buffered and applied only on COMMIT, like a real backend,
 * and `fail` injects one error per statement prefix.
 */
class TransactionalFakeEngine extends FakeEngine {
  fail = new Map<string, Error>();
  private pending: number[] | null = null;

  override async executeRaw<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const injected = [...this.fail.entries()].find(([prefix]) => sql.startsWith(prefix));
    if (injected) {
      this.fail.delete(injected[0]);
      throw injected[1];
    }
    if (sql === 'BEGIN' || sql === 'BEGIN READ WRITE') { this.pending = []; return []; }
    if (sql === 'ROLLBACK') { this.pending = null; return []; }
    if (sql === 'COMMIT') {
      for (const id of this.pending ?? []) await super.executeRaw(`UPDATE pages`, [id]);
      this.pending = null;
      return [];
    }
    if (sql.startsWith('UPDATE') && this.pending) { this.pending.push(params?.[0] as number); return []; }
    return super.executeRaw<T>(sql, params);
  }
}

const sqlError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('runBackfill — transaction failures (#5730)', () => {
  test('a failed ROLLBACK stops the run with a typed error naming both failures', async () => {
    const engine = new TransactionalFakeEngine();
    engine.rows = [{ id: 1, needs_backfill: true }];
    engine.fail.set('UPDATE', sqlError('23505', 'duplicate key value'));
    engine.fail.set('ROLLBACK', sqlError('08006', 'connection failure'));
    const error = await runBackfill(engine as never, makeSpec(), { batchSize: 10 }).catch(e => e);
    expect(error.name).toBe('BackfillRollbackError');
    expect(error.code).toBe('backfill_rollback_failed');
    expect(error.message).toContain('batch error: 23505 duplicate key value');
    expect(error.message).toContain('rollback error: 08006 connection failure');
    expect(error.fix).toBe('gbrain backfill test_backfill --resume');
    expect(engine.rows[0].needs_backfill).toBe(true);
    expect(engine.config.get('backfill.test_backfill.last_id')).toBeUndefined();
  });

  test('a failed SET LOCAL aborts the batch instead of running it in an aborted transaction', async () => {
    const engine = new TransactionalFakeEngine();
    engine.rows = [{ id: 1, needs_backfill: true }];
    engine.fail.set('SET LOCAL', sqlError('42501', 'permission denied to set parameter'));
    const error = await runBackfill(engine as never, makeSpec(), { batchSize: 10 }).catch(e => e);
    expect(error?.code).toBe('42501');
    expect(engine.rows[0].needs_backfill).toBe(true);
  });

  test('rows of a rolled-back batch are not counted as updated', async () => {
    const engine = new TransactionalFakeEngine();
    engine.rows = [{ id: 1, needs_backfill: true }, { id: 2, needs_backfill: true }];
    engine.fail.set('COMMIT', sqlError('57014', 'canceling statement due to statement timeout'));
    const result = await runBackfill(engine as never, makeSpec(), { batchSize: 10 });
    expect(result.errors).toBe(1);
    expect(result.updated).toBe(2);
    expect(engine.rows.every(r => !r.needs_backfill)).toBe(true);
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

describe('backfill registry', () => {
  test('listBackfills returns the canonical registry entries', () => {
    const names = listBackfills().map(e => e.spec.name).sort();
    expect(names).toEqual(['effective_date', 'embedding_voyage', 'emotional_weight', 'modality']);
  });

  test('embedding_voyage is declared-only', () => {
    expect(getBackfill('embedding_voyage')?.v030_1_status).toBe('declared-only');
  });
});

describe('implemented backfills against a freshly initialized PGLite brain', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  for (const name of ['effective_date', 'emotional_weight', 'modality']) {
    test(`${name} finds every column it reads and has no work on an empty brain`, async () => {
      const reg = getBackfill(name);
      expect(reg?.v030_1_status).toBe('implemented');
      const result = await runBackfill(engine, reg!.spec, { batchSize: 100 });
      expect(result.examined).toBe(0);
      expect(result.errors).toBe(0);
    });
  }
});
