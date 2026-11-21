/**
 * Engine parity for the brain identity reads that ran through `executeRaw` (`SELECT brain_id FROM persistence_brain
 * WHERE singleton=1`, some with `FOR UPDATE`) and now read the typed `readPersistenceBrainId` member: the topology
 * lock (persistence/topology-locks.ts), a rename-identity remedy's plan hash (sync-identity-downgrades.ts), and the
 * member's `lock` option the join and restore transactions use (shared-skills/membership.ts, shared-skills/restore.ts).
 *
 * Fail-first: case 1's Postgres probe fails on the base e3e04ef239 (the member took no `lock`, so the row stayed free
 * and `FOR UPDATE NOWAIT` from another connection succeeded). Case 2 fails first through the Rust tally row: on the
 * base the topology lock's raw identity read stopped on the raw_sql refusal, so the arm reported 0 cases equal to
 * PGLite against the pinned 2. Case 3 pins the SQL arms: its old raw read answered the same id there.
 * test/persistence-brain-id-callers.test.ts fails on the base for every moved file.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) `readPersistenceBrainId()` answers the brain's UUID, and `{ lock: true }` in a transaction answers the
 *    same UUID; on Postgres the locked read holds the singleton row until the transaction ends. (2) `withTopologyLocks`
 *    takes its host lock under the brain's id and runs on a source with no binding. (3) A rename-identity remedy's
 *    parts name the brain the member reads.
 *  - Regression: the reads were `executeRaw` calls; the Rust engine refuses raw SQL, so a topology change failed there
 *    and the remedy hash fell back to the brain id `host`.
 *  - Why existing coverage misses it: the topology, join, restore and rename-identity tests run on the SQL engines.
 *  - Seam: GBRAIN_HOME through withEnv (the topology lock file lives under it). Case 3 reads pages with raw SQL
 *    (remedySide), so it declares `requires: 'raw_sql'` and the Rust arm stops on that refusal.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { withTopologyLocks } from '../../src/core/persistence/topology-locks.ts';
import { identityRemedyParts, type IdentityDowngrade } from '../../src/core/sync-identity-downgrades.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function inFreshHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-brain-id-'));
  try { return await withEnv({ GBRAIN_HOME: home }, () => fn(home)); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

/** The SQLSTATE a statement ended on, or null when it ran. */
async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; } catch (error) { return String((error as { code?: unknown }).code ?? error); }
}

describe('the brain identity reads that moved to readPersistenceBrainId', () => {
  parityTest('the member answers the brain id, and a locked read in a transaction answers the same id', {
    methods: ['readPersistenceBrainId', 'transaction'],
  }, async (engine, backend) => {
    const plain = await engine.readPersistenceBrainId();
    const probe: { heldWhileLocked: string | null } = { heldWhileLocked: null };
    const locked = await engine.transaction(async (tx) => {
      const id = await tx.readPersistenceBrainId({ lock: true });
      // Postgres only: another pool connection cannot take the row while this transaction holds it.
      if (backend === 'postgres') {
        probe.heldWhileLocked = await sqlState(() => engine.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE NOWAIT'));
      }
      return id;
    });
    if (backend === 'postgres') {
      expect(probe.heldWhileLocked).toBe('55P03');
      expect(await sqlState(() => engine.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE NOWAIT'))).toBeNull();
    }
    const out = { uuid: UUID.test(String(plain)), lockedSameId: locked === plain };
    expect(out).toEqual({ uuid: true, lockedSameId: true });
    return out;
  });

  parityTest('the topology lock is taken under the brain id and runs a source with no binding', {
    methods: ['readPersistenceBrainId', 'getWorktreeBinding'],
  }, async (engine) => {
    const brainId = await engine.readPersistenceBrainId();
    const out = await inFreshHome(async (home) => withTopologyLocks(engine, 'default', async (bindings) => ({
      bindings: bindings.length,
      lockUnderBrainId: existsSync(join(home, '.gbrain', 'persistence', 'locks', `topology-${brainId}.lock`)),
    }), undefined, 0));
    expect(out).toEqual({ bindings: 0, lockUnderBrainId: true });
    return out;
  });

  parityTest('a rename-identity remedy names the brain the member reads', {
    methods: ['readPersistenceBrainId'], requires: 'raw_sql',
  }, async (engine) => {
    const record = { source_id: 'default', old_slug: 'notes/old-example', old_page_id: 2_000_000_001, new_slug: null,
      from: 'notes/old-example.md', to: 'notes/new-example.md', facts: 0, links: 0, aliases: 0,
      recorded_at: '2026-01-01T00:00:00.000Z', old_deleted_at: '2026-01-01 00:00:00+00' } as unknown as IdentityDowngrade;
    const parts = await identityRemedyParts(engine, record, 'close');
    const out = { namesBrain: parts.brain_id === await engine.readPersistenceBrainId(), old: parts.old, new: parts.new };
    expect(out).toEqual({ namesBrain: true, old: null, new: null });
    return out;
  });
});
