/**
 * The temporary refusal of a real `gbrain sources writer claim` on an engine without raw SQL (the Rust engine).
 *
 * A claim fences the source's classic sync until the claim is released (`writer deactivate`) or activated
 * (`writer activate`). On the Rust engine both exits still read raw SQL: deactivation's retired-topology read
 * (deactivation.ts:224) and activation's configured-sources read (activation.ts:112). A claim there could never be
 * lifted, so sync of that source would stay blocked. The claim verb calls `assertClaimReleasable` after its dry run
 * and its reviewed-state check and before any write.
 *
 * Remove this module and its one call (persistence/administration.ts `writerClaim`) when those release paths are
 * typed; the writer-admin parity cases then go back to equal on the Rust arm.
 */
import { opError } from '../ops/contract.ts';
import { servesRawSql } from '../rust-engine/errors.ts';

/** The stable member name the refusal carries in `detail` (`member=writer_claim_release_path`). */
export const CLAIM_RELEASE_PATH_MEMBER = 'writer_claim_release_path';

/** Refuses `engine_capability_missing` (reason `raw_sql`) when `engine` could not release or activate a claim. */
export function assertClaimReleasable(engine: object): void {
  if (servesRawSql(engine)) return;
  throw opError('engine_capability_missing',
    'This brain\'s engine cannot release or activate a writer claim yet (it needs the raw_sql capability), so the claim was refused and nothing ran.',
    'Keep this source on classic sync, or run the claim on a pglite or postgres brain, or wait for a gbrain release whose Rust engine supports writer deactivate and activate.',
    { reason: 'raw_sql',
      why: 'A claim fences classic sync until writer deactivate or writer activate lifts it. On this engine writer deactivate stops at deactivation.ts:224 and writer activate at activation.ts:112, so a claim could not be lifted.',
      detail: `member=${CLAIM_RELEASE_PATH_MEMBER} capability=raw_sql outcome=none written=nothing` });
}
