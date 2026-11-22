/**
 * Doctor access reads: the statements the `access_pages_read_by_nobody` check
 * (src/commands/doctor/checks/access-pages-read-by-nobody.ts) and the owner identity read behind `owner_identity`
 * (src/core/identity/owner.ts) ran through the doctor's deadline-bound `executeRaw`, moved here with the same text and
 * parameters. PGLite and Postgres run these exact statements. The folder-rule read writes out
 * `ruleCoversSql('slug', '$2')` (src/core/access/folder-rules.ts) as one literal, and test/doctor-access-sql.test.ts pins
 * it against that composition.
 *
 * The Rust engine answers (rust/docs/store/access-doctor.md):
 *  - served from its store: the pages no enabled member reads, which read the page records and their normalized readers;
 *  - empty, no writer: the member-source bindings (`access_member_sources`, v299), which only `executeRaw` writes
 *    (`gbrain access member sources add`), so a Rust brain refuses every binding write and holds none.
 */
import { MEMBER_PAGE_PREFIX, NOBODY } from '../access/principals.ts';

/** The read options the check passed to executeRaw: Postgres ends the statement at `timeoutMs`; the other engines run it to the end. */
export interface DoctorAccessReadOpts { timeoutMs?: number; signal?: AbortSignal }
/** A read that takes the statement bound (the doctor's deadline-bound `executeRaw` on Postgres). */
export type DoctorAccessRead = <R = Record<string, unknown>>(sql: string, params?: unknown[], opts?: DoctorAccessReadOpts) => Promise<R[]>;

/** The members of this file. Each replaced a statement a doctor entry ran through its deadline bound, so src/core/statement-deadline.ts keeps that bound on them. */
export const DOCTOR_ACCESS_MEMBERS: readonly string[] = ['listPagesReadByNobody', 'listAccessMemberSources'];

/** A live page and its normalized readers (`page_readers`, null for a page with no `readable_by`). */
export interface PageReadByNobodyRow { source_id: string; slug: string; readers: string[] | null }

/**
 * Which pages to read:
 *  - `labelled`: every live page whose readers name none of `live` (the enabled members and their groups) and not the
 *    nobody marker;
 *  - `rule`: the live pages of `sourceId` the folder rule at `prefix` covers that are not closed on purpose and that no
 *    identity in `admitted` (the enabled members the rule admits, and their groups) reads: every covered page when
 *    `admitted` is empty, else the labelled ones whose readers name none of `admitted`.
 * Member pages (`memory/members/<id>`) are left out of both.
 */
export type PagesReadByNobodySpec =
  | { by: 'labelled'; live: readonly string[] }
  | { by: 'rule'; sourceId: string; prefix: string; admitted: readonly string[] };

export const PAGES_READ_BY_NOBODY_SQL = {
  labelled: 'SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND page_readers IS NOT NULL AND NOT (page_readers && $1::text[]) AND NOT ($2 = ANY(page_readers)) AND NOT starts_with(slug, $3)',
  rule: 'SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND (starts_with(slug, $2) AND ($2 = \'\' OR right($2, 1) = \'/\' OR slug = $2))'
    + ' AND NOT starts_with(slug, $5) AND (page_readers IS NULL OR NOT ($4 = ANY(page_readers))) AND ($3::int = 0 OR (page_readers IS NOT NULL AND NOT (page_readers && $6::text[])))',
} as const;

/** The pages `spec` names, unordered (the check sorts them). A failure, the Postgres statement bound included, is thrown unchanged. */
export async function listPagesReadByNobody(raw: DoctorAccessRead, spec: PagesReadByNobodySpec, opts?: DoctorAccessReadOpts): Promise<PageReadByNobodyRow[]> {
  const rows = spec.by === 'labelled'
    ? await raw<PageReadByNobodyRow>(PAGES_READ_BY_NOBODY_SQL.labelled, [[...spec.live], NOBODY, MEMBER_PAGE_PREFIX], opts)
    : await raw<PageReadByNobodyRow>(PAGES_READ_BY_NOBODY_SQL.rule, [spec.sourceId, spec.prefix, spec.admitted.length, NOBODY, MEMBER_PAGE_PREFIX, [...spec.admitted]], opts);
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug, readers: r.readers ?? null }));
}

/** One `access_member_sources` row (v299): a personal source bound to one member. */
export interface AccessMemberSourceRow { member_id: string; source_id: string }

export const ACCESS_MEMBER_SOURCES_SQL = 'SELECT member_id, source_id FROM access_member_sources ORDER BY source_id COLLATE "C", member_id COLLATE "C"';

/** Every member-source binding, by source then member, each in byte order (COLLATE "C"), as PGLite gives them. */
export async function listAccessMemberSources(raw: DoctorAccessRead): Promise<AccessMemberSourceRow[]> {
  const rows = await raw<AccessMemberSourceRow>(ACCESS_MEMBER_SOURCES_SQL);
  return rows.map(r => ({ member_id: r.member_id, source_id: r.source_id }));
}
