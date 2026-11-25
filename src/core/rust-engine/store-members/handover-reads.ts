/**
 * The member handover preview and --status reads (src/core/engine-sql/handover-reads.ts), served from the store
 * (rust/crates/gbrain-store/src/handover_reads.rs and jobs/doctor_credentials.rs; rust/docs/store/handover-reads.md).
 * The store keeps no handover records and no member-source bindings: no Rust write creates either (a handover's apply
 * and undo refuse on this engine before they write, access/handover.ts refuseHandoverWrites), so those reads answer
 * none, as the SQL engines do for a brain that holds none.
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 */
import type { HandoverPrefixPage, HandoverReaderPage, MemberSourceRow } from '../../engine-sql/handover-reads.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listHandoverReaderPages: StoreMember<[principals: readonly string[], limit: number], HandoverReaderPage[]> = async (brain, principals, limit) =>
  (await storeCall({ member: 'listHandoverReaderPages' }, () => brain.listHandoverReaderPages([...principals], limit)) as HandoverReaderPage[])
    .map(r => ({ ...r, id: Number(r.id) }));

export const listHandoverPrefixPages: StoreMember<[sourceId: string, prefix: string], HandoverPrefixPage[]> = (brain, sourceId, prefix) =>
  storeCall({ member: 'listHandoverPrefixPages', sourceId }, () => brain.listHandoverPrefixPages(sourceId, prefix)) as Promise<HandoverPrefixPage[]>;

export const countMemberPage: StoreMember<[slug: string], number> = async (brain, slug) =>
  Number(await storeCall({ member: 'countMemberPage' }, () => brain.countMemberPage(slug)));

export const countMemberPageFacts: StoreMember<[slug: string], number> = async (brain, slug) =>
  Number(await storeCall({ member: 'countMemberPageFacts' }, () => brain.countMemberPageFacts(slug)));

export const countMemberBoundCredentials: StoreMember<[memberId: string], number> = async (brain, memberId) =>
  Number(await storeCall({ member: 'countMemberBoundCredentials' }, () => brain.countMemberBoundCredentials(memberId)));

/** The store keeps no handover records. */
export const readLastUndoneHandoverId: StoreMember<[memberId: string], string | null> = async () => null;

/** The store keeps no handover records. */
export const readHandoverRow: StoreMember<[by: 'id' | 'plan_hash', value: string], Record<string, unknown> | null> = async () => null;

/** The store keeps no member-source bindings (rust/crates/gbrain-store/src/read_shared.rs). */
export const listMemberSourceRows: StoreMember<[memberId: string | null], MemberSourceRow[]> = async () => [];
