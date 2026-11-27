/**
 * The doctor tallies of BrainEngine (SQL in engine-sql/doctor-tallies.ts): counts doctor checks ran through executeRaw
 * inside a catch that hid a Rust capability refusal. `BrainEngine` extends this interface.
 */
export interface DoctorTallyMembers {
  /** Live segmented pages; with `projectionPending`, only those whose text projection is behind their knowledge revision. */
  countLiveSegmentedPages(opts?: { projectionPending?: boolean }): Promise<number>;
  /** Facts whose validity window ended and that nothing expired yet (doctor memory_writeback). */
  countValidityLapsedFacts(): Promise<number>;
  /** Timeline projections whose event page is soft-deleted, over the event pages of `sourceIds` (null: every source). */
  countOrphanEventProjections(sourceIds: readonly string[] | null): Promise<number>;
}
