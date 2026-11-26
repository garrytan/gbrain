
import type * as SegmentDeriveStoreSql from '../engine-sql/segment-derive-store.ts';

export interface MentionPassMembers {
  /** Upsert `rows` as done derivations while the page is live, segmented and at body `generation`; how many were written. */
  storeSegmentDerivationsIfLive(pageId: number, generation: number, rows: readonly SegmentDeriveStoreSql.SegmentDerivationStoreRow[]): Promise<number>;
}
