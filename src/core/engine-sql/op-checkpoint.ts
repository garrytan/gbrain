/**
 * The writes of a resumable op's checkpoint (op-checkpoint.ts): replace the parent's completed keys, append child
 * paths, delete the parent (its paths go with it by the `ON DELETE CASCADE` foreign key), delete the paths, and the
 * seven-day purge of stale checkpoints (`purgeStaleCheckpoints`, on `executeRaw` as op-checkpoint.ts ran it; its text is
 * the constant in ../op-checkpoint-purge-sql.ts, built from the op-name constants it exempts). The read
 * is `readOpCheckpointKeys` (write-misc.ts). Each statement keeps the text op-checkpoint.ts ran and runs on
 * `executeRawDirect`, the direct session pool on Postgres (#1794), so PGLite and Postgres answer exactly as before; a
 * Rust brain answers from its store (rust/crates/gbrain-store/src/persistence/op_checkpoint.rs,
 * rust/docs/store/persistence.md "Op checkpoints").
 */
import type { BrainEngine } from '../engine.ts';
import { PURGE_STALE_CHECKPOINTS_SQL } from '../op-checkpoint-purge-sql.ts';
import { FENCE_UNCOMMITTED_OP } from '../fence-repair/uncommitted-op.ts';

type Direct = Pick<BrainEngine, 'executeRawDirect'>;
type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * Single writable-CTE statement (one round-trip): ensure the parent
 * op_checkpoints row exists (FK target) and bump its updated_at so the 7-day
 * purge tracks activity, then INSERT the delta child rows. `ON CONFLICT DO
 * NOTHING` makes re-appending an already-banked path a no-op. $3 binds a JS
 * string[] to a Postgres text[] (NOT a jsonb param), which postgres.js + PGLite
 * both handle natively — so it sidesteps executeRawJsonb's array rejection.
 */
const APPEND_PATHS_SQL = `WITH parent AS (
  INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
  VALUES ($1, $2, '[]'::jsonb, now())
  ON CONFLICT (op, fingerprint) DO UPDATE SET updated_at = now()
)
INSERT INTO op_checkpoint_paths (op, fingerprint, path)
SELECT $1, $2, unnest($3::text[])
ON CONFLICT (op, fingerprint, path) DO NOTHING`;

/**
 * Replaces the parent's `completed_keys` with `keys` (the caller sorts them) and stamps it now. The child paths stay.
 * #2339: bind through `$3::text::jsonb`, NOT `$3::jsonb`. Under postgres.js `.unsafe(sql, params)` (executeRawDirect's
 * path) a JS string bound to a `$N::jsonb` param double-encodes into a jsonb string scalar, which fails the v119
 * `op_checkpoints_completed_keys_array CHECK (jsonb_typeof = 'array')`. Casting through `text` first parses it into a
 * genuine jsonb array (the positional form of the CLAUDE.md double-encode trap).
 */
export async function writeOpCheckpointKeys(direct: Direct, op: string, fingerprint: string, keys: string[]): Promise<void> {
  await direct.executeRawDirect(
    `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ($1, $2, $3::text::jsonb, now())
       ON CONFLICT (op, fingerprint) DO UPDATE
         SET completed_keys = EXCLUDED.completed_keys,
             updated_at     = now()`,
    [op, fingerprint, JSON.stringify(keys)],
  );
}

/**
 * Replaces a checkpoint parent's JSON records and stamps it now, or with `null` deletes the parent (its paths go with it
 * by the foreign key). Unlike the statements above it runs on `executeRaw`, so it joins the caller's transaction: the
 * preview-approval clear runs inside the legacy-job cancel's transaction (minions/legacy-cancel.ts).
 */
export async function writeOpCheckpointRecord(exec: Pick<BrainEngine, 'executeRaw'>, op: string, fingerprint: string,
  completedKeys: readonly unknown[] | null): Promise<void> {
  if (completedKeys === null) {
    await exec.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [op, fingerprint]);
    return;
  }
  await exec.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [op, fingerprint, JSON.stringify(completedKeys)]);
}

/** Creates the parent with no keys or stamps it now, then adds each path not yet banked; one statement. */
export async function appendOpCheckpointPaths(direct: Direct, op: string, fingerprint: string, paths: string[]): Promise<void> {
  await direct.executeRawDirect(APPEND_PATHS_SQL, [op, fingerprint, paths]);
}

/** Deletes the parent; the foreign key's `ON DELETE CASCADE` deletes its paths. A missing row is a no-op. */
export async function deleteOpCheckpoint(direct: Direct, op: string, fingerprint: string): Promise<void> {
  await direct.executeRawDirect(
    `DELETE FROM op_checkpoints WHERE op = $1 AND fingerprint = $2`,
    [op, fingerprint],
  );
}

/** Deletes the paths only: op-checkpoint.ts's belt-and-suspenders sweep for paths whose parent was somehow absent. */
export async function deleteOpCheckpointPaths(direct: Direct, op: string, fingerprint: string): Promise<void> {
  await direct.executeRawDirect(
    `DELETE FROM op_checkpoint_paths WHERE op = $1 AND fingerprint = $2`,
    [op, fingerprint],
  );
}

/**
 * The first element of each named parent's completed keys (`completed_keys->0`, NULL for an empty array), one row per
 * parent found, in no stated order. The sync import provenance read (persistence/sync-holds.ts
 * readSyncImportProvenances) keeps one record per page this way. Runs on the engine's own `executeRaw`, so a caller
 * inside `transaction()` reads its own writes; the text is the statement sync-holds.ts ran, byte for byte.
 */
export async function readOpCheckpointRecords(raw: Raw, op: string, fingerprints: readonly string[]): Promise<unknown[]> {
  if (!fingerprints.length) return [];
  const rows = await raw.executeRaw<{ record: unknown }>('SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint = ANY($2::text[])',
    [op, [...fingerprints]]);
  return rows.map(row => row.record);
}

/**
 * The rows of `op` whose first record names `previewHash` (`completed_keys->0->>'preview_hash'`), by fingerprint in byte
 * order: the finished resolutions recovery-resolve.ts `readResolutions` replays. Moved from that caller unchanged.
 */
export async function listPreviewHashCheckpoints(raw: Raw, op: string, previewHash: string): Promise<Array<{ completed_keys: unknown[] }>> {
  return raw.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'preview_hash'=$2 ORDER BY fingerprint COLLATE \"C\"",
    [op, previewHash]);
}

/**
 * Each row's parent replaced with the one-element array `[record]`, stamped now; the child paths stay. The caller
 * passes each fingerprint once (sync-holds.ts recordSyncImportProvenances keeps the last value for a page). One
 * statement; `$2` binds through `::text::jsonb`, never `::jsonb` (CLAUDE.md, the positional double-encode trap).
 */
export async function writeOpCheckpointRecords(raw: Raw, op: string, rows: ReadonlyArray<{ fingerprint: string; record: unknown }>): Promise<void> {
  if (!rows.length) return;
  await raw.executeRaw(WRITE_OP_CHECKPOINT_RECORDS_SQL, [op, JSON.stringify(rows.map(({ fingerprint, record }) => ({ fingerprint, record })))]);
}
/** The one statement `writeOpCheckpointRecords` sends (op_checkpoints only): the shadow write sampler judges the member by it (shadow/write-capture.ts). */
export const WRITE_OP_CHECKPOINT_RECORDS_SQL = `INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
    SELECT $1, entry->>'fingerprint', jsonb_build_array(entry->'record') FROM jsonb_array_elements($2::text::jsonb) AS entry
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`;

/**
 * Deletes the checkpoints whose stamp is older than `ttlDays` days and that no exemption holds, and returns how many
 * it deleted; the `op_checkpoint_paths` foreign key (`ON DELETE CASCADE`) drops their paths. The exemptions are listed
 * at op-checkpoint.ts `purgeStaleCheckpoints`, the caller, which turns a failure into 0.
 */
export async function purgeStaleCheckpoints(raw: Raw, ttlDays: number): Promise<number> {
  const rows = await raw.executeRaw<{ count: string | number }>(PURGE_STALE_CHECKPOINTS_SQL, [String(ttlDays)]);
  return Number(rows[0]?.count ?? 0);
}

/**
 * The applied-capture records (`ingest_applied_captures`) older than `ttlDays` days deleted; how many. The dream
 * cycle's bookkeeping purge (ingestion/applied-captures.ts purgeStaleAppliedCaptures), beside the checkpoint purge.
 */
export async function purgeStaleAppliedCaptures(raw: Raw, ttlDays: number): Promise<number> {
  const rows = await raw.executeRaw<{ count: string | number }>(
    `WITH deleted AS (
       DELETE FROM ingest_applied_captures WHERE applied_at < now() - ($1 || ' days')::interval RETURNING 1
     )
     SELECT count(*)::text AS count FROM deleted`,
    [String(ttlDays)]);
  return Number(rows[0]?.count ?? 0);
}
