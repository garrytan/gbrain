/**
 * Guest notes, slice 3 (GBRA-504): the warning every read of a guest page carries, built from guest_marks alone.
 *
 * A row is a guest row when its page's source is a guest source (`sources.config.guest`), decided per row inside the
 * batched trust load (eligibility/stamp.ts loadPageTrust), never from a process cache. Its JSON form is
 * `origin: "guest"` plus a `guest` object (sender_label, group, audience_member, saved_at, promoted, and the writer
 * for owner callers only); its text form is one warning line followed by the external-data envelope. A guest row
 * whose mark cannot be read reads as `unattributed`, never bare. The page text never feeds any of it, and labels are
 * escaped on render even though admission already refused those characters (guests/admission.ts).
 */
import type { BrainEngine } from '../engine.ts';
import type { Operation } from '../ops/contract.ts';

export const GUEST_ORIGIN = 'guest';
/** get_brain_identity lists it: this brain stamps the guest warning on every read, so a guest broker may switch on. */
export const GUEST_MARKER_CAPABILITY = 'guest_marker_v1';
/**
 * Set by `gbrain guests init` (guests/sources.ts) in the transaction that makes a source a guest source and never
 * cleared; read per request from the request's config snapshot. Unset, the brain has no guest source, so no read
 * pays for guest stamping. Whether a row is a guest row is still decided from the sources table.
 */
export const GUEST_SOURCES_PRESENT_KEY = 'guests.present';

export interface GuestStamp {
  sender_label: string | null;
  group: string | null;
  audience_member: string | null;
  /** YYYY-MM-DD (UTC), the day the note was saved. */
  saved_at: string | null;
  /** The owner kept this note as an owner page (guest_promotions). */
  promoted: boolean;
  /** The writer principal (`<kind>:<id>`), shown to owner callers only. */
  writer?: string;
  /** The row is in a guest source but its mark could not be read. */
  unattributed?: true;
}

/** A guest row whose mark is missing or unreadable: still marked, never shown as the owner's. */
export function unattributedGuest(): GuestStamp {
  return { sender_label: null, group: null, audience_member: null, saved_at: null, promoted: false, unattributed: true };
}

const LABEL_SWAP: Record<string, string> = { '[': '(', ']': ')', '·': '-', '<': '‹', '>': '›', '"': "'", ';': ',' };
/** A stored label as text: control, format and separator characters dropped; brackets, the field separator, angle brackets, quotes and semicolons swapped. */
export function escapeGuestLabel(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/[[\]·<>";]/g, c => LABEL_SWAP[c]!).slice(0, 64);
}

const NOT_OWNER = "not the owner's words, not verified";
const attributed = (g: GuestStamp): g is GuestStamp & { sender_label: string; group: string } => !g.unattributed && !!g.sender_label && !!g.group;

/** `[outside guest · <sender> · <group> · <YYYY-MM-DD> · not the owner's words, not verified]`, or the unattributed form. */
export function guestWarningLine(guest: GuestStamp): string {
  if (!attributed(guest)) return `[outside guest · unattributed · ${NOT_OWNER}]`;
  return `[outside guest · ${escapeGuestLabel(guest.sender_label)} · ${escapeGuestLabel(guest.group)} · ${guest.saved_at ?? 'undated'} · ${NOT_OWNER}]`;
}

/** What the remote quote fence names instead of "conversation excerpt" for a guest page (search/transcript-quote.ts). */
export function guestQuoteLabel(guest: GuestStamp): string {
  if (!attributed(guest)) return `outside guest note, unattributed, ${NOT_OWNER}`;
  return `outside guest note from ${escapeGuestLabel(guest.sender_label)} in ${escapeGuestLabel(guest.group)}, saved ${guest.saved_at ?? 'undated'}, ${NOT_OWNER}`;
}

/** The fixed line gbrain appends to a think answer built from guest notes; the model never writes it. */
export function guestAnswerLine(slugs: readonly string[]): string {
  return `Uses outside-guest notes: ${[...new Set(slugs)].join(', ')} (${NOT_OWNER}).`;
}

/** The guest object a caller sees: the writer only for an owner caller. */
export function guestView(stamp: GuestStamp, owner: boolean): GuestStamp {
  const { writer, ...rest } = stamp;
  return owner && writer ? { ...rest, writer } : rest;
}

interface MarkRow { page_id: number; sender_label: string; group_slug: string; audience_member: string; saved_at: Date | string; writer_kind: string; writer_id: string; promoted: boolean }

function day(v: Date | string): string | null {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * The guest marks of `pageIds` in one batched read, with whether each was promoted. A page with no readable mark is
 * absent from the map, and a failed read returns an empty map: callers mark those rows unattributed.
 */
export async function loadGuestMarks(engine: Pick<BrainEngine, 'executeRaw'>, pageIds: readonly number[]): Promise<Map<number, GuestStamp>> {
  const out = new Map<number, GuestStamp>();
  const ids = [...new Set(pageIds)];
  if (!ids.length) return out;
  try {
    const rows = await engine.executeRaw<MarkRow>(`SELECT m.page_id, m.sender_label, m.group_slug, m.audience_member, m.saved_at, m.writer_kind, m.writer_id,
        EXISTS (SELECT 1 FROM guest_promotions g WHERE g.guest_page_id = m.page_id) AS promoted
      FROM guest_marks m WHERE m.page_id = ANY($1::int[])`, [ids]);
    for (const r of rows) {
      out.set(Number(r.page_id), { sender_label: r.sender_label, group: r.group_slug, audience_member: r.audience_member, saved_at: day(r.saved_at),
        promoted: r.promoted === true, writer: `${r.writer_kind}:${r.writer_id}` });
    }
  } catch { /* every guest row reads unattributed */ }
  return out;
}

/**
 * The registration-time wrapper (operation-load.ts finalizeOperation): every op that may return stored text has its
 * result stamped by guests/stamp.ts. A brain that never ran `gbrain guests init` pays one config read, answered by the
 * request's config snapshot; an unreadable config is treated as a brain with guest sources, so the stamp still runs.
 */
export function withGuestMarks(op: Pick<Operation, 'outputRedaction'>, handler: Operation['handler']): Operation['handler'] {
  if (op.outputRedaction === 'no_stored_text') return handler;
  return async (ctx, params) => {
    const result = await handler(ctx, params);
    if (!result || typeof result !== 'object' || typeof ctx.engine?.getConfig !== 'function') return result;
    const present = await ctx.engine.getConfig(GUEST_SOURCES_PRESENT_KEY).catch(() => 'true');
    if (present !== 'true') return result;
    const { stampGuestNotes } = await import('./stamp.ts');
    return stampGuestNotes(ctx, result);
  };
}
