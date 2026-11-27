/**
 * Terminal-failure classification constants (#6650), in a leaf module with no runtime imports.
 *
 * `terminal-classify.ts` re-exports them. The Rust store member (`src/core/rust-engine/store-members/doctor-terminal.ts`)
 * imports them from here, so the engine's import closure does not pull in the persistence and sync modules.
 */
import type { TerminalCategory } from './terminal-classify.ts';

/** #6650: classes a release fixed. A row written by an older build is history: it does not warn. */
export const TERMINAL_FIXED_IN = {
  // #6643: the run re-freezes its own knock-ons and the checkpoint no longer waits on them.
  knock_on: '0.60.216.0',
  // #5974/#5982: a guard P0001 is classified (writer_coordinator_required, origin database_guard) and the misread is fixed;
  // an unclassified "Publication failed (P0001)" receipt can only come from an older build.
  legacy_publication_refusal: '0.60.40.0',
  // #6657: a refused fact-fence adoption is no longer resubmitted every cycle and keeps its metadata.
  fence_unrenderable: '0.60.218.0',
  // #7814: the v0.13.1 grandfather writes nothing; a queued managed_grandfather request only an older build admitted ends refused.
  retired_operation: '0.60.479.0',
} as const satisfies Partial<Record<TerminalCategory, string>>;

/** The prefix of an unclassified database refusal written before #5974. */
export const LEGACY_PUBLICATION_PREFIX = 'Publication failed (P0001)';

/** Page removals: a later one supersedes any earlier write of the page. */
export const PAGE_REMOVAL_OPERATIONS: readonly string[] = ['delete_page', 'purge_page'];

/** Hops a connector retry's `retryOf` lineage is followed back; a longer chain leaves the refusal unresolved (fail closed). */
export const CONNECTOR_RETRY_LINEAGE_MAX_DEPTH = 32;
/** The intent kinds of a connector write whose refused receipt a committed retry can supersede. */
export const CONNECTOR_WRITE_KIND_LIST: readonly string[] = ['connector_v2_import', 'connector_v2_delete', 'connector_v2_checkpoint'];
