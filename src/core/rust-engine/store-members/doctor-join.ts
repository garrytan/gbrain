/**
 * Doctor reads of the checks from the rust-engine/main join (src/core/engine-sql/doctor-join.ts): access_pages_read_by_nobody
 * and owner_identity. The two page scans are served by gbrain-store (rust/crates/gbrain-store/src/cli_reads/doctor_join.rs);
 * the rest answer here from the store's access members, groups, member links and sources. What each answers and why:
 * rust/docs/store/cli-reads-doctor-join.md.
 */
import type { BrainEngine, SourceRow } from '../../engine.ts';
import type { AccessMemberStatus, PageReadersRow } from '../../engine-sql/doctor-join.ts';
import { sourceConfigText } from '../../source-rows.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** Byte order of `key(row)`, as `ORDER BY ... COLLATE "C"` and the store sort. */
const byBytes = <T>(key: (row: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Every member with its status (removed: tombstoned; disabled; else enabled), by id. */
export const listAccessMemberStatuses: Member<'listAccessMemberStatuses'> = async (brain) => {
  const rows = await storeCall({ member: 'listAccessMemberStatuses' }, () => brain.readAccessMembers({ includeRemoved: true })) as
    Array<{ id: string; disabled_at: string | null; tombstoned_at: string | null }>;
  return rows.map(r => ({ id: r.id, status: (r.tombstoned_at !== null ? 'removed' : r.disabled_at !== null ? 'disabled' : 'enabled') as AccessMemberStatus }))
    .sort(byBytes(r => r.id));
};

/** Every group membership, by group and member. */
export const listAccessGroupMemberships: Member<'listAccessGroupMemberships'> = async (brain) => {
  const groups = await storeCall({ member: 'listAccessGroupMemberships' }, () => brain.readAccessGroups(null)) as Array<{ id: string; members: string[] }>;
  return groups.flatMap(g => g.members.map(member_id => ({ group_id: g.id, member_id })));
};

/** The labelled live pages no principal in `live` reads; the store has no statement to bound, so `timeoutMs` is unused. */
export const listPagesReadByNobody: Member<'listPagesReadByNobody'> = async (brain, live) =>
  await storeCall({ member: 'listPagesReadByNobody' }, () => brain.listPagesReadByNobody([...live])) as PageReadersRow[];

/** The live pages a folder rule covers that none of `admitted` reads; `timeoutMs` is unused, as above. */
export const listRulePagesReadByNobody: Member<'listRulePagesReadByNobody'> = async (brain, sourceId, prefix, admittedCount, admitted) =>
  await storeCall({ member: 'listRulePagesReadByNobody', sourceId }, () =>
    brain.listRulePagesReadByNobody(sourceId, prefix, admittedCount, [...admitted])) as PageReadersRow[];

/**
 * The Google sources that are not archived (`config->>'kind' = 'google'`), by id in byte order, with their account
 * (`config->>'g_account'`). The store keeps no personal-source bindings (`access_member_sources`; binding one is a raw SQL
 * write a Rust brain refuses), so no source has bound members and `members` is null, as SQL's `array_agg` of no rows is.
 */
export const listGoogleSourceMembers: Member<'listGoogleSourceMembers'> = async (brain) => {
  const rows = await storeCall({ member: 'listGoogleSourceMembers' }, () => brain.listAllSources({ includeArchived: false, localPathOnly: false })) as SourceRow[];
  return rows.filter(r => sourceConfigText(r.config, 'kind') === 'google')
    .map(r => ({ id: r.id, account: sourceConfigText(r.config, 'g_account'), members: null }))
    .sort(byBytes(r => r.id));
};

/** One member's external ids, by system and external id (byte order). */
export const listOwnerMemberLinks: Member<'listOwnerMemberLinks'> = async (brain, memberId) => {
  const rows = await storeCall({ member: 'listOwnerMemberLinks' }, () => brain.listAccessMemberLinks(memberId)) as Array<{ system: string; external_id: string }>;
  return rows.map(r => ({ system: r.system, external_id: r.external_id }));
};
