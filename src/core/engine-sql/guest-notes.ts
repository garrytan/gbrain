/**
 * The guest-note statements a guest note's publication and reads ran through `executeRaw`, each with the statement
 * text and parameters its caller used; only their home moved (guests/admission.ts `assertGuestWriterAtPublication`,
 * `insertGuestMark` and `refuseRemoteGuestDelete`, guests/marker.ts `loadGuestMarks`, guests/promote.ts and
 * guests/stamp-readable.ts `readableGuestRefs`). The text of each is pinned in
 * test/engine-sql-caller-raw-sql-pins.test.ts.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { GUEST_SOURCES_HIDDEN_SQL } from '../guests/note.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';

/**
 * Publication's recheck of a guest source (guests/admission.ts assertGuestWriterAtPublication): the source's writers
 * under a share lock, and, in the same statement, `gbrain.guest_note` set to `requestId` for the rest of the
 * transaction, which the guest-source trigger requires of a listed writer's page write. Null when the source has no
 * guest_sources row (then nothing is set).
 */
export async function claimGuestNotePublication(raw: EngineRawRead, sourceId: string, requestId: string): Promise<{ writers: string[] } | null> {
  const [guest] = await raw<{ writers: string[] }>(
    "SELECT writers, set_config('gbrain.guest_note', $2, true) AS guest_note FROM guest_sources WHERE source_id = $1 FOR SHARE", [sourceId, requestId]);
  return guest ? { writers: guest.writers } : null;
}

/** One guest mark (guests/admission.ts insertGuestMark): who the note was saved for, from which group, by which writer. */
export interface GuestMarkInsert {
  sourceId: string;
  slug: string;
  audienceMember: string;
  groupSlug: string;
  senderLabel: string;
  writerKind: string;
  writerId: string;
  requestId: string;
}

/** Writes the guest mark of the page at (sourceId, slug), saved now; how many rows it wrote (0 when no page is there). */
export async function insertGuestMark(raw: EngineRawRead, mark: GuestMarkInsert): Promise<number> {
  const marked = await raw(`INSERT INTO guest_marks (page_id, source_id, slug_at_write, audience_member, group_slug, sender_label, saved_at, writer_kind, writer_id, request_id)
    SELECT p.id, p.source_id, p.slug, $3, $4, $5, now(), $6, $7, $8 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 RETURNING page_id`,
    [mark.sourceId, mark.slug, mark.audienceMember, mark.groupSlug, mark.senderLabel, mark.writerKind, mark.writerId, mark.requestId]);
  return marked.length;
}

/** One guest mark as the guest stamp reads it, with whether the page was promoted. */
export interface GuestMarkRow {
  page_id: number; sender_label: string; group_slug: string; audience_member: string; saved_at: Date | string;
  writer_kind: string; writer_id: string; promoted: boolean;
}

/** The guest marks of `pageIds`, in no set order (guests/marker.ts loadGuestMarks). */
export async function readGuestMarks(raw: EngineRawRead, pageIds: readonly number[]): Promise<GuestMarkRow[]> {
  return raw<GuestMarkRow>(`SELECT m.page_id, m.sender_label, m.group_slug, m.audience_member, m.saved_at, m.writer_kind, m.writer_id,
        EXISTS (SELECT 1 FROM guest_promotions g WHERE g.guest_page_id = m.page_id) AS promoted
      FROM guest_marks m WHERE m.page_id = ANY($1::int[])`, [[...pageIds]]);
}

/**
 * Whether the owner already kept guest page `guestPageId` as the page at (targetSource, targetSlug): its promotion link
 * exists and a page is there (guests/promote.ts promoteGuestNote). A link whose target page was purged does not count.
 */
export async function readGuestPromotionKept(raw: EngineRawRead, guestPageId: number, targetSource: string, targetSlug: string): Promise<boolean> {
  const [kept] = await raw(`SELECT 1 FROM guest_promotions g WHERE g.guest_page_id = $1 AND g.target_source_id = $2 AND g.target_slug = $3
    AND EXISTS (SELECT 1 FROM pages t WHERE t.source_id = g.target_source_id AND t.slug = g.target_slug)`, [guestPageId, targetSource, targetSlug]);
  return kept !== undefined;
}

/** One promotion link (guests/promote.ts linkGuestPromotion). */
export interface GuestPromotionLink {
  guestPageId: number; targetSource: string; targetSlug: string; by: { kind: string; id: string }; requestId: string | null;
}

/**
 * Records the promotion link: relinks the one row for this guest page and target, else inserts it. A concurrent
 * promotion that inserted the same link first keeps its row (ON CONFLICT on guest_promotions_link_key, v314).
 */
export async function linkGuestPromotion(raw: EngineRawRead, link: GuestPromotionLink): Promise<void> {
  await raw(`WITH relinked AS (UPDATE guest_promotions SET promoted_by_kind = $4, promoted_by_id = $5, promoted_at = now(), request_id = $6
      WHERE guest_page_id = $1 AND target_source_id = $2 AND target_slug = $3 RETURNING id)
    INSERT INTO guest_promotions (guest_page_id, target_source_id, target_slug, promoted_by_kind, promoted_by_id, request_id)
    SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM relinked) ON CONFLICT DO NOTHING`,
    [link.guestPageId, link.targetSource, link.targetSlug, link.by.kind, link.by.id, link.requestId]);
}

/** What a remote delete of a page decides on (guests/admission.ts refuseRemoteGuestDelete). */
export interface GuestDeleteCheckRow { hidden: boolean; guest: boolean; kept: boolean; writer: string | null }

/**
 * The page at (sourceId, slug), live or soft-deleted, as a remote delete sees it: whether row-level security hides
 * guest_sources from the role, whether its source has a guest_sources row, whether the owner kept it, and its guest
 * mark's writer (`kind:id`). Null when no page is there. A schema behind the guest-notes migration throws the
 * missing-table error.
 */
export async function readGuestDeleteCheck(raw: EngineRawRead, sourceId: string, slug: string): Promise<GuestDeleteCheckRow | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(GUEST_SOURCES_HIDDEN_SQL)} AS hidden, EXISTS (SELECT 1 FROM guest_sources g WHERE g.source_id = p.source_id) AS guest, EXISTS (SELECT 1 FROM guest_promotions g WHERE g.guest_page_id = p.id) AS kept,
       (SELECT m.writer_kind || ':' || m.writer_id FROM guest_marks m WHERE m.page_id = p.id) AS writer FROM pages p WHERE p.source_id = ${sourceId} AND p.slug = ${slug} LIMIT 1`);
  const [page] = await raw<GuestDeleteCheckRow>(text, params);
  return page ?? null;
}

/** A page a guest stamp may ride on (guests/stamp-readable.ts readableGuestRefs). */
export interface GuestRefPageRow { id: number; source_id: string; slug: string; type: string | null; frontmatter: unknown }

/**
 * The pages, live or soft-deleted, with an id in `ids` or a (source_id, slug) in `keys`, under the current caller's
 * page policy (privatePagesFilterForCaller) when `excludePrivate`.
 */
export async function readGuestRefPages(raw: EngineRawRead, ids: readonly number[], keys: ReadonlyArray<{ source_id: string; slug: string }>,
  excludePrivate: boolean): Promise<GuestRefPageRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.source_id, p.slug, p.type, p.frontmatter FROM pages p
      WHERE (p.id = ANY(${[...ids]}::int[]) OR (p.source_id, p.slug) IN (SELECT u.s, u.g FROM unnest(${keys.map(k => k.source_id)}::text[], ${keys.map(k => k.slug)}::text[]) AS u(s, g)))${trustedSql(excludePrivate ? ` AND ${privatePagesFilterForCaller('p')}` : '')}`);
  return raw<GuestRefPageRow>(text, params);
}
