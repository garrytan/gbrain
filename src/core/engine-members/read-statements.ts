
import type { AmendmentNotAppliedRow, AmendmentsNotAppliedSpec, BeliefHistoryRowQuery, CorePageRow, CorePageRowSpec, CursorEditionRow, PageIdRef, PageVersionEditionRow, TrustScanRow, TrustScanRowSpec, TrustScanTable, UnscannedTrustSpec, ValidTimeIdentityRow, ValidTimeIdentitySpec, ValidTimePickSpec } from '../engine-sql/trust-tier-reads.ts';
import type { ReflexPageMatch, ReflexPageRow, ReflexScope } from '../engine-sql/reflex-reads.ts';
import type { FenceOverlayIncomingRow, FenceOverlayRow, HeldFenceCellKey, HeldFenceCellRow } from '../engine-sql/cli-reads-ops.ts';
import type { PageKeyRef } from '../engine-sql/trust-tier-reads.ts';

export interface ReadStatementMembers {
  /** GST-2891: the fence cells among `keys` held from the current world-only fact reader (eligibility/fence-overlay.ts heldRowSql), one row per distinct held cell. */
  listHeldFenceCells(keys: readonly HeldFenceCellKey[]): Promise<HeldFenceCellRow[]>;
  /** #5575 ENG-1: the fence overlay's read of one page's incoming world fence rows (eligibility/fence-overlay.ts loadFenceChunkOverlay), one row per incoming row in order; `hideHeld` adds heldRowSql for the caller in context. */
  readFenceOverlayRows(page: { sourceId: string; slug: string }, incoming: readonly FenceOverlayIncomingRow[], opts: { hideHeld: boolean }): Promise<FenceOverlayRow[]>;
  /** The retrieval reflex's alias live recheck: the live pages in the scope at `slugs`, as (slug, source_id), in no set order. */
  readReflexLiveKeys(scope: ReflexScope, slugs: readonly string[]): Promise<Array<{ slug: string; source_id: string }>>;
  /** The retrieval reflex's candidate pages in the scope that `match` names, with the bounded body prefix (engine-sql/reflex-reads.ts). */
  readReflexPages(scope: ReflexScope, match: ReflexPageMatch): Promise<ReflexPageRow[]>;
  // `gbrain extract takes` reads and delete (engine-sql/takes-reads.ts).
  /** The id of the live page `slug` in `sourceId`, or null. */
  readLivePageIdBySlug(slug: string, sourceId: string): Promise<number | null>;
  /** The id of the page's take at `rowNum`, or null. */
  findTakeId(pageId: number, rowNum: number): Promise<number | null>;
  // Group D (trust tier reads): the stamped-tier reads of core memory, the trust scan, belief history, page history and valid time.
  /** The live `always_load` pages, by source then slug, with the trust columns a delivery read asks for. */
  listCorePageRows(spec: CorePageRowSpec): Promise<CorePageRow[]>;
  /** Rows of one scanned table above an id whose stored tier is listed, by id. */
  listTrustScanRows(spec: TrustScanRowSpec): Promise<TrustScanRow[]>;
  /** How many rows of one scanned table above an id (and at or below a ceiling) have a listed stored tier. */
  countUnscannedTrustRows(spec: UnscannedTrustSpec): Promise<number>;
  /** The trust scan's cursor (`op_checkpoints` trust_scan/v1): its `completed_keys` JSON, or null when there is none. */
  readTrustScanCursor(): Promise<unknown>;
  /** Replace the trust scan's cursor keys and stamp the row now. */
  writeTrustScanCursor(completedKeys: readonly unknown[]): Promise<void>;
  /** The claimed sources whose lift has not finished, by id. */
  listClaimPendingSourceIds(): Promise<string[]>;
  /** Each table the trust scan reads, with its max id (0 when empty). */
  readTrustScanCeilings(): Promise<Record<TrustScanTable, number>>;
  /** One page of a source's belief events, with the per-row visibility facts the remote filter reads. */
  readBeliefHistoryRows(spec: BeliefHistoryRowQuery): Promise<Array<Record<string, unknown>>>;
  /** The listed page lifetimes that are live and whose page passes the remote read floor. */
  listVisibleBeliefLifetimes(lifetimes: readonly string[]): Promise<string[]>;
  /** The source, slug and stored type of each listed page, deleted or not, by id (the GST-687 quoting reads); unknown ids answer nothing. */
  listPageRefsByIds(ids: readonly number[]): Promise<PageIdRef[]>;
  /** The id and stored trust tier of each named page, deleted or not, in no set order (timeline projection). */
  listPageTrustTiersByKey(refs: readonly PageKeyRef[]): Promise<Array<{ id: number; source_id: string; slug: string; trust_tier: string | null }>>;
  /** The named pages that are live, each held FOR SHARE until the transaction ends, in no set order. */
  lockLivePagesByKey(refs: readonly PageKeyRef[]): Promise<PageKeyRef[]>;
  /** The live pages with a slug a valid-time read may follow, by source (at most six). */
  listValidTimeIdentities(spec: ValidTimeIdentitySpec): Promise<ValidTimeIdentityRow[]>;
  /** The valid-time pick over one page and its retained versions; null when the page is gone. */
  pickValidTimeEdition(spec: ValidTimePickSpec): Promise<Record<string, unknown> | null>;
  /** The amendment records dated after an edition took effect and on or before the date, by slug then source. */
  listAmendmentsNotApplied(spec: AmendmentsNotAppliedSpec): Promise<AmendmentNotAppliedRow[]>;
  /** A retained version of the page as an as-of read loads it; null when the page keeps no such version. */
  readPageVersionEdition(spec: { pageId: number; versionId: number }): Promise<PageVersionEditionRow | null>;
  /** Whether the page is still at the revision, and its newest version recorded at it; null when the page is gone. */
  readCursorEdition(spec: { pageId: number; revision: string }): Promise<CursorEditionRow | null>;
  /** Whether a purge hid the page until it is derived again (a `needs_rederive` row names it). */
  pageAwaitsRederive(pageId: number): Promise<boolean>;
}
