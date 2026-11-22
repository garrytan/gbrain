/**
 * The decide family statements of BrainEngine: calibration profiles, proposals and the decide store.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type * as CalibrationProfilesSql from '../engine-sql/calibration-profiles.ts';
import type * as DecideProposalsSql from '../engine-sql/decide-proposals.ts';
import type * as DecideStoreSql from '../engine-sql/decide-store.ts';

export interface DecideMembers {
  // Decide family, group B: calibration profiles (engine-sql/calibration-profiles.ts).
  /** The newest calibration profile (`generated_at DESC`, then `id DESC`) of `holder` (any holder when unset) in `sourceIds` (an empty list matches nothing) or else `sourceId`; null when none. `id` is the BIGSERIAL as text. */
  getLatestCalibrationProfile(spec: CalibrationProfilesSql.LatestCalibrationProfileSpec): Promise<CalibrationProfilesSql.CalibrationProfileRow | null>;
  /** Whether the latest profile of the source and holder already holds this total, brier, accuracy, partial rate (REAL-rounded) and model; false when there is none. */
  isCalibrationProfileUnchanged(spec: CalibrationProfilesSql.CalibrationProfileUnchangedSpec): Promise<boolean>;
  /** Insert one calibration profile (the `calibration_profile` cycle phase's write). The source must exist; `generatedAt`, `waveVersion` and `published` default to now, `v0.36.1.0` and false. */
  insertCalibrationProfile(row: CalibrationProfilesSql.CalibrationProfileInsert): Promise<void>;
  /** The profiles generated in the last 7 days (of `sourceIds` when set) and how many of them failed the voice gate. */
  readVoiceGateHealth(spec: { sourceIds?: readonly string[] }): Promise<CalibrationProfilesSql.VoiceGateHealth>;
  /** `undo-wave`: how many profiles `waveVersion` wrote (`dryRun`), or delete them and return how many went. */
  purgeCalibrationProfilesByWave(spec: { waveVersion: string; dryRun: boolean }): Promise<number>;

  // ============================================================
  // Decide proposals (group C; engine-sql/decide-proposals.ts, rust/docs/store/decide-proposals.md)
  // ============================================================
  /** Insert a supersede proposal. Returns its id, or null when its sweep slot or claim-sweep fact pair already carries one. */
  insertDecideProposal(p: DecideProposalsSql.NewProposal): Promise<number | null>;
  /** One supersede proposal; `lock` takes the row lock inside a transaction (a store with no row locks reads it plain). */
  getDecideProposal(id: number, lock?: boolean): Promise<DecideProposalsSql.ProposalRow | null>;
  /** The ids of one sweep's proposals in a status, by pair index. */
  listDecideProposalIds(sweepId: string, status: DecideProposalsSql.ProposalStatus): Promise<number[]>;
  /** Supersede proposals with both facts' text, oldest first; default status `pending`, default limit 200. */
  listDecideProposals(opts?: { status?: DecideProposalsSql.ProposalStatus | 'all'; limit?: number }): Promise<DecideProposalsSql.ProposalListing[]>;
  /** Compare-and-set a supersede proposal's status; false when it is no longer `from`. */
  transitionDecideProposal(id: number, from: DecideProposalsSql.ProposalStatus, to: DecideProposalsSql.ProposalStatus, state?: { before?: string | null; after?: string | null }): Promise<boolean>;
  /** The ordered fact pairs that already carry a proposal, in any status, and name `factId`. */
  listDecideProposedPairs(sourceId: string, factId: number): Promise<Array<{ a: number; b: number }>>;
  /** Insert a review proposal. Returns its id, or null when the (kind, source, a, b, subject) proposal exists. */
  insertDecideReviewProposal(p: DecideProposalsSql.NewReviewProposal): Promise<number | null>;
  /** Review proposals in a status (`all` for every one), by id. */
  listDecideReviewProposals(status: string): Promise<DecideProposalsSql.ReviewProposalRecord[]>;
  /** One review proposal; `lock` takes the row lock inside a transaction (a store with no row locks reads it plain). */
  getDecideReviewProposal(id: number, lock?: boolean): Promise<DecideProposalsSql.ReviewProposalRecord | null>;
  /** Compare-and-set a review proposal's status; false when it is no longer `from`. */
  transitionDecideReviewProposal(id: number, from: string, to: string): Promise<boolean>;
  /** The pending review proposals of one sweep, by id; withdrawals only when asked. */
  listDecideReviewProposalIds(sweepId: string, includeWithdrawals: boolean): Promise<number[]>;
  /** The doctor's review rates: per kind the pending count, oldest pending age in days and 30-day decisions, over both proposal tables. */
  readProposalReviewRates(): Promise<DecideProposalsSql.ProposalReviewCounts[]>;
  /** Review-queue rows of one kind and source that are due and not exhausted, oldest due first. */
  listDueDecideReviewQueue(kind: string, sourceId: string, limit: number): Promise<DecideProposalsSql.ReviewQueueRow[]>;
  /** Queue a review pair (idempotent), drop a queue row or defer it with a reason; the number of rows it touched. */
  applyDecideReviewQueue(op: DecideProposalsSql.ReviewQueueOp): Promise<number>;
  /** Due conflict-sweep retries of a source, oldest due first. */
  listDueDecideSweepDeferred(sourceId: string, limit: number): Promise<Array<{ fact_id: number; attempts: number }>>;
  /** Defer a swept fact, hand over relinked facts or clear a fact's retry row; the number of rows it touched. */
  applyDecideSweepDeferred(sourceId: string, op: DecideProposalsSql.SweepDeferredOp): Promise<number>;

  // Group A (decide store): `decide_state`, `decide_spend`, `decision_receipts`, `decide_calibrations` (engine-sql/decide-store.ts).
  /** The value kept under a decide state key, or null. */
  readDecideState(key: string): Promise<string | null>;
  /** Keep a value under a decide state key, replacing an earlier one. */
  upsertDecideState(key: string, value: string): Promise<void>;
  /** Forget a decide state key (absent is fine). */
  deleteDecideState(key: string): Promise<void>;
  /** Keep the value only when the key is empty, then answer the stored value (null if it cannot be read back). */
  ensureDecideState(key: string, value: string): Promise<string | null>;
  /** Record spend rows; a request id already recorded keeps its first row, and a refused row records none. */
  insertDecideSpend(rows: readonly DecideStoreSql.DecideSpendInsert[]): Promise<void>;
  /** Third-party spend recorded at or after `since`: the total and the remote part. */
  dailyDecideSpend(since: Date): Promise<{ total: number; remote: number }>;
  /** Spend totals per slot over the whole ledger, in slot order. */
  listDecideSpendBySlot(): Promise<DecideStoreSql.DecideSpendSlotTotals[]>;
  /** Record receipt rows in order; a refused row records none. */
  insertDecideReceipts(rows: readonly DecideStoreSql.DecideReceiptInsert[]): Promise<void>;
  /** Delete receipts older than `retentionDays` (and spend older than `max(retentionDays, 31)` days); answers how many receipts went. */
  pruneDecideReceipts(retentionDays: number): Promise<number>;
  /** Receipt counts, mean answer value, latency percentiles and tokens per (slot, mode, outcome, error reason) over the window. */
  listDecideReceiptStats(opts: { slot?: string; sinceHours: number }): Promise<DecideStoreSql.DecideReceiptStat[]>;
  /** Per-slot decisions, rows, tokens, errors, skips and egress refusals over the window. */
  decideSlotUsage(sinceHours: number): Promise<DecideStoreSql.DecideSlotUsageRow[]>;
  /** Conflict receipts in the window and how many were `no_entity` skips. */
  decideConflictNoEntityCounts(sinceHours: number): Promise<{ receipts: number; skipped: number }>;
  /** The receipts of `slot` in the window that a replay reads, by decision id, rank, insertion order. */
  listDecideReplayReceipts(slot: string, sinceHours: number): Promise<DecideStoreSql.DecideReplayReceipt[]>;
  /** Each (slot, provider, resolved model) in the window with its count and latest time, latest first. */
  listDecideResolvedModels(sinceHours: number): Promise<DecideStoreSql.DecideResolvedModel[]>;
  /** Per slot, the receipts in the window marked `mixed_model`. */
  listDecideMixedModelDecisions(sinceHours: number): Promise<Array<{ slot: string; n: number }>>;
  /** Record one calibration, stamped now, and answer its id. */
  insertDecideCalibration(row: DecideStoreSql.DecideCalibrationInsert): Promise<number>;
  /** Replace the qualification columns of calibration `id` and stamp `qualified_at`; an unknown id changes nothing. */
  storeDecideQualification(id: number, q: DecideStoreSql.DecideQualification): Promise<void>;
  /** The calibrations by slot (byte order), newest first; retired ones only with `includeRetired`. */
  listDecideCalibrations(opts?: { slot?: string; includeRetired?: boolean }): Promise<DecideStoreSql.DecideCalibration[]>;
  /** Calibration `id`, or null. */
  getDecideCalibration(id: number): Promise<DecideStoreSql.DecideCalibration | null>;
  /** Retire calibration `id` or bring it back; answers whether the row exists. */
  setDecideCalibrationRetired(id: number, retired: boolean): Promise<boolean>;
}
