/**
 * v0.18.0 Step 7 — file_migration_ledger state-machine unit tests.
 *
 * No real storage — we stub a StorageBackend that records every
 * call so we can assert the crash-point recovery semantics without
 * touching S3/Supabase.
 */

import { describe, test, expect } from 'bun:test';
import { runStorageBackfill } from '../src/commands/migrations/v0_18_0-storage-backfill.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { StorageBackend } from '../src/core/storage.ts';

interface StubLedgerRow {
  file_id: number;
  storage_path_old: string;
  storage_path_new: string;
  status: 'pending' | 'copy_done' | 'db_updated' | 'complete' | 'failed';
  error?: string | null;
}

function makeEngine(initial: StubLedgerRow[]): { engine: BrainEngine; rows: StubLedgerRow[]; filePaths: Map<number, string> } {
  const rows: StubLedgerRow[] = initial.map(r => ({ ...r }));
  const filePaths = new Map<number, string>(); // file_id → current storage_path

  const executeRaw = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    const up = sql.trim().toUpperCase();
    // Read ledger
    if (up.startsWith('SELECT FILE_ID')) {
      return rows.map(r => ({ ...r })) as unknown as T[];
    }
    // UPDATE ledger SET status = 'copy_done'
    if (sql.includes("SET status = 'copy_done'")) {
      const row = rows.find(r => r.file_id === params?.[0]);
      if (row) row.status = 'copy_done';
      return [];
    }
    if (sql.includes("SET status = 'db_updated'")) {
      const row = rows.find(r => r.file_id === params?.[0]);
      if (row) row.status = 'db_updated';
      return [];
    }
    if (sql.includes("SET status = 'complete'")) {
      const row = rows.find(r => r.file_id === params?.[0]);
      if (row) row.status = 'complete';
      return [];
    }
    if (sql.includes('SET status = $1') && sql.includes("'failed'")) {
      // Older form with parametric status
      return [];
    }
    if (sql.includes("SET status = 'failed'")) {
      const row = rows.find(r => r.file_id === params?.[1]);
      if (row) { row.status = 'failed'; row.error = params?.[0] as string; }
      return [];
    }
    // UPDATE files SET storage_path = $1 WHERE id = $2
    if (up.startsWith('UPDATE FILES')) {
      filePaths.set(params?.[1] as number, params?.[0] as string);
      return [];
    }
    return [];
  };

  const engine = { kind: 'postgres' as const, executeRaw } as unknown as BrainEngine;
  return { engine, rows, filePaths };
}

function makeStorage(): { storage: StorageBackend; calls: string[] } {
  const calls: string[] = [];
  const uploaded = new Set<string>();
  const storage: StorageBackend = {
    upload: async (path: string) => { calls.push(`upload:${path}`); uploaded.add(path); },
    download: async (path: string) => { calls.push(`download:${path}`); return Buffer.from('content-for:' + path); },
    delete: async (path: string) => { calls.push(`delete:${path}`); uploaded.delete(path); },
    exists: async (path: string) => { calls.push(`exists:${path}`); return uploaded.has(path); },
    list: async () => [],
    getUrl: async (p) => `https://test/${p}`,
  };
  return { storage, calls };
}

describe('runStorageBackfill — happy path', () => {
  test('advances pending → copy_done → db_updated → complete', async () => {
    const { engine, rows, filePaths } = makeEngine([
      { file_id: 1, storage_path_old: 'slug/foo.pdf', storage_path_new: 'default/slug/foo.pdf', status: 'pending' },
    ]);
    const { storage, calls } = makeStorage();

    const report = await runStorageBackfill(engine, storage);

    expect(report.total).toBe(1);
    expect(report.nowComplete).toBe(1);
    expect(report.failed).toBe(0);
    expect(rows[0].status).toBe('complete');
    expect(filePaths.get(1)).toBe('default/slug/foo.pdf');
    // Storage operations: exists-check then download + upload (no delete yet,
    // old objects preserved for soak window).
    expect(calls.filter(c => c.startsWith('download:'))).toEqual(['download:slug/foo.pdf']);
    expect(calls.filter(c => c.startsWith('upload:'))).toEqual(['upload:default/slug/foo.pdf']);
    expect(calls.filter(c => c.startsWith('delete:'))).toEqual([]);
  });
});

describe('runStorageBackfill — crash-point recovery (per Codex second pass)', () => {
  test('resumes from copy_done (crash AFTER copy, BEFORE DB update)', async () => {
    const { engine, rows, filePaths } = makeEngine([
      { file_id: 1, storage_path_old: 'slug/a.pdf', storage_path_new: 'default/slug/a.pdf', status: 'copy_done' },
    ]);
    const { storage, calls } = makeStorage();

    const report = await runStorageBackfill(engine, storage);

    expect(report.nowComplete).toBe(1);
    expect(rows[0].status).toBe('complete');
    expect(filePaths.get(1)).toBe('default/slug/a.pdf');
    // Should NOT re-download/re-upload — already in copy_done state.
    expect(calls.filter(c => c.startsWith('download:'))).toEqual([]);
    expect(calls.filter(c => c.startsWith('upload:'))).toEqual([]);
  });

  test('resumes from db_updated (crash AFTER DB update, BEFORE ledger mark)', async () => {
    const { engine, rows } = makeEngine([
      { file_id: 1, storage_path_old: 'slug/b.pdf', storage_path_new: 'default/slug/b.pdf', status: 'db_updated' },
    ]);
    const { storage, calls } = makeStorage();

    const report = await runStorageBackfill(engine, storage);

    expect(report.nowComplete).toBe(1);
    expect(rows[0].status).toBe('complete');
    // No copy, no db update — only the final mark.
    expect(calls).toEqual([]);
  });

  test('already-complete rows are skipped without storage calls', async () => {
    const { engine, rows } = makeEngine([
      { file_id: 1, storage_path_old: 'x', storage_path_new: 'default/x', status: 'complete' },
    ]);
    const { storage, calls } = makeStorage();

    const report = await runStorageBackfill(engine, storage);

    expect(report.alreadyComplete).toBe(1);
    expect(report.nowComplete).toBe(0);
    expect(rows[0].status).toBe('complete');
    expect(calls).toEqual([]);
  });

  test('failed rows stay failed and do NOT auto-retry', async () => {
    const { engine, rows } = makeEngine([
      { file_id: 1, storage_path_old: 'x', storage_path_new: 'default/x', status: 'failed', error: 'previous failure' },
    ]);
    const { storage, calls } = makeStorage();

    const report = await runStorageBackfill(engine, storage);

    expect(report.failed).toBe(1);
    expect(report.nowComplete).toBe(0);
    expect(rows[0].status).toBe('failed');
    expect(calls).toEqual([]);
  });
});

describe('runStorageBackfill — idempotence + dry-run', () => {
  test('upload already-exists check skips redundant upload on re-run', async () => {
    const { engine } = makeEngine([
      { file_id: 1, storage_path_old: 'x', storage_path_new: 'default/x', status: 'pending' },
    ]);
    const { storage, calls } = makeStorage();
    // Mark the new path as already existing (simulates a prior partial run
    // where upload landed but ledger didn't get updated).
    await storage.upload('default/x', Buffer.from('x'));
    calls.length = 0;

    await runStorageBackfill(engine, storage);

    // Exists check ran, but no new download or upload since the
    // destination already has the object.
    expect(calls.some(c => c === 'exists:default/x')).toBe(true);
    expect(calls.some(c => c.startsWith('download:'))).toBe(false);
    expect(calls.some(c => c.startsWith('upload:'))).toBe(false);
  });

  test('dry-run mode reports skipped count, does not mutate', async () => {
    const { engine, rows } = makeEngine([
      { file_id: 1, storage_path_old: 'x', storage_path_new: 'default/x', status: 'pending' },
      { file_id: 2, storage_path_old: 'y', storage_path_new: 'default/y', status: 'pending' },
    ]);

    const report = await runStorageBackfill(engine, null, { dryRun: true });

    expect(report.total).toBe(2);
    expect(report.skipped).toBe(2);
    expect(report.nowComplete).toBe(0);
    // Rows still pending.
    expect(rows.every(r => r.status === 'pending')).toBe(true);
  });

  test('re-running a completed ledger is a no-op with zero side effects', async () => {
    const { engine } = makeEngine([
      { file_id: 1, storage_path_old: 'x', storage_path_new: 'default/x', status: 'complete' },
      { file_id: 2, storage_path_old: 'y', storage_path_new: 'default/y', status: 'complete' },
    ]);
    const { storage, calls } = makeStorage();

    const report = await runStorageBackfill(engine, storage);

    expect(report.alreadyComplete).toBe(2);
    expect(report.nowComplete).toBe(0);
    expect(calls).toEqual([]);
  });
});
