/**
 * The operation checkpoint statements of `src/core/op-checkpoint.ts` (load, record, append, clear): one SQL
 * implementation for both engines. The statement text is what op-checkpoint.ts sent through `executeRaw` (the load)
 * and `executeRawDirect` (the writes, which Postgres routes to the direct session pool, #1794). The retry, the
 * chunking and the fail-loud count stay in op-checkpoint.ts. The Rust store keeps the same rows
 * (rust/docs/store/persistence.md, "Operation checkpoints").
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;
type Direct = Pick<BrainEngine, 'executeRawDirect'>;

/** One checkpoint's banked keys: the `op_checkpoint_paths` rows, then the legacy `completed_keys` elements. */
export interface OpCheckpointRead {
  keys: string[];
  /** The parent's `completed_keys` is not an array: it was skipped, the child rows still count. */
  corruptParent: boolean;
}

/**
 * UNION ALL, not UNION: the caller's Set dedupes. The legacy arm is gated on `jsonb_typeof = 'array'` so a scalar
 * parent cannot fail the whole read; the third arm reports it.
 */
const LOAD_SQL = `SELECT path AS ckey, 0 AS corrupt FROM op_checkpoint_paths
         WHERE op = $1 AND fingerprint = $2
       UNION ALL
       SELECT jsonb_array_elements_text(completed_keys) AS ckey, 0 AS corrupt FROM op_checkpoints
         WHERE op = $1 AND fingerprint = $2 AND jsonb_typeof(completed_keys) = 'array'
       UNION ALL
       SELECT NULL AS ckey, 1 AS corrupt FROM op_checkpoints
         WHERE op = $1 AND fingerprint = $2 AND jsonb_typeof(completed_keys) <> 'array'`;

/** `$3::text::jsonb`, not `$3::jsonb`: a JSON string bound to a jsonb param double-encodes on postgres.js (#2339). */
const RECORD_SQL = `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ($1, $2, $3::text::jsonb, now())
       ON CONFLICT (op, fingerprint) DO UPDATE
         SET completed_keys = EXCLUDED.completed_keys,
             updated_at     = now()`;

/**
 * One writable-CTE statement: ensure the parent row exists (FK target) and bump its updated_at so the 7-day purge
 * tracks activity, then insert the child rows. `ON CONFLICT DO NOTHING` makes re-appending a banked path a no-op.
 * $3 binds a string[] to text[], not a jsonb param.
 */
const APPEND_PATHS_SQL = `WITH parent AS (
  INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
  VALUES ($1, $2, '[]'::jsonb, now())
  ON CONFLICT (op, fingerprint) DO UPDATE SET updated_at = now()
)
INSERT INTO op_checkpoint_paths (op, fingerprint, path)
SELECT $1, $2, unnest($3::text[])
ON CONFLICT (op, fingerprint, path) DO NOTHING`;

const CLEAR_SQL = 'DELETE FROM op_checkpoints WHERE op = $1 AND fingerprint = $2';
/** Belt and braces: the FK cascade drops the children with the parent; this drops any whose parent was absent. */
const CLEAR_CHILDREN_SQL = 'DELETE FROM op_checkpoint_paths WHERE op = $1 AND fingerprint = $2';

/** The banked keys of checkpoint (`op`, `fingerprint`), in the order the statement returns them. */
export async function readOpCheckpoint(exec: Raw, op: string, fingerprint: string): Promise<OpCheckpointRead> {
  const rows = await exec.executeRaw<{ ckey: unknown; corrupt: unknown }>(LOAD_SQL, [op, fingerprint]);
  const keys: string[] = [];
  let corruptParent = false;
  for (const row of rows) {
    if (Number(row.corrupt) === 1) corruptParent = true;
    else if (typeof row.ckey === 'string') keys.push(row.ckey);
  }
  return { keys, corruptParent };
}

/** Replace the parent's `completed_keys` with `keys` (the child rows stay). */
export async function writeOpCheckpointKeys(direct: Direct, op: string, fingerprint: string, keys: readonly string[]): Promise<void> {
  await direct.executeRawDirect(RECORD_SQL, [op, fingerprint, JSON.stringify(keys)]);
}

/** Bank `paths` under checkpoint (`op`, `fingerprint`), creating or stamping its parent. */
export async function appendOpCheckpointPaths(direct: Direct, op: string, fingerprint: string, paths: readonly string[]): Promise<void> {
  await direct.executeRawDirect(APPEND_PATHS_SQL, [op, fingerprint, [...paths]]);
}

/** Drop checkpoint (`op`, `fingerprint`): the parent, then any child left without one. */
export async function deleteOpCheckpoint(direct: Direct, op: string, fingerprint: string): Promise<void> {
  await direct.executeRawDirect(CLEAR_SQL, [op, fingerprint]);
  await direct.executeRawDirect(CLEAR_CHILDREN_SQL, [op, fingerprint]);
}
