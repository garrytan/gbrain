/**
 * The guest-note statements a guest note's publication and reads ran through `executeRaw`, each with the statement
 * text and parameters its caller used; only their home moved (guests/admission.ts `assertGuestWriterAtPublication` and
 * `insertGuestMark`, guests/marker.ts `loadGuestMarks`). The text of each is pinned in
 * test/engine-sql-caller-raw-sql-pins.test.ts.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

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
