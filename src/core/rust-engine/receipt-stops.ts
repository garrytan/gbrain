/**
 * The members a purge's receipt reads that the Rust engine does not serve yet, and who owns each. The engine's refusal of one of
 * them names its owner (rust-engine.ts), so a receipt that stops there says whose lane lifts it. A member leaves this list in the
 * commit of the lane that serves it, together with its `members.ts` class changing to served.
 *
 * Labels are `PURGE_OWNERS` (persistence/purge-path-members.ts), the same ones the page purge's pre-write check names.
 */
import { PURGE_OWNERS } from '../persistence/purge-path-members.ts';

export const RECEIPT_STOP_OWNERS: Readonly<Record<string, string>> = {
  // The recorded values of the belief ledger (the fact purge receipt's ledger report).
  listBeliefEventsForPurgeProbe: PURGE_OWNERS.beliefProbe,
  // The live fact contexts that quote the purged claims (the same report).
  listFactContextsForPurgeProbe: PURGE_OWNERS.factContextProbe,
  // The page purge receipt's four reads.
  listPageProseHits: PURGE_OWNERS.receiptReads,
  readPurgeReceiptSourcePath: PURGE_OWNERS.receiptReads,
  readDeletePageRequest: PURGE_OWNERS.receiptReads,
  listPurgeEffects: PURGE_OWNERS.receiptReads,
};
