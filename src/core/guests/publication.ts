/**
 * Guest notes (GBRA-504): what page preparation needs for a guest write, kept beside admission so page-prepare.ts
 * only calls it. prepareGuestWrite reads it once per write (before the snapshot); page-prepare.ts guardGuestPublication
 * adds the publication-time checks.
 */
import type { BrainEngine } from '../engine.ts';
import { parseMarkdownHead } from '../markdown.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { assertGuestReaders } from './admission.ts';
import { isGuestWrite } from './derived.ts';
import { storedGuestNote, type GuestAttribution } from './note.ts';

export interface GuestWrite {
  /** A guest write for the publication-time producers (derived.ts isGuestWrite): a guest note, or any write to a guest source. */
  write: boolean;
  note: GuestAttribution | null;
  /** The note's one audience principal, checked against its readers; null without a note. */
  audience: string | null;
}

export const NOT_A_GUEST_WRITE: GuestWrite = { write: false, note: null, audience: null };

/**
 * The guest reads of one page write. A note's readers are checked here, at preparation, as they were at submission.
 * Throws when the guest-source lookup fails, so the write refuses instead of publishing derived rows.
 */
export async function prepareGuestWrite(engine: BrainEngine, row: WriteRequest, content: unknown): Promise<GuestWrite> {
  const note = storedGuestNote(row.intent);
  const write = await isGuestWrite(engine, row.source_id, row.intent);
  if (!note) return { write, note, audience: null };
  const frontmatter = typeof content === 'string' ? parseMarkdownHead(content).frontmatter : {};
  return { write, note, audience: await assertGuestReaders(engine, frontmatter, Array.isArray(row.authority.actingFor) ? row.authority.actingFor : null) };
}
