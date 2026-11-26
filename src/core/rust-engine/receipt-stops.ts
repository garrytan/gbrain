/**
 * The members a purge's receipt or a recall reads that the Rust engine does not serve yet, who owns each and when it is due. The
 * engine's refusal of one of them names its owner and due date (rust-engine.ts, in the message and in the refusal's detail), so a
 * receipt that stops there says whose lane lifts it and by when. A member leaves this list in the commit of the lane that serves it,
 * together with its `members.ts` class changing to served.
 *
 * Owners are `PURGE_OWNERS` (persistence/purge-path-members.ts), the same labels the page purge's pre-write check names. Due dates:
 * lane 4's fact-context read is due 5 PM PST Nov 24 (the step 4 ruling; lane 3's ledger read is served); lane 4's page receipt reads and
 * the slot-end read are due 5 PM PST Nov 25, the date (and the rust-5a 12bee2c026 commit) test/engine-parity/slot-ends-callers.test.ts
 * already names for `listSlotRows`.
 *
 * Not here: the page purge's own stops (the request index read, the origin-twin read, the publication stamp, the generation-ledger
 * scrub) are listed with their owners and due dates (5 PM PST Nov 25) in persistence/purge-path-members.ts, whose pre-write
 * check names them. The dates of both lists come from its `PURGE_DUE`.
 */
import { PURGE_DUE, PURGE_OWNERS } from '../persistence/purge-path-members.ts';
import type { KnownStop } from './errors.ts';

const NOV_24 = PURGE_DUE.nov24;
const NOV_25 = PURGE_DUE.nov25;

export const RECEIPT_STOP_OWNERS: Readonly<Record<string, KnownStop>> = {
  // The live fact contexts that quote the purged claims (the same report).
  listFactContextsForPurgeProbe: { owner: PURGE_OWNERS.factContextProbe, due: NOV_24 },
  // The page purge receipt's four reads.
  listPageProseHits: { owner: PURGE_OWNERS.receiptReads, due: NOV_25 },
  readPurgeReceiptSourcePath: { owner: PURGE_OWNERS.receiptReads, due: NOV_25 },
  readDeletePageRequest: { owner: PURGE_OWNERS.receiptReads, due: NOV_25 },
  listPurgeEffects: { owner: PURGE_OWNERS.receiptReads, due: NOV_25 },
  // The read-time slot ends of recall.
  listSlotRows: { owner: 'lane 4 (rust-5a 12bee2c026)', due: NOV_25 },
};
