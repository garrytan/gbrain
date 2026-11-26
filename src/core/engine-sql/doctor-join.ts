/**
 * Doctor reads of the checks the rust-engine/main join brought in: access_pages_read_by_nobody
 * (src/commands/doctor/checks/access-pages-read-by-nobody.ts) and owner_identity (src/core/identity/owner.ts). Each
 * statement is the text and the parameters its caller ran through `executeRaw`; only its home moved. The Rust engine
 * answers the same members from its store records (rust/crates/gbrain-store/src/cli_reads/doctor_join.rs,
 * rust/docs/store/cli-reads-doctor-join.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { MEMBER_PAGE_PREFIX, NOBODY } from '../access/principals.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them.
 */
export const DOCTOR_JOIN_MEMBERS: readonly string[] = [
  'listAccessMemberStatuses', 'listAccessGroupMemberships', 'listPagesReadByNobody', 'listRulePagesReadByNobody',
  'listGoogleSourceMembers', 'listOwnerMemberLinks',
];

export type AccessMemberStatus = 'enabled' | 'disabled' | 'removed';
export interface AccessMemberStatusRow { id: string; status: AccessMemberStatus }
export interface AccessGroupMembershipRow { group_id: string; member_id: string }
/** A live page and its normalized readers (`page_readers`; null when the page names none). */
export interface PageReadersRow { source_id: string; slug: string; readers: string[] | null }
/** A Google source that is not archived: its account (`config->>'g_account'`) and the members bound to it, by id. */
export interface GoogleSourceMembersRow { id: string; account: string | null; members: string[] | null }
export interface OwnerMemberLinkRow { system: string; external_id: string }

export const LIST_ACCESS_MEMBER_STATUSES_SQL = "SELECT id, CASE WHEN tombstoned_at IS NOT NULL THEN 'removed' WHEN disabled_at IS NOT NULL THEN 'disabled' ELSE 'enabled' END AS status FROM access_members ORDER BY id";
export const LIST_ACCESS_GROUP_MEMBERSHIPS_SQL = 'SELECT group_id, member_id FROM access_group_members';
export const LIST_PAGES_READ_BY_NOBODY_SQL = 'SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND page_readers IS NOT NULL AND NOT (page_readers && $1::text[]) AND NOT ($2 = ANY(page_readers)) AND NOT starts_with(slug, $3)';
/** The folder-rule form; `(starts_with(slug, $2) AND ...)` is `ruleCoversSql('slug', '$2')` (access/folder-rules.ts), spelled out. */
export const LIST_RULE_PAGES_READ_BY_NOBODY_SQL = "SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND (starts_with(slug, $2) AND ($2 = '' OR right($2, 1) = '/' OR slug = $2)) AND NOT starts_with(slug, $5) AND (page_readers IS NULL OR NOT ($4 = ANY(page_readers))) AND ($3::int = 0 OR (page_readers IS NOT NULL AND NOT (page_readers && $6::text[])))";
export const LIST_GOOGLE_SOURCE_MEMBERS_SQL = `SELECT s.id, s.config->>'g_account' AS account,
            (SELECT array_agg(b.member_id ORDER BY b.member_id) FROM access_member_sources b WHERE b.source_id = s.id) AS members
       FROM sources s
      WHERE s.archived IS NOT TRUE AND s.config->>'kind' = 'google'
      ORDER BY s.id COLLATE "C"`;
export const LIST_OWNER_MEMBER_LINKS_SQL = 'SELECT system, external_id FROM access_member_links WHERE member_id = $1 ORDER BY system, external_id';

/** Every access member by id, with its status: removed (tombstoned), disabled, or enabled. */
export function listAccessMemberStatuses(raw: EngineRawRead): Promise<AccessMemberStatusRow[]> {
  return raw<AccessMemberStatusRow>(LIST_ACCESS_MEMBER_STATUSES_SQL);
}

/** Every group membership, in no defined order. */
export function listAccessGroupMemberships(raw: EngineRawRead): Promise<AccessGroupMembershipRow[]> {
  return raw<AccessGroupMembershipRow>(LIST_ACCESS_GROUP_MEMBERSHIPS_SQL);
}

/**
 * The live pages whose readers name none of `live` (the enabled members' principals) and not the nobody marker, member
 * pages left out; in no defined order. `timeoutMs` bounds the statement.
 */
export function listPagesReadByNobody(raw: EngineRawRead, live: readonly string[], opts: { timeoutMs: number }): Promise<PageReadersRow[]> {
  return raw<PageReadersRow>(LIST_PAGES_READ_BY_NOBODY_SQL, [live, NOBODY, MEMBER_PAGE_PREFIX], { timeoutMs: opts.timeoutMs });
}

/**
 * The live pages of `sourceId` a folder rule at `prefix` covers that no enabled member it admits reads: with
 * `admitted` empty every covered page that is not closed on purpose; otherwise every covered page whose own readers
 * name none of `admitted` (a page with no readers is read through the rule). Member pages are left out; in no defined
 * order. `timeoutMs` bounds the statement.
 */
export function listRulePagesReadByNobody(
  raw: EngineRawRead, sourceId: string, prefix: string, admittedCount: number, admitted: readonly string[], opts: { timeoutMs: number },
): Promise<PageReadersRow[]> {
  return raw<PageReadersRow>(LIST_RULE_PAGES_READ_BY_NOBODY_SQL,
    [sourceId, prefix, admittedCount, NOBODY, MEMBER_PAGE_PREFIX, admitted], { timeoutMs: opts.timeoutMs });
}

/** The Google sources that are not archived, by id in byte order, with their account and bound members. */
export function listGoogleSourceMembers(raw: EngineRawRead): Promise<GoogleSourceMembersRow[]> {
  return raw<GoogleSourceMembersRow>(LIST_GOOGLE_SOURCE_MEMBERS_SQL);
}

/** One member's external ids (access_member_links), by system and external id. */
export function listOwnerMemberLinks(raw: EngineRawRead, memberId: string): Promise<OwnerMemberLinkRow[]> {
  return raw<OwnerMemberLinkRow>(LIST_OWNER_MEMBER_LINKS_SQL, [memberId]);
}
