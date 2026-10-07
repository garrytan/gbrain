/**
 * Orchestration lock for `gbrain apply-migrations` (#5693).
 *
 * Exactly one runner orchestrates a brain's migrations at a time. The runner
 * acquires this lock before it mutates the migration ledger and holds it
 * through its final status; a second runner refuses with the holder's host
 * and pid instead of re-running every orchestrator in parallel.
 *
 * Postgres: a renewable TTL lease row in `gbrain_cycle_locks` (db-lock.ts),
 * which survives transaction-mode poolers and reuses its dead-holder
 * takeover rules. A schema without that table has no lease yet; the runner
 * then relies on the initSchema lock and acquires the lease once the table
 * exists. An unreachable database has nothing to coordinate.
 *
 * PGLite: a native kernel lock on a sibling file keyed by the canonical
 * datastore path, never the datastore's own lock, so the holder's
 * orchestrators still open the datastore. The kernel releases it when the
 * holder dies, so a dead holder is taken over by the next runner.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { GBrainConfig } from './config.ts';
import { toEngineConfig } from './config.ts';
import { createEngine } from './engine-factory.ts';
import type { BrainEngine } from './engine.ts';
import { inspectLock, tryAcquireDbLock } from './db-lock.ts';
import { getPgliteMigrationLockPath } from './pglite-lock.ts';
import { tryAcquireNativeLock } from './persistence/native-lock.ts';

export const MIGRATION_ORCHESTRATION_LOCK_ID = 'gbrain-apply-migrations';
export { MIGRATIONS_RUNNING_EXIT_CODE } from './exit-codes.ts';
// Long enough to outlast a synchronous orchestrator phase (subprocess timeouts
// reach 30 minutes) that starves the refresh timer; ownership is rechecked
// before every orchestrator.
const LEASE_TTL_MINUTES = 60;
const LEASE_REFRESH_MS = 60_000;

export interface MigrationLockHolder {
  host: string | null;
  pid: number | null;
}

export class MigrationsRunningError extends Error {
  readonly code = 'migrations_running';
  constructor(readonly holder: MigrationLockHolder) {
    super(formatMigrationsRunning(holder));
    this.name = 'MigrationsRunningError';
  }
}

/** Which part of this runner's own lease row no longer matches its fence; values only, never the token itself. */
export interface MigrationLeaseLostDetails {
  holder_pid: number;
  holder_host: string;
  token_match: boolean;
  fence_match: boolean;
  expected_fence: string;
  observed_acquired_at: string;
}

/**
 * #6028 diagnostic: the fenced refresh of this runner's lease matched no row,
 * yet the row still names this process. No other runner holds it, so this is
 * not `migrations_running`. The refresh goes through the direct pool and the
 * holder read through the main pool; a mismatch can mean the two reach
 * different databases, or the row was rewritten. Root cause pending (#6028).
 */
export class MigrationLeaseLostError extends Error {
  readonly code = 'migration_lease_lost';
  constructor(readonly details: MigrationLeaseLostDetails) {
    super(`this apply-migrations run's own migration lease (pid ${details.holder_pid}, host ${details.holder_host}) no longer matches its fence `
      + `(acquisition token ${details.token_match ? 'matches' : 'differs'}, acquisition time ${details.fence_match ? 'matches' : 'differs'}); stopped before the next migration.`);
    this.name = 'MigrationLeaseLostError';
  }
}

export interface MigrationOrchestrationLock {
  /** Postgres lease acquisition token; quiescence checks exclude this runner's own row by it. */
  leaseToken?: string;
  /** Throws MigrationsRunningError when the lease was lost to another runner, MigrationLeaseLostError when the row still names this one. */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export function formatMigrationsRunning(holder: MigrationLockHolder | null): string {
  return `another apply-migrations is running (host ${holder?.host ?? 'unknown'}, pid ${holder?.pid ?? 'unknown'}). `
    + 'Wait for it to finish; `gbrain doctor` shows migration progress. '
    + 'See docs/guides/write-refusals.md#migrations_running';
}

function metadataPath(lockPath: string): string {
  return lockPath.replace(/\.lock$/, '.json');
}

function readPgliteHolder(lockPath: string): MigrationLockHolder | null {
  try {
    const metadata = JSON.parse(readFileSync(metadataPath(lockPath), 'utf8')) as { host?: string; pid?: number };
    return { host: metadata.host ?? null, pid: metadata.pid ?? null };
  } catch {
    return null;
  }
}

/** A schema too old for the lease: no table, or one without the acquisition-token columns. */
function isMissingLockSchema(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e?.code === '42P01' || e?.code === '42703' || /(gbrain_cycle_locks|column).*does not exist/i.test(e?.message ?? '');
}

async function acquirePglite(dataDir: string): Promise<MigrationOrchestrationLock> {
  const lockPath = getPgliteMigrationLockPath(dataDir);
  const native = await tryAcquireNativeLock(lockPath);
  if (!native) throw new MigrationsRunningError(readPgliteHolder(lockPath) ?? { host: null, pid: null });
  writeFileSync(metadataPath(lockPath), JSON.stringify({ pid: process.pid, host: hostname(), acquired_at: new Date().toISOString() }), { mode: 0o600 });
  return {
    assertHeld: async () => {},
    release: async () => {
      if (readPgliteHolder(lockPath)?.pid === process.pid) {
        try { rmSync(metadataPath(lockPath), { force: true }); } catch { /* diagnostic metadata only */ }
      }
      await native.release();
    },
  };
}

async function acquirePostgres(config: GBrainConfig): Promise<MigrationOrchestrationLock | null> {
  const engine: BrainEngine = await createEngine(toEngineConfig(config));
  try {
    await engine.connect(toEngineConfig(config));
  } catch {
    // Unreachable database: no database writes can happen, and the runner's
    // preflight reports it. Filesystem-only phases run as before.
    return null;
  }
  let handle;
  try {
    handle = await tryAcquireDbLock(engine, MIGRATION_ORCHESTRATION_LOCK_ID, LEASE_TTL_MINUTES);
  } catch (error) {
    await engine.disconnect();
    if (isMissingLockSchema(error)) return null;
    throw error;
  }
  if (!handle) {
    const snapshot = await inspectLock(engine, MIGRATION_ORCHESTRATION_LOCK_ID).catch(() => null);
    await engine.disconnect();
    throw new MigrationsRunningError({ host: snapshot?.holder_host ?? null, pid: snapshot?.holder_pid ?? null });
  }
  const timer = setInterval(() => {
    handle.refresh().then((owned) => {
      if (!owned) console.error('[apply-migrations] orchestration lease was lost; stopping before the next migration.');
    }).catch(() => { /* transient; the TTL is the backstop */ });
  }, LEASE_REFRESH_MS);
  timer.unref?.();
  return {
    leaseToken: handle.acquisitionToken,
    assertHeld: async () => {
      if (await handle.refresh()) return;
      const snapshot = await inspectLock(engine, MIGRATION_ORCHESTRATION_LOCK_ID).catch(() => null);
      if (snapshot?.holder_pid === process.pid && snapshot.holder_host === hostname()) {
        throw new MigrationLeaseLostError({
          holder_pid: snapshot.holder_pid,
          holder_host: snapshot.holder_host,
          token_match: snapshot.acquisition_token === handle.acquisitionToken,
          fence_match: Math.abs(Number(handle.acquiredAt) * 1000 - new Date(snapshot.acquired_at).getTime()) < 1,
          expected_fence: handle.acquiredAt,
          observed_acquired_at: new Date(snapshot.acquired_at).toISOString(),
        });
      }
      throw new MigrationsRunningError({ host: snapshot?.holder_host ?? null, pid: snapshot?.holder_pid ?? null });
    },
    release: async () => {
      clearInterval(timer);
      try { await handle.release(); } finally { await engine.disconnect(); }
    },
  };
}

/**
 * Acquire the orchestration lock or throw MigrationsRunningError. Returns
 * null only on Postgres when the database is unreachable or
 * `gbrain_cycle_locks` does not exist yet; the runner retries before it
 * starts orchestrators.
 */
export async function acquireMigrationOrchestrationLock(config: GBrainConfig): Promise<MigrationOrchestrationLock | null> {
  if (config.engine === 'pglite') {
    if (!config.database_path) return { assertHeld: async () => {}, release: async () => {} };
    return acquirePglite(config.database_path);
  }
  return acquirePostgres(config);
}

/** Best-effort holder lookup for callers that only saw the runner's exit status. */
export async function readMigrationLockHolder(config: GBrainConfig): Promise<MigrationLockHolder | null> {
  try {
    if (config.engine === 'pglite') {
      return config.database_path ? readPgliteHolder(getPgliteMigrationLockPath(config.database_path)) : null;
    }
    const engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    try {
      const snapshot = await inspectLock(engine, MIGRATION_ORCHESTRATION_LOCK_ID);
      return snapshot ? { host: snapshot.holder_host, pid: snapshot.holder_pid } : null;
    } finally {
      await engine.disconnect();
    }
  } catch {
    return null;
  }
}
