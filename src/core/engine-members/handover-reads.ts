/**
 * The reads of `gbrain access member handover` preview and --status, and the member-source list
 * (engine-sql/handover-reads.ts). `BrainEngine` extends this interface.
 */
import type * as HandoverSql from '../engine-sql/handover-reads.ts';

export interface HandoverReadMembers {
  /** The live pages whose readers name one of `principals`, by source id and slug in byte order, at most `limit`. */
  listHandoverReaderPages(principals: readonly string[], limit: number): Promise<HandoverSql.HandoverReaderPage[]>;
  /** The live pages of `sourceId` a folder-rule prefix covers, at most 5000, in no set order. */
  listHandoverPrefixPages(sourceId: string, prefix: string): Promise<HandoverSql.HandoverPrefixPage[]>;
  /** The live pages, in any source, with this slug. */
  countMemberPage(slug: string): Promise<number>;
  /** The facts kept on a live page with this slug, in any source. */
  countMemberPageFacts(slug: string): Promise<number>;
  /** The member's tokens not revoked plus the OAuth clients bound to it. */
  countMemberBoundCredentials(memberId: string): Promise<number>;
  /** The member's most recently undone handover id, or null. */
  readLastUndoneHandoverId(memberId: string): Promise<string | null>;
  /** One `access_handovers` row by id or plan hash, or null. */
  readHandoverRow(by: 'id' | 'plan_hash', value: string): Promise<Record<string, unknown> | null>;
  /** Every member-source binding, or one member's, by member and source. */
  listMemberSourceRows(memberId: string | null): Promise<HandoverSql.MemberSourceRow[]>;
}
