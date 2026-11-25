/**
 * The soak counters' write (src/core/persistence/soak-counters.ts recordSoakEvent), moved here with the same text: one
 * `op_checkpoints` row per UTC day, each counter added to in one upsert. PGLite and Postgres run this exact statement;
 * the Rust store serves the same member (rust/crates/gbrain-store/src/persistence/op_checkpoint.rs
 * `add_soak_counter_event_in`). The reader is `readSoakCounterRows` (engine-sql/doctor-checkpoints.ts).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

export const ADD_SOAK_COUNTER_EVENT_SQL = `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array(jsonb_build_object('day',$2::text,$3::text,$4::int)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(op_checkpoints.completed_keys->0
      || jsonb_build_object($3::text, COALESCE((op_checkpoints.completed_keys->0->>$3)::int,0)+$4::int)), updated_at=now()`;

/** Adds `n` to counter `kind` of day `day`'s row of `op` (fingerprint `day`), creating the row as `[{ day, kind: n }]`. */
export async function addSoakCounterEvent(exec: Raw, op: string, day: string, kind: string, n: number): Promise<void> {
  await exec.executeRaw(ADD_SOAK_COUNTER_EVENT_SQL, [op, day, kind, n]);
}
