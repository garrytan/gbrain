/**
 * GBRA-133 PR 1 item 4 (classifier hardening), classic sync.
 *
 * S-65/S-70: the item classifier and the retry matchers read "connection closed", "ECONNRESET" and friends from any
 * error's message, so an unexpected per-file error whose message quotes a path such as notes/connection closed.md was
 * a lost connection: the run stopped with no ledger row on every rerun. The run scope now comes from the error's code
 * (SQLSTATE class 08, socket errnos, the driver's connection codes) and connection text is read only from an uncoded
 * message naming no path.
 *
 * S-67: the rename reconcile turned any throw into a hard-blocking `<rename:…>` marker that --skip-failed cannot pass.
 * Its own "staleness unprovable" verdict and transient database errors keep the marker (a later run converges); any
 * other throw holds the rename as rename_reconcile_failed with its class and code, and the source keeps syncing.
 *
 * PGLite here; Postgres through test/e2e/s-70-classifier-origin-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { classifyItemFailure } from '../../src/core/item-failure.ts';
import { isConnectionLoss, isRetryableConnError } from '../../src/core/retry-matcher.ts';
import { gitHoldItem, readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { loadSyncFailures } from '../../src/core/sync-failure-ledger.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';
import { md, withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('S-70 connection scope comes from the error, never a quoted path', () => {
  test('an uncoded error quoting a path is the item\'s; driver errors and coded errors still stop the run', () => {
    expect(classifyItemFailure(new Error('import failed for notes/connection closed.md')).scope).toBe('item');
    expect(classifyItemFailure(new TypeError("Cannot read properties of undefined (reading 'x') in notes/econnreset.md")).scope).toBe('item');
    expect(classifyItemFailure(new Error('read ECONNRESET')).scope).toBe('run');
    expect(classifyItemFailure(coded('ECONNRESET', 'read failed on /var/run/socket')).scope).toBe('run');
    expect(classifyItemFailure(coded('CONNECTION_CLOSED', 'write CONNECTION_CLOSED db.example.invalid:5432')).scope).toBe('run');
    expect(classifyItemFailure(coded('08006', 'Connection terminated unexpectedly')).scope).toBe('run');
    expect(classifyItemFailure(coded('ETIMEDOUT', 'spawnSync git ETIMEDOUT')).scope).toBe('item');
  });

  test('the retry matchers ignore a quoted path but keep driver text, connection strings and connection codes', () => {
    for (const fn of [isRetryableConnError, isConnectionLoss]) {
      expect(fn(new Error('cannot import notes/connection closed.md'))).toBe(false);
      expect(fn(new Error('cannot import notes\\ECONNRESET.md'))).toBe(false);
      expect(fn(new Error('Connection terminated unexpectedly'))).toBe(true);
      expect(fn(new Error('connection closed by postgresql://db.example.invalid:5432/brain'))).toBe(true);
      expect(fn(coded('ECONNRESET', 'read failed on /var/run/socket'))).toBe(true);
    }
  });
});

/** The engine whose page reads inside a file's import throw `error` for `slug` (no production seam). */
function failingImport(engine: BrainEngine, slug: string, error: () => unknown): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (prop === 'getPage' && typeof value === 'function') {
      return (...args: unknown[]) => new Error().stack?.includes('importOnePath') && args[0] === slug ? Promise.reject(error()) : (value as Function).apply(target, args);
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}

/** The engine whose old-row lookup inside the rename reconcile throws `error`. */
function failingReconcile(engine: BrainEngine, error: () => unknown): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (prop === 'executeRaw' && typeof value === 'function') {
      return (sql: string, params?: unknown[]) => /SELECT slug, source_path FROM pages/.test(sql) && new Error().stack?.includes('reconcileRenameFallback')
        ? Promise.reject(error()) : (value as Function).call(target, sql, params);
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}

const syncWith = (r: ProbeRepo, engine: BrainEngine) => performSync(engine, { repoPath: r.root, sourceId: r.sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
const live = async (r: ProbeRepo, slug: string): Promise<number | null> => (await r.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [r.sourceId, slug]))[0]?.id ?? null;
const ledger = (r: ProbeRepo) => loadSyncFailures().filter(f => f.source_id === r.sourceId).map(f => ({ path: f.path, state: f.state }));

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`S-70/S-67 classic sync (${backend})`, () => {
    test('S-70 item: an unexpected import error quoting notes/connection closed.md is a ledger row, the siblings import, and it auto-skips on run 3', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      expect((await r.sync()).status).toBe('first_sync');
      r.write('notes/connection closed.md', md('odd')); r.write('ok/healthy-1.md', md('healthy one')); r.commitAll('odd');
      const failing = failingImport(engine, 'notes/connection-closed', () => new Error('unexpected failure while importing notes/connection closed.md'));
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push((await expectUnitNotAborted(() => syncWith(r, failing))).status);
      expect({ runs, ledger: ledger(r), healthy: await live(r, 'ok/healthy-1') !== null, cursor: await r.lastCommit() === r.head() })
        .toEqual({ runs: ['blocked_by_failures', 'blocked_by_failures', 'synced'], ledger: [{ path: 'notes/connection closed.md', state: 'auto_skipped' }], healthy: true, cursor: true });
    })), 180_000);

    test('S-70 run: a coded lost connection while importing still stops the run with no ledger row', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      expect((await r.sync()).status).toBe('first_sync');
      const before = await r.lastCommit();
      r.write('notes/plain.md', md('plain')); r.commitAll('plain');
      // Postgres reconnects and retries a lost connection on a fresh pool (outside this proxy), so the run may also recover;
      // either way the lost connection is never charged to the file.
      let thrown: string | null = null;
      try { await syncWith(r, failingImport(engine, 'notes/plain', () => coded('08006', 'Connection terminated unexpectedly'))); } catch (error) { thrown = (error as Error).message; }
      const cursor = await r.lastCommit();
      expect({ ledger: ledger(r), outcome: thrown === null ? { recovered: cursor === r.head() } : { thrown, cursorKept: cursor === before } })
        .toEqual({ ledger: [], outcome: thrown === null ? { recovered: true } : { thrown: 'Connection terminated unexpectedly', cursorKept: true } });
      if (backend === 'pglite') expect(thrown).toBe('Connection terminated unexpectedly');
    })), 180_000);

    const renameOntoLivePage = async (r: ProbeRepo) => {
      r.write('people/carol.md', md('Carol')); r.commitAll('carol');
      expect((await r.sync()).status).toBe('first_sync');
      await r.engine.putPage('people/dana', { type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug' }, { sourceId: r.sourceId });
      r.git('mv', 'people/carol.md', 'people/dana.md'); r.write('ok/healthy-1.md', md('healthy one')); r.commitAll('rename');
    };

    test('S-67 item: an unexpected throw in the rename reconcile holds the rename (class and code only) instead of a blocking marker', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      await renameOntoLivePage(r);
      const result = await expectUnitNotAborted(() => syncWith(r, failingReconcile(engine, () => new TypeError("Cannot read properties of undefined (reading 'slug') for people/carol.md"))));
      const hold = ((await readGitSourceHolds(engine, { sourceIds: [r.sourceId] }))[0]?.holds ?? []).find(h => h.path === 'people/dana.md');
      expect({ status: result.status, cursor: await r.lastCommit() === r.head(), ledger: ledger(r), code: hold?.code, healthy: await live(r, 'ok/healthy-1') !== null, carol: await live(r, 'people/carol') !== null })
        .toEqual({ status: 'synced', cursor: true, ledger: [], code: 'rename_reconcile_failed', healthy: true, carol: true });
      expect(hold!.message).toContain('(TypeError)');
      expect(hold!.message).not.toContain('Cannot read');
      const fix = gitHoldItem(hold!).fix;
      expect({ actor: fix.actor, argv: fix.argv }).toEqual({ actor: 'user', argv: ['gbrain', 'sync', '--source', r.sourceId, '--full', '--no-pull'] });
      r.write('ok/healthy-2.md', md('healthy two')); r.commitAll('later');
      await expectUnitNotAborted(() => r.sync());
      expect({ cursor: await r.lastCommit() === r.head(), healthy: await live(r, 'ok/healthy-2') !== null }).toEqual({ cursor: true, healthy: true });
    })), 180_000);

    test('S-67 run: a transient database error in the reconcile keeps the <rename:…> marker, and the next run converges', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      await renameOntoLivePage(r);
      const result = await expectUnitNotAborted(() => syncWith(r, failingReconcile(engine, () => coded('57014', 'canceling statement due to statement timeout'))));
      expect({ status: result.status, marker: ledger(r).some(row => row.path.startsWith('<rename:')) }).toEqual({ status: 'blocked_by_failures', marker: true });
      await expectUnitNotAborted(() => r.sync());
      expect({ cursor: await r.lastCommit() === r.head(), carol: await live(r, 'people/carol'), markers: ledger(r).filter(row => row.path.startsWith('<rename:') && row.state === 'open') })
        .toEqual({ cursor: true, carol: null, markers: [] });
    })), 180_000);
  });
}

