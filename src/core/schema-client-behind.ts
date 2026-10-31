/**
 * #7776: initSchema replays the binary's whole schema (CREATE OR REPLACE FUNCTION ...) before runMigrations. On a
 * database a newer gbrain migrated, an older binary's replay reinstalled its own superseded function bodies (the
 * writer-fence guards among them) and then applied nothing. Both engines call this before the replay: a schema version
 * above this binary's newest migration refuses with `client_behind`, so nothing in the schema runs. A database with no
 * config table or no version row (a fresh install) is not behind. Same rule as schema-missing-tables.ts's skip.
 */
import { opError, type OperationError } from './ops/contract.ts';
import { LATEST_SCHEMA_VERSION } from './schema-migrations/latest.generated.ts';

type Query = (sql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;

export function clientBehindError(version: number): OperationError {
  return opError('client_behind',
    `The brain schema is at v${version}, newer than this gbrain binary (v${LATEST_SCHEMA_VERSION}); schema setup refused before replaying this binary's schema, so nothing changed.`,
    'Upgrade gbrain on this host (gbrain upgrade) to the release that migrated the database or newer, then rerun the command; reads keep working on this binary meanwhile.',
    { fix: { argv: ['gbrain', 'upgrade'], consent: [], actor: 'host_admin', requires_exclusive: false,
      why: "An older binary's schema replay would reinstall superseded function bodies over the newer schema; a current binary replays matching ones.",
      verify: { argv: ['gbrain', 'doctor', '--only', 'schema_version', '--json'] } } });
}

/** Throws `client_behind` when the database's schema version is newer than this binary. */
// engine-sql-ok: a two-statement version probe both engines run on their DDL connection before the schema replay
export async function assertSchemaNotAhead(query: Query): Promise<void> {
  const [probe] = await query(`SELECT to_regclass('config') IS NOT NULL AS present`);
  if (!probe?.present) return;
  const [row] = await query(`SELECT value FROM config WHERE key = 'version'`);
  const version = parseInt(String(row?.value ?? '0'), 10);
  if (version > LATEST_SCHEMA_VERSION) throw clientBehindError(version);
}
