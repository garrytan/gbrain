import { LATEST_SCHEMA_VERSION } from './schema-migrations/latest.generated.ts';

/** Refuse before any bootstrap, replay or drift repair can downgrade newer DDL. */
export function assertSupportedSchemaVersion(version: number): void {
  if (version > LATEST_SCHEMA_VERSION) {
    throw Object.assign(new Error(
      `client_behind: database schema v${version} is newer than this binary's v${LATEST_SCHEMA_VERSION}. Upgrade GBrain on this host before initializing or migrating this brain.`,
    ), { code: 'client_behind', version, latest: LATEST_SCHEMA_VERSION });
  }
}

/** Run on the schema-lock connection. Only an absent config table is a fresh install;
 * permission, transport and malformed-schema errors must not authorize DDL replay.
 * Keep this leaf independent of the migration registry for cold-start callers.
 */
export async function assertSchemaReplaySupported(query: (sql: string) => Promise<Record<string, unknown>[]>): Promise<void> {
  const [table] = await query("SELECT to_regclass('config')::text AS name");
  if (table?.name === null) return;
  const [row] = await query("SELECT value FROM config WHERE key = 'version'");
  assertSupportedSchemaVersion(parseInt(String(row?.value ?? '1'), 10));
}
