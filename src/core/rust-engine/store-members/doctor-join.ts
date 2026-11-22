/**
 * Doctor reads of the checks from the rust-engine/main join (src/core/engine-sql/doctor-join.ts): access_pages_read_by_nobody
 * and owner_identity. The two page scans are served by gbrain-store (rust/crates/gbrain-store/src/cli_reads/doctor_join.rs);
 * the Google sources come from the store's sources, and the member reads answer none (no access members are kept). What
 * each answers and why:
 * rust/docs/store/cli-reads-doctor-join.md.
 */
import type { BrainEngine, SourceRow } from '../../engine.ts';
import type { PageReadersRow } from '../../engine-sql/doctor-join.ts';
import { sourceConfigText } from '../../source-rows.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** Byte order of `key(row)`, the store's order. */
const byBytes = <T>(key: (row: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/**
 * The store keeps no access members, groups or member links on this line (readAccessMembers answers none, see
 * write-misc.ts), so there is no member status, no group membership and no member link: the check is not applicable
 * and owner identity has no member identifier, as on a SQL brain with none.
 */
export const listAccessMemberStatuses: Member<'listAccessMemberStatuses'> = async () => [];
export const listAccessGroupMemberships: Member<'listAccessGroupMemberships'> = async () => [];

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

export const listOwnerMemberLinks: Member<'listOwnerMemberLinks'> = async () => [];
