/**
 * The reads `gbrain access member handover` runs for its preview and --status (src/core/access/handover.ts), and the
 * member-source list (src/core/access/member-sources.ts). One implementation for both engines; the Rust store serves
 * the same members (src/core/rust-engine/store-members/handover-reads.ts, rust/crates/gbrain-store/src/handover_reads.rs).
 *
 * Intended differences from the statements the callers sent:
 * - the reader-page list sorts by source id and slug in byte order (`COLLATE "C"`), so the page cut at the limit is the
 *   same on every engine and database locale, and binds its limit;
 * - the private-fact count joins a fact to its page by `source_markdown_slug`: the old join named a `page_id` column the
 *   facts table does not have, so it always failed and read 0.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** A live page whose readers name one of the leaver's principals. */
export interface HandoverReaderPage { id: number; source_id: string; slug: string; frontmatter: unknown }
/** A live page a folder-rule prefix covers. */
export interface HandoverPrefixPage { source_id: string; slug: string; frontmatter: unknown }
/** One member-source binding. */
export interface MemberSourceRow { member_id: string; source_id: string; created_at: unknown }

/** The most pages a rule's impact read takes (handover.ts readImpact). */
export const HANDOVER_PREFIX_PAGE_LIMIT = 5000;

const READER_PAGES_SQL = `SELECT id, source_id, slug, frontmatter FROM pages WHERE deleted_at IS NULL AND frontmatter ? 'readable_by'
  AND gbrain_access_readers(frontmatter) && $1::text[] ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT $2`;
const PREFIX_PAGES_SQL = `SELECT source_id, slug, frontmatter FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND (slug = $2 OR ($2 LIKE '%/' AND left(slug, length($2)) = $2)) LIMIT 5000`;
const MEMBER_PAGE_COUNT_SQL = 'SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug = $1';
const MEMBER_PAGE_FACTS_SQL = 'SELECT count(*)::int AS n FROM facts f JOIN pages p ON p.source_id = f.source_id AND p.slug = f.source_markdown_slug WHERE p.deleted_at IS NULL AND p.slug = $1';
const BOUND_CREDENTIALS_SQL = 'SELECT (SELECT count(*) FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL) + (SELECT count(*) FROM oauth_clients WHERE member_id = $1) AS n';
const LAST_UNDONE_SQL = "SELECT id FROM access_handovers WHERE member_id = $1 AND state = 'undone' ORDER BY undone_at DESC LIMIT 1";
const HANDOVER_BY_ID_SQL = 'SELECT id, member_id, owner_id, plan_hash, choices, items, commits, state, created_at, undone_at, undo_of FROM access_handovers WHERE id = $1';
const HANDOVER_BY_HASH_SQL = 'SELECT id, member_id, owner_id, plan_hash, choices, items, commits, state, created_at, undone_at, undo_of FROM access_handovers WHERE plan_hash = $1';
const MEMBER_SOURCES_SQL = 'SELECT member_id, source_id, created_at FROM access_member_sources ORDER BY member_id, source_id';
const MEMBER_SOURCES_OF_SQL = 'SELECT member_id, source_id, created_at FROM access_member_sources WHERE member_id = $1 ORDER BY member_id, source_id';

/** The live pages whose readers name one of `principals`, by source id and slug in byte order, at most `limit`. */
export function listHandoverReaderPages(raw: EngineRawRead, principals: readonly string[], limit: number): Promise<HandoverReaderPage[]> {
  return raw<HandoverReaderPage>(READER_PAGES_SQL, [[...principals], limit]);
}

/** The live pages of `sourceId` the rule prefix covers (the prefix itself, or every slug under a prefix ending in '/'), at most 5000, in no set order. */
export function listHandoverPrefixPages(raw: EngineRawRead, sourceId: string, prefix: string): Promise<HandoverPrefixPage[]> {
  return raw<HandoverPrefixPage>(PREFIX_PAGES_SQL, [sourceId, prefix]);
}

/** The live pages, in any source, with this slug. */
export async function countMemberPage(raw: EngineRawRead, slug: string): Promise<number> {
  return Number((await raw<{ n: number }>(MEMBER_PAGE_COUNT_SQL, [slug]))[0]?.n ?? 0);
}

/** The facts kept on a live page with this slug (`source_markdown_slug`), in any source. */
export async function countMemberPageFacts(raw: EngineRawRead, slug: string): Promise<number> {
  return Number((await raw<{ n: number }>(MEMBER_PAGE_FACTS_SQL, [slug]))[0]?.n ?? 0);
}

/** The member's tokens not revoked plus the OAuth clients bound to it. */
export async function countMemberBoundCredentials(raw: EngineRawRead, memberId: string): Promise<number> {
  return Number((await raw<{ n: number | string }>(BOUND_CREDENTIALS_SQL, [memberId]))[0]?.n ?? 0);
}

/** The member's most recently undone handover, or null. */
export async function readLastUndoneHandoverId(raw: EngineRawRead, memberId: string): Promise<string | null> {
  const [row] = await raw<{ id: string }>(LAST_UNDONE_SQL, [memberId]);
  return row ? String(row.id) : null;
}

/** One `access_handovers` row by id or plan hash, as stored, or null. */
export async function readHandoverRow(raw: EngineRawRead, by: 'id' | 'plan_hash', value: string): Promise<Record<string, unknown> | null> {
  const [row] = await raw<Record<string, unknown>>(by === 'id' ? HANDOVER_BY_ID_SQL : HANDOVER_BY_HASH_SQL, [value]);
  return row ?? null;
}

/** Every member-source binding, or the bindings of one member, by member and source. */
export function listMemberSourceRows(raw: EngineRawRead, memberId: string | null): Promise<MemberSourceRow[]> {
  return memberId === null ? raw<MemberSourceRow>(MEMBER_SOURCES_SQL) : raw<MemberSourceRow>(MEMBER_SOURCES_OF_SQL, [memberId]);
}
