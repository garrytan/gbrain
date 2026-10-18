/**
 * #6482 (fix wave 15 P4.1): a `persistence_brain` read that returns no row,
 * two rows or a non-boolean `enabled` is an impossible state, not a mode. Every
 * mode reader goes through `readManagedMode` / `readPersistenceBrain` in
 * `persistence/ownership.ts`, which refuses `storage_error` (the
 * `automaticSyncPull` contract) instead of treating the brain as unmanaged.
 *
 * Fails on master: `managedPersistenceEnabled` returns false for `[]` and
 * `[{}]`, `assertUnmanagedCanonicalWriter` grants the legacy writer on the same
 * shapes, and `withConnectorSync` / `beginConnectorSync` take the unmanaged
 * path (and write the attempt checkpoint) on an empty read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SqlEngine } from '../src/core/persistence/model.ts';
import { managedPersistenceEnabled, readManagedMode, readPersistenceBrain } from '../src/core/persistence/ownership.ts';
import { inspectPersistenceBrain } from '../src/core/persistence/managed-mode.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { assertUnmanagedCanonicalWriter } from '../src/core/persistence/maintenance.ts';
import { beginConnectorSync, withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { renderCliError } from '../src/core/agent-output.ts';

const MALFORMED: ReadonlyArray<readonly [string, readonly unknown[]]> = [
  ['missing', []], ['empty row', [{}]], ['null row', [null]], ['string enabled', [{ enabled: 'yes' }]], ['null enabled', [{ enabled: null }]],
  ['numeric enabled', [{ enabled: 1 }]], ['duplicated', [{ enabled: false }, { enabled: true }]],
];

function fake(rows: readonly unknown[] | Error, seen: string[] = []): SqlEngine {
  return { executeRaw: async (sql: string) => { seen.push(sql); if (rows instanceof Error) throw rows; return rows as unknown[]; } } as unknown as SqlEngine;
}

describe('readManagedMode', () => {
  test('a well-formed row answers; only literal false selects unmanaged', async () => {
    expect(await readManagedMode(fake([{ enabled: false }]))).toBe(false);
    expect(await readManagedMode(fake([{ enabled: true }]))).toBe(true);
    expect(await managedPersistenceEnabled(fake([{ enabled: false }]))).toBe(false);
    expect(await managedPersistenceEnabled(fake([{ enabled: true }]))).toBe(true);
    expect(await readPersistenceBrain(fake([{ brain_id: 'b', enabled: true, mode_epoch: '3' }]))).toMatchObject({ brain_id: 'b', enabled: true, mode_epoch: '3' });
  });

  for (const [label, rows] of MALFORMED) {
    test(`${label} persistence metadata refuses storage_error from every shared reader`, async () => {
      await expect(readManagedMode(fake(rows))).rejects.toMatchObject({ code: 'storage_error', detail: 'persistence_mode_unknown' });
      await expect(managedPersistenceEnabled(fake(rows))).rejects.toMatchObject({ code: 'storage_error' });
      await expect(readPersistenceBrain(fake(rows))).rejects.toMatchObject({ code: 'storage_error' });
      await expect(assertUnmanagedCanonicalWriter(fake(rows), 'probe')).rejects.toMatchObject({ code: 'storage_error' });
    });
  }

  test('a query error propagates as itself, never as a mode', async () => {
    const boom = new Error('synthetic metadata unavailable');
    await expect(readManagedMode(fake(boom))).rejects.toBe(boom);
    await expect(managedPersistenceEnabled(fake(boom))).rejects.toBe(boom);
    await expect(assertUnmanagedCanonicalWriter(fake(boom), 'probe')).rejects.toBe(boom);
  });

  test('the lock option keeps FOR SHARE / FOR UPDATE on the statement; the plain text is the memoized one', async () => {
    const seen: string[] = [];
    await readManagedMode(fake([{ enabled: true }], seen));
    await readManagedMode(fake([{ enabled: true }], seen), { lock: 'share' });
    await readManagedMode(fake([{ enabled: true }], seen), { lock: 'update' });
    await readPersistenceBrain(fake([{ brain_id: 'b', enabled: false, mode_epoch: null }], seen), { lock: 'update' });
    expect(seen[0]).toBe('SELECT enabled FROM persistence_brain WHERE singleton=1');
    expect(seen[1]).toBe('SELECT enabled FROM persistence_brain WHERE singleton=1 FOR SHARE');
    expect(seen[2]).toBe('SELECT enabled FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    expect(seen[3]).toMatch(/^SELECT brain_id,enabled,[\s\S]*FROM persistence_brain WHERE singleton=1 FOR UPDATE$/);
  });

  test('the refusal renders the agent contract with the read-only probe and a doctor verify', async () => {
    const error = await readManagedMode(fake([])).catch((e: unknown) => e);
    const env = JSON.parse(renderCliError(error, { json: true, command: 'sync', tty: false }).stdout!);
    expect(env.code).toBe('storage_error');
    expect(env.why).toContain('persistence_brain singleton is missing');
    expect(env.fix).toMatchObject({ next: 'run', command: 'gbrain sources writer status --probe --json', consent: [], actor: 'agent', verify: { argv: ['gbrain', 'doctor', '--json'] } });
    const dup = await readManagedMode(fake([{ enabled: true }, { enabled: true }])).catch((e: unknown) => e) as { why: string };
    expect(dup.why).toContain('duplicated (2 row(s))');
  });

  test('the probe the refusal names (writer status) reports a malformed singleton instead of refusing on it', async () => {
    for (const [, rows] of MALFORMED) {
      const inspected = await inspectPersistenceBrain(fake(rows));
      expect(inspected.row).toBeNull();
      expect(inspected.problem).toContain('persistence_brain singleton is');
    }
    expect(await inspectPersistenceBrain(fake([{ brain_id: 'b', enabled: false, mode_epoch: '1', skill_bundles_enabled: null, writer_protocol_floor: null }])))
      .toEqual({ row: { brain_id: 'b', enabled: false, mode_epoch: '1', skill_bundles_enabled: null, writer_protocol_floor: null }, problem: null });
    const diagnostics = await readWriterDiagnostics({ ...fake([]), kind: 'pglite' } as unknown as BrainEngine);
    expect(diagnostics).toMatchObject({ enabled: false, brain_id: null });
    expect((diagnostics as { persistence_mode_problem?: string }).persistence_mode_problem).toContain('missing (0 row(s))');
  });
});

describe('connector entry paths on an impossible read', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  /** The real engine, except that the mode read answers `rows`; every statement after the mode read is recorded. */
  function misreading(rows: readonly unknown[]) {
    const after: string[] = [];
    let misread = false;
    const executeRaw = async (sql: string, params?: unknown[], opts?: unknown) => {
      if (misread) after.push(sql);
      if (sql.includes('FROM persistence_brain')) { misread = true; return rows as unknown[]; }
      return (engine.executeRaw as (s: string, p?: unknown[], o?: unknown) => Promise<unknown[]>).call(engine, sql, params, opts);
    };
    const transaction = async () => { after.push('BEGIN'); throw new Error('a transaction was opened after the impossible read'); };
    const wrapped = new Proxy(engine, { get(target, prop) {
      if (prop === 'executeRaw') return executeRaw;
      if (prop === 'transaction') return transaction;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as unknown as BrainEngine;
    return { wrapped, after };
  }
  const mutations = (after: string[]) => after.filter(sql => /^\s*(INSERT|UPDATE|DELETE|BEGIN)/i.test(sql));
  const checkpoints = () => engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM op_checkpoints').then(r => r[0].n);

  for (const [label, rows] of [['missing', []], ['empty row', [{}]], ['duplicated', [{ enabled: false }, { enabled: false }]]] as const) {
    test(`withConnectorSync refuses on a ${label} read with zero downstream writes`, async () => {
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('gh-6482', 'gh-6482', '{\"kind\":\"github\"}'::jsonb)");
      const before = await checkpoints();
      const { wrapped, after } = misreading(rows);
      let worked = false;
      await expect(withConnectorSync(wrapped, 'gh-6482', 'github', {}, {}, async () => { worked = true; return 'synced'; }))
        .rejects.toMatchObject({ code: 'storage_error', detail: 'persistence_mode_unknown' });
      expect(worked).toBe(false);
      expect(mutations(after)).toEqual([]);
      expect(await checkpoints()).toBe(before);
    });

    test(`beginConnectorSync refuses on a ${label} read instead of answering "unmanaged"`, async () => {
      const { wrapped, after } = misreading(rows);
      await expect(beginConnectorSync(wrapped, 'gh-6482', 'github', {}, {})).rejects.toMatchObject({ code: 'storage_error' });
      expect(mutations(after)).toEqual([]);
    });
  }

  test('a well-formed unmanaged row still takes the classic path and records the attempt', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('gh-6482', 'gh-6482', '{\"kind\":\"github\"}'::jsonb)");
    const before = await checkpoints();
    expect(await withConnectorSync(engine, 'gh-6482', 'github', {}, {}, async session => session === null ? 'classic' : 'managed')).toBe('classic');
    expect(await beginConnectorSync(engine, 'gh-6482', 'github', {}, {})).toBeNull();
    expect(await checkpoints()).toBe(before + 1);
  });
});
