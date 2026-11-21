/**
 * Engine parity for a brain with no persistence identity: the four persistence callers that read the brain id through
 * `readBrainIdentity` (persistence/identity.ts) refuse `writer_not_initialized` with the doctor fix and write nothing.
 * Before 761280a028 each read `persistence_brain` with raw SQL and dereferenced the missing row: a TypeError on PGLite
 * and Postgres, the raw-SQL refusal on Rust.
 *
 * Fail-first on 761280a028^ (the raw reads): every case fails on the SQL arms. The topology lock, the clone and the
 * backup removal die with a TypeError (`brain.brain_id` of a missing row); the backup list returns an empty listing and
 * the reconcile state answers page_not_found, because both went on without the identity and dereference it only later
 * (a listed request's backup reference, the preview's pins), where they too die with a TypeError.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: with no persistence identity, `withTopologyLocks` (topology-locks.ts), `manageReconcileBackups`
 *    (reconcile-backup.ts), `readReconcileState` (reconcile-state.ts) and `runManagedSourceClone` (topology-clone.ts)
 *    refuse `writer_not_initialized` with a `gbrain doctor` fix, run nothing under their lock, create no lock file,
 *    clone directory, source or journal row.
 *  - Regression: a missing `persistence_brain` row turned into `TypeError: undefined is not an object`.
 *  - Why existing coverage misses it: every suite runs on a migrated brain, which always has the row.
 *  - Seams: the SQL arms delete the singleton row and put it back afterwards (the reset only updates it). A Rust store
 *    always has the identity it minted at creation, so on that arm the case calls the real member once, then answers
 *    what the Rust member answers for a store with none: `readPersistenceBrainId` (rust-engine/store-members/
 *    persistence-identity.ts) run against a store whose `getBrainIdentity()` rejects `writer_not_initialized`.
 *    `readReconcileState` first needs an active binding owned by this host; the case reads the real binding, then
 *    stands in an active one so the call reaches the identity read.
 *  - topology-clone.ts's own read (line 147, inside the clone transaction) runs only inside `withTopologyLocks`, which
 *    reads the identity first, so a missing row refuses there; nothing deletes the singleton row, so the inner read
 *    cannot see it missing. The clone case pins the caller's refusal through that path. Its first statement is raw SQL
 *    (the source lookup), so it declares `requires: 'raw_sql'` and the Rust arm stops on that refusal.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { WriteAuthority } from '../../src/core/persistence/model.ts';
import { hostIdFor } from '../../src/core/persistence/identity.ts';
import { withTopologyLocks } from '../../src/core/persistence/topology-locks.ts';
import { manageReconcileBackups } from '../../src/core/persistence/reconcile-backup.ts';
import { readReconcileState } from '../../src/core/persistence/reconcile-state.ts';
import { runManagedSourceClone } from '../../src/core/persistence/topology-clone.ts';
import { readPersistenceBrainId as rustReadPersistenceBrainId } from '../../src/core/rust-engine/store-members/persistence-identity.ts';
import type { StoreBrain } from '../../src/core/rust-engine/store.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUTHORITY = { version: 1, principal: { kind: 'local_cli', id: 'parity-writer' }, remote: false, sourceId: 'default' } as unknown as WriteAuthority;

/** A store that never minted an identity: `getBrainIdentity()` rejects as rust/crates/gbrain-store/src/journal.rs does. */
const STORE_WITHOUT_IDENTITY = {
  getBrainIdentity: () => Promise.reject(Object.assign(new Error('this brain has no persistence identity'), { code: 'writer_not_initialized' })),
} as unknown as StoreBrain;

/**
 * What the call ended on: the error code, whether it named the doctor fix, and whether it was a TypeError. A typed
 * capability refusal is rethrown so the Rust arm counts the stop (the in-test pin, harness.ts `rustStop`).
 */
async function refusal(run: () => Promise<unknown>): Promise<{ code: unknown; doctorFix: boolean; typeError: boolean } | 'ran'> {
  try { await run(); return 'ran'; } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'engine_capability_missing') throw error;
    const e = error as { code?: unknown; fix?: { argv?: unknown[] }; toJSON?: () => { fix?: { argv?: unknown[] } } };
    const fix = e.fix ?? e.toJSON?.().fix;
    return { code: e.code ?? null, doctorFix: Array.isArray(fix?.argv) && fix!.argv.includes('doctor'), typeError: error instanceof TypeError };
  }
}

/**
 * Runs `fn` on a brain with no persistence identity. SQL arms: the singleton row is deleted, then put back. Rust arm:
 * the real member answers the minted id once, then the engine answers as the Rust member does for a store without one.
 */
async function withoutIdentity<T>(engine: BrainEngine, backend: ParityBackend, fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  if (backend === 'rust') {
    expect(UUID.test(String(await engine.readPersistenceBrainId()))).toBe(true);
    const stub = new Proxy(engine, { get(target, key, receiver) {
      if (key === 'readPersistenceBrainId') return () => rustReadPersistenceBrainId(STORE_WITHOUT_IDENTITY);
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return fn(stub);
  }
  await engine.executeRaw('DELETE FROM persistence_brain WHERE singleton=1');
  try {
    expect(await engine.readPersistenceBrainId()).toBeNull();
    return await fn(engine);
  } finally {
    await engine.executeRaw('INSERT INTO persistence_brain(singleton) VALUES (1) ON CONFLICT DO NOTHING');
  }
}

async function inFreshHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-no-identity-'));
  try { return await withEnv({ GBRAIN_HOME: home }, () => fn(home)); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

/** A well-formed reference (`<request id>.<sha256>.json`), so the removal reaches its brain-scoped check. */
const BACKUP_REFERENCE = `00000000-0000-4000-8000-000000000004.${'a'.repeat(64)}.json`;
const REFUSED = { code: 'writer_not_initialized', doctorFix: true, typeError: false };

describe('a brain with no persistence identity refuses writer_not_initialized', () => {
  parityTest('the topology lock, the reconcile backups and the reconcile state refuse and write nothing', {
    methods: ['readPersistenceBrainId', 'getWorktreeBinding', 'listReservationsAfter'],
  }, async (engine, backend) => {
    const out = await inFreshHome(async (home) => withoutIdentity(engine, backend, async (e) => {
      let ranUnderLock = false;
      const topologyLocks = await refusal(() => withTopologyLocks(e, 'default', async () => { ranUnderLock = true; }, undefined, 0));
      const reconcileBackups = await refusal(() => manageReconcileBackups(e, AUTHORITY, 'notes/example', { action: 'list' }));
      const backupRemoval = await refusal(() => manageReconcileBackups(e, AUTHORITY, 'notes/example', { action: 'remove', backup_reference: BACKUP_REFERENCE }));
      const real = await e.getWorktreeBinding('default', hostIdFor(e));
      const bound = new Proxy(e, { get(target, key, receiver) {
        if (key === 'getWorktreeBinding') {
          return async (_sourceId: string, hostId: string | null) => ({ worktree_id: '00000000-0000-4000-8000-000000000001', source_id: 'default', source_incarnation: '00000000-0000-4000-8000-000000000002',
            relative_path: '', topology_generation: 1, owner_host_id: hostId, owner_epoch: 1, state: 'active', local_path: home,
            coordination_path: null, git_durability: null });
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const reconcileState = await refusal(() => readReconcileState(bound, 'default', 'notes/example'));
      return {
        topologyLocks, reconcileBackups, backupRemoval, reconcileState, ranUnderLock, realBinding: real,
        lockDir: existsSync(join(home, '.gbrain', 'persistence', 'locks')),
        backupDir: existsSync(join(home, '.gbrain', 'reconciliation-previews')),
        requests: (await e.listReservationsAfter('0', 100)).length,
      };
    }));
    expect(out).toEqual({
      topologyLocks: REFUSED, reconcileBackups: REFUSED, backupRemoval: REFUSED, reconcileState: REFUSED, ranUnderLock: false, realBinding: null,
      lockDir: false, backupDir: false, requests: 0,
    });
    return out;
  });

  parityTest('a managed clone refuses before it takes a lock, clones or registers the source', {
    methods: ['readPersistenceBrainId', 'readSourceMembership'], requires: 'raw_sql',
  }, async (engine, backend) => {
    const out = await inFreshHome(async (home) => withoutIdentity(engine, backend, async (e) => {
      const target = join(home, 'clone-example');
      const clone = await refusal(() => runManagedSourceClone(e, { operation: 'add', sourceId: 'clone-example', remoteUrl: 'https://example.com/clone-example.git',
        path: target }, 'local_cli:parity-writer', '00000000-0000-4000-8000-000000000003', {}));
      return { clone, cloned: existsSync(target), lockDir: existsSync(join(home, '.gbrain', 'persistence', 'locks')),
        source: await e.readSourceMembership('clone-example') };
    }));
    expect(out).toEqual({ clone: REFUSED, cloned: false, lockDir: false, source: null });
    return out;
  });
});
