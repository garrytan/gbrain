/**
 * The managed sync checkpoint's validation reads of `src/core/persistence/checkpoint-validation.ts` (#5762, #6643, #6712): the receipt that
 * blocks a run's checkpoint, the open work that blocks a pass stamp, and the blocking receipts `sync status` lists. One SQL implementation for
 * both SQL engines; the 57014 `checkpoint_validation_timeout` mapping stays with the caller. A Rust brain answers the same rows from its
 * request records (src/core/rust-engine/store-members/checkpoint-validation.ts).
 *
 * The statement text is in persistence/checkpoint-validation-sql.ts (its `$n` placeholders are hand-numbered), unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import { INCOMPLETE_SYNC_RECEIPT_SQL, INCOMPLETE_SYNC_RECEIPTS_SQL, OPEN_PASS_WORK_OWN_RECOVERY_SQL, OPEN_PASS_WORK_SQL } from '../persistence/checkpoint-validation-sql.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** What a run's checkpoint validation asks: the worktree and run, the requests the run converted in place, and the cursor's settled index ranges. */
export interface IncompleteSyncReceiptSpec { worktreeId: string; runId: string; superseded: readonly string[]; ranges: ReadonlyArray<readonly [number, number]> }
/** What a pass stamp's validation asks: the worktree, the stamp's own request, and whether its own recovery record is exempt (a folded writeback stamp). */
export interface OpenPassWorkSpec { worktreeId: string; selfRequestId: string; ownRecovery: boolean }
/** One blocking receipt as `sync status` lists it. */
export interface IncompleteSyncReceiptRow { request_id: string; slug: string; state: string; code: string | null; index: number | null; recovery: boolean }

const receiptParams = (spec: IncompleteSyncReceiptSpec) =>
  [spec.worktreeId, spec.runId, [...spec.superseded], spec.ranges.map(range => range[0]), spec.ranges.map(range => range[1])];

/** The request id of a receipt that blocks the run's checkpoint, or null (the first of the statement's union). */
export async function readIncompleteSyncReceipt(engine: RawSql, spec: IncompleteSyncReceiptSpec): Promise<string | null> {
  const [row] = await engine.executeRaw<{ request_id: string }>(INCOMPLETE_SYNC_RECEIPT_SQL, receiptParams(spec));
  return row?.request_id ?? null;
}

/** The request id of the work that blocks a pass stamp, or null. */
export async function readOpenPassWork(engine: RawSql, spec: OpenPassWorkSpec): Promise<string | null> {
  const [row] = await engine.executeRaw<{ request_id: string }>(spec.ownRecovery ? OPEN_PASS_WORK_OWN_RECOVERY_SQL : OPEN_PASS_WORK_SQL, [spec.worktreeId, spec.selfRequestId]);
  return row?.request_id ?? null;
}

/** Every receipt (up to 20) that would block the run's checkpoint now, in sequence order. */
export async function readIncompleteSyncReceiptRows(engine: RawSql, spec: IncompleteSyncReceiptSpec): Promise<IncompleteSyncReceiptRow[]> {
  return engine.executeRaw<IncompleteSyncReceiptRow>(INCOMPLETE_SYNC_RECEIPTS_SQL, receiptParams(spec));
}
