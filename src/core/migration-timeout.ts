/**
 * #7108: the migration statement budget, and the last schema migration that
 * used it up, kept in config so `foresights apply-migrations` and `foresights doctor`
 * can name it and the next step that helps (migration-timeout-advice.ts).
 * Before this, both said "terminate blockers, rerun apply-migrations --yes",
 * which repeats the failure when the migration's own work outlasts the budget.
 *
 * runMigrations writes the record when a migration times out (SQLSTATE 57014,
 * or the retry wrapper exhausting its attempts on one) and deletes it after a
 * pass applies every pending migration. Readers use it only while the schema
 * is still below the recorded migration. A leaf of the schema import graph:
 * no release version here, so the test snapshot hash stays stable.
 */
import type { BrainEngine } from './engine.ts';

export const MIGRATION_TIMEOUT_KEY = 'schema_migration_timeout';

/** Statement budget for one migration transaction on Postgres; it overrides a lower server default (Supabase enforces about 2 minutes). */
const MIGRATION_STATEMENT_TIMEOUT_MS = 600_000;
let statementTimeoutMs = MIGRATION_STATEMENT_TIMEOUT_MS;

export function migrationStatementTimeoutMs(): number {
  return statementTimeoutMs;
}

/** `foresights apply-migrations --statement-timeout` (operator only, restored after the run; 0 removes the limit) and tests; null restores the default. */
export function setMigrationStatementTimeoutMs(ms: number | null): void {
  statementTimeoutMs = ms ?? MIGRATION_STATEMENT_TIMEOUT_MS;
}

export interface MigrationTimeoutRecord {
  version: number;
  name: string;
  /** Whether the run that timed out had a batched prelude for this migration (migration-preludes.ts). */
  batched: boolean;
  /** Idle-in-transaction sessions older than five minutes when the last attempt failed; they may or may not hold locks on the table. */
  idle_pids: number[];
  at: string;
}

/** Best effort: a failing database must not hide the migration error being reported. */
export async function recordMigrationTimeout(engine: BrainEngine, m: { version: number; name: string }, batched: boolean, idlePids: number[]): Promise<void> {
  const record: MigrationTimeoutRecord = { version: m.version, name: m.name, batched, idle_pids: idlePids, at: new Date().toISOString() };
  await engine.setConfig(MIGRATION_TIMEOUT_KEY, JSON.stringify(record)).catch(() => {});
}

export async function clearMigrationTimeout(engine: BrainEngine): Promise<void> {
  await engine.unsetConfig(MIGRATION_TIMEOUT_KEY).catch(() => {});
}

/** The recorded timeout when the schema is still below that migration; null otherwise or when unreadable. */
export async function readMigrationTimeout(engine: BrainEngine, schemaVersion: number): Promise<MigrationTimeoutRecord | null> {
  try {
    const record = JSON.parse((await engine.getConfig(MIGRATION_TIMEOUT_KEY)) ?? 'null') as MigrationTimeoutRecord | null;
    if (!record || !Number.isInteger(record.version) || record.version <= schemaVersion) return null;
    return { ...record, batched: record.batched === true, idle_pids: Array.isArray(record.idle_pids) ? record.idle_pids : [] };
  } catch {
    return null;
  }
}
