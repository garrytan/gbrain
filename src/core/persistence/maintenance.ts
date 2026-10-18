import { existsSync, lstatSync, realpathSync, renameSync } from 'node:fs';
import { flushDirectory } from '../fs-durable.ts';
import { dirname, join } from 'node:path';
import { acquireLock, releaseLock, type LockHandle } from '../pglite-lock.ts';
import { assertManagedFilesystemWrite } from './filesystem-guard.ts';
import { opError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import type { SqlEngine } from './model.ts';
import { readManagedMode } from './ownership.ts';
import { DEFAULT_TARGET_URL_ENV, planArgv } from './graduation-errors.ts';

// Every facts-family bulk writer now publishes through the coordinator on a
// managed brain (#5280); status and activation keep reporting the (empty) list.
export const UNSUPPORTED_MANAGED_BULK_WRITERS: readonly string[] = [];

export const ENGINE_MIGRATION_DOCS = 'docs/ENGINES.md#engine-migration-refused';
const GRADUATION_DOCS = 'docs/guides/move-to-postgres.md#move-the-brain';
const DOCTOR_VERIFY = { argv: ['gbrain', 'doctor', '--no-migrate', '--json'] };
type EngineKind = 'pglite' | 'postgres';
/** Which side of `gbrain migrate --to` a refusal names: the brain being moved, or the datastore it would land in. */
export interface EngineMigrationSide { side: 'source' | 'target'; from: EngineKind; to: EngineKind }

/**
 * The refusal's next step, by side. A PGLite brain moving up gets the user's
 * choice: wait for verified graduation, or stay on PGLite and share it over
 * MCP. A Postgres brain moving down keeps its datastore. A target that
 * already holds persistence state needs an empty database.
 */
function engineMigrationFix(m: EngineMigrationSide, why: string): Action {
  if (m.side === 'target') {
    return { argv: ['gbrain', 'migrate', '--to', m.to, ...(m.to === 'postgres' ? ['--url', '<empty_database_url>'] : ['--path', '<empty_brain_path>'])],
      inputs: [m.to === 'postgres'
        ? { name: 'empty_database_url', how: 'Ask the user for the connection string of an empty Postgres database (a new database or project).' }
        : { name: 'empty_brain_path', how: 'Ask the user for a path where no PGLite brain exists yet.' }],
      consent: [], actor: 'user', requires_exclusive: true, docs: ENGINE_MIGRATION_DOCS, verify: DOCTOR_VERIFY,
      why: `${why} The migration target already holds another brain's write history, so gbrain will not copy into it; the source brain is untouched.`,
      user_message: 'The database you chose to migrate into already holds another gbrain brain. Do you have an empty database to use instead? Nothing has changed in your current brain.' };
  }
  if (m.from === 'postgres') {
    return { consent: [], actor: 'agent', requires_exclusive: false, docs: ENGINE_MIGRATION_DOCS, verify: DOCTOR_VERIFY,
      why: `${why} Moving a Postgres brain with this history to PGLite would drop it, so the brain stays on Postgres; nothing changed.`,
      user_message: 'Your brain stays on Postgres: moving it to PGLite would lose its write history and withdrawn facts. Nothing changed.' };
  }
  return { argv: ['gbrain', 'config', 'unset', 'migrate.graduation'], consent: ['egress'], actor: 'agent', requires_exclusive: false,
    docs: GRADUATION_DOCS, verify: DOCTOR_VERIFY,
    why: `${why} The legacy copier cannot carry this history; graduation copies it intact and reaches this brain only while `
      + '`migrate.graduation` is not turned off. Turning it back on and previewing the plan changes nothing; the move itself runs only after the user approves that plan.',
    user_message: 'Your brain has write history, which the legacy copier cannot move. Graduation moves it with everything intact, and it is turned off on this machine: '
      + 'should I turn it back on and preview the move to Postgres (nothing changes yet), or keep the brain on PGLite and share it with `gbrain mcp expose`?',
    then: { argv: planArgv(), consent: [], actor: 'agent', requires_exclusive: false, docs: GRADUATION_DOCS,
      inputs: [{ name: DEFAULT_TARGET_URL_ENV, how: `Ask the user for the target Postgres connection string and export it as ${DEFAULT_TARGET_URL_ENV} in this shell; it never goes on the command line.` }],
      why: 'The read-only graduation plan: what moves, the blockers and the plan_hash the move is approved with. Nothing changes.' } };
}

/** Refuse unsupported multi-stage writers before providers, files or git change. */
export async function assertUnmanagedCanonicalWriter(engine: SqlEngine, operation: string, opts: { migration?: EngineMigrationSide } = {}): Promise<void> {
  if (!await readManagedMode(engine)) return;
  const message = `${operation} cannot mutate a managed brain through the legacy writer.`;
  const why = 'This brain is managed: every write goes through its writer coordinator, which the legacy writer bypasses.';
  if (opts.migration) {
    throw opError('writer_coordinator_required', message,
      'Keep this datastore; the engine copier cannot carry a managed brain. Ask the user how to proceed.',
      { why, reason: 'managed_brain', docs: ENGINE_MIGRATION_DOCS, fix: engineMigrationFix(opts.migration, why) });
  }
  throw opError('writer_coordinator_required', message,
    `Run the same gbrain command again: it routes a managed brain through the coordinator, and the brain became managed while ${operation} ran.`,
    { why, reason: 'managed_brain', fix: { consent: [], actor: 'agent', requires_exclusive: false, verify: DOCTOR_VERIFY,
      why: `${why} Each gbrain command that changes sources or imports content takes the coordinated path on a managed brain, so the same command run again uses it; nothing was written.`,
      user_message: `gbrain stopped ${operation} because your brain switched to managed writes while it ran. Nothing was written; running the same command again uses the managed path.` } });
}

/** The legacy engine copier cannot transfer permanent IDs, withdrawals, ownership or the belief ledger. */
export async function assertLegacyEngineMigration(engine: SqlEngine, migration: EngineMigrationSide = { side: 'source', from: 'pglite', to: 'postgres' }): Promise<void> {
  const tables = ['belief_events', 'persistence_requests', 'fact_withdrawals', 'persistence_worktrees'] as const;
  // Older migration sources can predate these tables. Do not interpret any
  // other database failure as an empty history.
  const present = await engine.executeRaw<{ name: string }>(
    'SELECT name FROM unnest($1::text[]) AS t(name) WHERE to_regclass(name) IS NOT NULL', [tables]);
  const held: string[] = [];
  for (const table of tables) {
    if (!present.some(row => row.name === table)) continue;
    const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM ${table}) AS present`);
    if (row?.present) held.push(table);
  }
  if (!held.length && migration.side === 'source') await assertNoPageHistory(engine, migration);
  if (!held.length) return;
  const ledger = held.includes('belief_events') ? ' The belief ledger (belief_events) is recorded history no Markdown rebuild can recover.' : '';
  const why = `The ${migration.side === 'source' ? 'brain' : 'target datastore'} has rows in ${held.join(', ')}, and the engine copier cannot carry request IDs, withdrawals, canonical ownership or the belief ledger.${ledger}`;
  throw opError('writer_coordinator_required',
    'Engine migration cannot discard durable write history, withdrawal protection, canonical ownership, or the belief ledger.',
    migration.side === 'target' ? 'Choose an empty target database; the source brain is unchanged.'
      : 'Keep this datastore; nothing changed. Ask the user how to proceed.',
    { why, reason: 'persistence_history', docs: ENGINE_MIGRATION_DOCS, fix: engineMigrationFix(migration, why) });
}

/**
 * The legacy copier re-creates pages with new ids and copies no page versions, so a brain with versions would arrive
 * without its page history. It refuses instead and names how many versions it would discard; graduation carries them.
 */
async function assertNoPageHistory(engine: SqlEngine, migration: EngineMigrationSide): Promise<void> {
  const [row] = await engine.executeRaw<{ n: number | null }>(
    "SELECT CASE WHEN to_regclass('page_versions') IS NULL THEN 0 ELSE (SELECT count(*)::int FROM page_versions) END AS n");
  const versions = Number(row?.n ?? 0);
  if (!versions) return;
  const why = `The brain has ${versions} page version${versions === 1 ? '' : 's'} (the history get_versions and page-at-time reads), and the engine copier re-creates pages without them, so the copy would discard all ${versions}.`;
  throw opError('writer_coordinator_required',
    `Engine migration would discard ${versions} page version${versions === 1 ? '' : 's'}.`,
    'Keep this datastore; nothing changed. Ask the user how to proceed.',
    { why, reason: 'page_history', docs: ENGINE_MIGRATION_DOCS, fix: engineMigrationFix(migration, why) });
}

/** Legacy reinit may rename only after acquiring the stable sibling kernel lock. */
export async function backupUnmanagedPglite(dataDir: string, backupDir: string): Promise<void> {
  assertManagedFilesystemWrite(dataDir);
  if (!existsSync(dataDir) || existsSync(backupDir)) throw new Error('PGLite backup paths changed; inspect before retrying.');
  const lock = await acquireLock(dataDir, { timeoutMs: 0 });
  try {
    assertManagedFilesystemWrite(dataDir);
    if (existsSync(backupDir)) throw new Error('PGLite backup already exists; inspect before retrying.');
    renameSync(dataDir, backupDir);
    // Metadata moved with the old datastore. Remove only this ticket's marker;
    // release still targets the original stable sibling native lock.
    lock.lockDir = join(backupDir, '.gbrain-lock');
  } finally { await releaseLock(lock); }
}

/**
 * Engine graduation: rename a PGLite datastore while this process already
 * holds its stable sibling kernel lock (`backupUnmanagedPglite` acquires it
 * itself, which fails while it is held). The lock is never released here; its
 * metadata dir is retargeted to follow the moved datastore. Used for the
 * step-7 move-aside and the rollback move-back.
 */
export function moveHeldPglite(fromDir: string, toDir: string, lock: LockHandle): void {
  if (!lock.acquired || !lock.nativeLock || lock.nativeLock.released) throw new Error('Moving a PGLite datastore requires its held kernel lock.');
  assertManagedFilesystemWrite(fromDir);
  assertManagedFilesystemWrite(toDir);
  if (!lstatSync(fromDir).isDirectory()) throw new Error(`${fromDir} is not a PGLite data directory (symlinked datastores are not moved).`);
  if (lock.lockDir !== join(realpathSync(fromDir), '.gbrain-lock')) throw new Error(`The held kernel lock does not belong to ${fromDir}.`);
  if (existsSync(toDir)) throw new Error(`${toDir} already exists; inspect before retrying.`);
  renameSync(fromDir, toDir);
  lock.lockDir = join(toDir, '.gbrain-lock');
  if (lock.lockPath) lock.lockPath = join(lock.lockDir, 'lock');
  flushDirectory(dirname(toDir));
}
