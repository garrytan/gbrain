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
 * Deletes the checkpoints whose stamp is older than `ttlDays` days and that no exemption holds, and returns how many
 * it deleted; the `op_checkpoint_paths` foreign key (`ON DELETE CASCADE`) drops their paths. The exemptions are listed
 * at op-checkpoint.ts `purgeStaleCheckpoints`, the caller, which turns a failure into 0.
 */
export async function purgeStaleCheckpoints(raw: Raw, ttlDays: number): Promise<number> {
  const rows = await raw.executeRaw<{ count: string | number }>(PURGE_STALE_CHECKPOINTS_SQL, [String(ttlDays)]);
  return Number(rows[0]?.count ?? 0);
}
