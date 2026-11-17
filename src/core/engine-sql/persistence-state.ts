/**
 * Persistence state reads: one SQL implementation for both engines (GBRA-import-path).
 *
 * The write guards that run on every direct import read three things here: whether the
 * brain is managed (`persistence_brain`), whether a source is git-canonical (`sources`),
 * and the local writer registration the maintenance attribution names
 * (`persistence_brain`, `persistence_local_writers`). The statements are the text the
 * callers sent through `executeRaw` before; interpretation (the `storage_error` refusal for
 * a malformed singleton, the permission checks on a writer row) stays with the callers in
 * `src/core/persistence/`. A caller running on a transaction engine reads on that
 * transaction.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

/** The plain managed-mode statement. `group-publish.ts` memoizes this exact text, so every plain reader sends it unchanged. */
export const MANAGED_MODE_SQL = 'SELECT enabled FROM persistence_brain WHERE singleton=1';
/** The same read as a scalar subquery (a JSON array of `{enabled}` rows) for a statement that folds it into other work. */
export const MANAGED_MODE_ROWS_JSON_SQL = `(SELECT COALESCE(json_agg(json_build_object('enabled', b.enabled)), '[]'::json) FROM persistence_brain b WHERE b.singleton = 1)`;

/** `MANAGED_MODE_ROWS_JSON_SQL` as constant fragment text, for a statement that folds the managed-mode rows into other work. */
export const managedModeRowsJson = trustedSql(MANAGED_MODE_ROWS_JSON_SQL);

/** A local writer's grant: the sources, operations, scopes and slug prefixes its credential may use. */
export interface LocalGrant { sourceIds: string[]; operations: string[] | null; scopes: string[]; slugPrefixes: string[] | null; }
/** One `persistence_local_writers` row as the registration and verification checks read it. */
export interface LocalWriterRow { lane: string; credential_hash: string; grant_ceiling: LocalGrant; revoked_at: unknown }
/** A local writer registration to insert; `credentialHash` is the sha256 of the credential and `grant` its ceiling. */
export interface LocalWriterInsert { id: string; lane: string; credentialHash: string; grant: LocalGrant }

/** The `persistence_brain` singleton rows' `enabled` values, as stored: callers refuse anything but exactly one boolean. */
export async function readManagedModeRows(exec: LegacyUnscopedRead): Promise<Array<{ enabled: unknown }>> {
  return exec.executeRaw<{ enabled: unknown }>(MANAGED_MODE_SQL);
}

/** True when the source's `config.canonical` is `git` (a strict source); false for any other value and for an unknown source. */
export async function getSourceStrictness(exec: LegacyUnscopedRead, sourceId: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ strict: boolean }>(`SELECT COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1`, [sourceId]);
  return row?.strict === true;
}

/** The persistence identity (`brain_id`), or null when the schema has no `persistence_brain` row. */
export async function readPersistenceBrainId(exec: LegacyUnscopedRead): Promise<string | null> {
  const [brain] = await exec.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  return brain ? brain.brain_id : null;
}

/** The registration row of a local writer, or undefined; `lock` appends `FOR SHARE` so a revocation waits for the reader. */
export async function readLocalWriterRow(exec: LegacyUnscopedRead, id: string, opts: { lock?: boolean } = {}): Promise<LocalWriterRow | undefined> {
  const { rows: [row] } = await exec.run<LocalWriterRow>(
    sqlFragment`SELECT lane,credential_hash,grant_ceiling,revoked_at FROM persistence_local_writers WHERE id=${id}::uuid${opts.lock ? trustedSql(' FOR SHARE') : sqlFragment``}`);
  return row;
}

/** Inserts a local writer registration unless one conflicts on its id or credential hash; true when this call inserted it. */
export async function insertLocalWriterRow(exec: SqlExecutor, row: LocalWriterInsert): Promise<boolean> {
  const inserted = await exec.executeRaw<{ id: string }>(`INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling)
    VALUES($1::uuid,$2,$3,$4::text::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [row.id, row.lane, row.credentialHash, JSON.stringify(row.grant)]);
  return inserted.length > 0;
}
