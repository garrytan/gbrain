/**
 * The connector database cursor write (src/core/connectors/db-cursor.ts `writeConnectorDbCursor`): the upsert of an
 * unmanaged connector source's cursor row. The statement is the caller's, byte for byte, and both SQL engines run it
 * through their own `executeRaw`. The Rust store applies the same write in one store transaction
 * (rust/crates/gbrain-store/src/persistence/connector_attempts.rs).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The op_checkpoints op of the connector cursor rows (db-cursor.ts re-exports it). */
export const CONNECTOR_DB_CURSOR_OP = 'connector-db-cursor';

/** The cursor row's records, or null: the read an executor without `readOpCheckpointRecord` runs (db-cursor.ts). */
export async function readConnectorDbCursorRow(raw: Raw, key: string): Promise<unknown[] | null> {
  const [row] = await raw.executeRaw<{ completed_keys: unknown[] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [CONNECTOR_DB_CURSOR_OP, key]);
  return row?.completed_keys ?? null;
}

/**
 * Writes the cursor row `key`: a new row holds `record`; an existing row becomes `[{ version: 1, state, last_run }]`
 * with `state` from `record` and `last_run` from `record` unless `record` has no `last_run` key, when the stored one
 * stays (a JSON null `last_run` is a value, as jsonb's `->` reads it).
 */
export async function writeConnectorDbCursor(raw: Raw, key: string, record: readonly unknown[]): Promise<void> {
  await raw.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(jsonb_build_object('version',1,'state',EXCLUDED.completed_keys->0->'state',
      'last_run',COALESCE(EXCLUDED.completed_keys->0->'last_run',op_checkpoints.completed_keys->0->'last_run'))),updated_at=now()`,
  [CONNECTOR_DB_CURSOR_OP, key, JSON.stringify(record)]);
}
