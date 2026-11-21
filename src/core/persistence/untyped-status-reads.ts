/**
 * The named refusal of the three `gbrain sources writer status` reads that are still raw SQL, on an engine without
 * raw SQL (the Rust engine): the stalled catch-ups (effect-catchup.ts), the parked groups (parked-groups.ts) and the
 * source movement (sync-movement.ts). Each read calls `assertServesStatusRead` before its first statement, so the
 * refusal names the read (`member=<name>` in `detail`) and nothing runs.
 *
 * Remove a read's call and its name here when that read moves to a typed engine member; the whole-status case in
 * test/engine-parity/writer-status.test.ts then goes back to equal on the Rust arm.
 */
import { capabilityMissing, servesRawSql } from '../rust-engine/errors.ts';

/** The stable names the refusals carry in `detail`. */
export const UNTYPED_STATUS_READS = {
  stalledCatchups: 'stalled_catchups_read',
  parkedGroups: 'parked_groups_read',
  sourceMovement: 'source_movement_read',
} as const;

export type UntypedStatusRead = typeof UNTYPED_STATUS_READS[keyof typeof UNTYPED_STATUS_READS];

/** Refuses `engine_capability_missing` (reason `raw_sql`) naming `read` when `engine` does not serve raw SQL. */
export function assertServesStatusRead(engine: object, read: UntypedStatusRead): void {
  if (!servesRawSql(engine)) throw capabilityMissing('raw_sql', read);
}
