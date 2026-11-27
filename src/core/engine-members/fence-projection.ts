/**
 * The fence projection statements of BrainEngine: a page publication's fence projection and fence guard, a tier-only
 * row change and the unwithdrawn-facts classifier's page body read.
 * `BrainEngine` extends this interface. Each member runs the statement its caller ran through executeRaw.
 */
export interface FenceProjectionMembers {
  /**
   * A page publication's fence projection (persistence/canonical-projections.ts, engine-sql/fence-projection.ts): the
   * quoted-fence reads, the segmented-prior and held-take-fence probes, the stored take row numbers, the fact expiry and
   * field refresh, and the take resolution writes. The writes run on the publication's transaction engine.
   */
  listQuotedTakeRows(pageId: number, rowNums: readonly number[]): Promise<import('../engine-sql/fence-projection.ts').QuotedTakeRow[]>;
  listPageFenceFactCells(sourceId: string, slug: string): Promise<import('../engine-sql/fence-projection.ts').PageFenceFactCell[]>;
  hasPositionedPageFacts(sourceId: string, slug: string): Promise<boolean>;
  hasFenceAbsentHold(sourceId: string, kind: string, ownerKey: string): Promise<boolean>;
  listPageTakeRowNums(pageId: number): Promise<number[]>;
  expireFenceFacts(sourceId: string, slug: string, incoming: string, ids: readonly number[]): Promise<void>;
  refreshFenceFactFields(sourceId: string, slug: string, fieldRows: string): Promise<void>;
  clearChangedTakeResolutions(pageId: number, claims: string): Promise<void>;
  writeFenceTakeResolutions(pageId: number, resolutions: string): Promise<void>;
  /** The fence guard's statements around its decisions (trust/fence-guard.ts, engine-sql/trust-fence.ts). */
  detachFenceFactRows(ids: readonly number[]): Promise<void>;
  listOccupiedFenceRowNums(sourceId: string, slug: string): Promise<number[]>;
  moveGuardedFenceRows(moves: readonly import('../engine-sql/trust-fence.ts').FenceRowMove[]): Promise<void>;
  listTrustedPrivateCopies(sourceId: string, slug: string, restated: readonly import('../engine-sql/trust-fence.ts').FenceRestatement[]): Promise<import('../engine-sql/trust-fence.ts').TrustedPrivateCopy[]>;
  readLiveFenceFactAt(sourceId: string, slug: string, rowNum: number): Promise<{ id: number; trust_tier: string } | null>;
  listFactsAboveWriter(sourceId: string, slug: string): Promise<Array<{ id: number; trust_tier: string }>>;
  /** A tier-only change of one row and the page its chunks render (trust/page-handlers.ts setRowTier, trust/page-write.ts; engine-sql/row-tier.ts). */
  readRowTrustTier(table: import('../engine-sql/row-tier.ts').RowTierTable, id: number): Promise<{ trust_tier: string } | null>;
  setRowTrustTier(table: import('../engine-sql/row-tier.ts').RowTierTable, id: number, tier: string, decision: string): Promise<number[]>;
  readTierProjectionPage(table: import('../engine-sql/row-tier.ts').RowTierTable, id: number): Promise<{ source_id: string; slug: string } | null>;
  /** repair unwithdrawn-facts: a candidate's page body by id (engine-sql/unwithdrawn-restore.ts). */
  readPageInlineBody(pageId: number | string): Promise<import('../engine-sql/unwithdrawn-restore.ts').PageInlineBody | null>;
}
