/**
 * Temporal typed edges: the relationship note shared by every surface that
 * shows a page summary (entity cards, context_pack, ambient turn context,
 * compiled context). One batched read of relationship state per call.
 *
 * "now: works_at widget-co (since 2025-03-01); ended: works_at acme-example
 * (2025-03-01)"; "(by 2025-03-01)" when only the nightly check's inferred closure dates the end, an upper
 * bound. Ended relationships the summary still names always appear
 * (with a stale-summary warning); other ended ones are capped at the latest
 * three. Only state relations (works_at, advises, …) take part, and a page
 * with no ended relationship gets no note.
 */

import {
  annotateTemporalRow, temporalLinkJoinSql, TEMPORAL_LINK_SELECT_SQL, type RelationshipStatus,
} from './link-validity.ts';
import { privateLinkOriginFilterFragment, privatePagesFilterFragment } from './search/private-visibility.ts';

const NOTE_ENDED_CAP = 3;

type RawExec = { executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> };

export interface NoteSubject { slug: string; source_id: string; summary?: string | null }

interface NoteEdge { type: string; slug: string; title: string; status: RelationshipStatus | 'reference'; since: string | null; until: string | null; untilUpperBound: boolean }

export const relationshipNoteKey = (sourceId: string, slug: string): string => `${sourceId}\u0000${slug}`;

function renderNote(summary: string, edges: NoteEdge[]): string | undefined {
  const live = edges.filter(e => e.status === 'live' || e.status === 'disputed');
  const ended = edges.filter(e => e.status === 'ended' || e.status === 'ended_unknown_date');
  if (ended.length === 0) return undefined;
  const lower = summary.toLowerCase();
  const named = (e: NoteEdge) => {
    const title = e.title.trim().toLowerCase();
    return (title.length >= 3 && lower.includes(title)) || lower.includes(e.slug.split('/').pop()!.replace(/-/g, ' '));
  };
  const short = (e: NoteEdge) => e.slug.split('/').pop()!;
  const stale = ended.filter(named);
  const others = ended.filter(e => !named(e)).sort((a, b) => (b.until ?? '').localeCompare(a.until ?? '')).slice(0, NOTE_ENDED_CAP);
  const parts = [
    ...(live.length ? [`now: ${live.map(e => `${e.type} ${short(e)}${e.since ? ` (since ${e.since})` : ''}`).join(', ')}`] : []),
    `ended: ${[...stale, ...others].map(e => `${e.type} ${short(e)} (${e.until ? `${e.untilUpperBound ? 'by ' : ''}${e.until}` : 'date unknown'})`).join(', ')}`,
  ];
  if (stale.length) parts.push(`summary may be stale: it still names ${stale.map(short).join(', ')}`);
  return parts.join('; ');
}

/**
 * Notes keyed by `relationshipNoteKey(source_id, slug)`; subjects without an
 * ended relationship are absent. `excludePrivate` reads the world-scope state
 * and hides private targets and private-origin links, like remote graph reads.
 */
export async function loadRelationshipNotes(
  engine: RawExec,
  subjects: readonly NoteSubject[],
  opts: { excludePrivate: boolean },
): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  if (subjects.length === 0) return notes;
  const privacy = opts.excludePrivate ? ` AND ${privatePagesFilterFragment('t')} AND ${privateLinkOriginFilterFragment('l')}` : '';
  // The evidence the relationship projection counts for this scope (link-relationships.ts): an origin that is gone or in
  // another source never counts, and a private origin does not count toward the world scope.
  const endBy = (producer: string) => `EXISTS (SELECT 1 FROM link_transitions x LEFT JOIN pages xo ON xo.id = x.origin_page_id
        WHERE x.from_page_id = l.from_page_id AND x.to_page_id = l.to_page_id AND x.link_type = l.link_type AND x.kind = 'end'
        AND x.occurred_on = lr_t.last_end AND x.producer ${producer}
        AND (x.origin_page_id IS NULL OR xo.deleted_at IS NULL AND xo.source_id = f.source_id${opts.excludePrivate ? ` AND ${privatePagesFilterFragment('xo')}` : ''}))`;
  const rows = await engine.executeRaw<{ from_slug: string; source_id: string; to_slug: string; to_title: string | null; link_type: string; last_end: string | null; end_upper_bound: boolean | null }>(
    `SELECT f.slug AS from_slug, f.source_id, t.slug AS to_slug, t.title AS to_title, l.link_type, lr_t.last_end::text AS last_end,
        (${endBy("= 'dream'")} AND NOT ${endBy("<> 'dream'")}) AS end_upper_bound${TEMPORAL_LINK_SELECT_SQL}
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       ${temporalLinkJoinSql('l', opts.excludePrivate)}
      WHERE (f.source_id, f.slug) IN (SELECT s.source_id, s.slug FROM unnest($1::text[], $2::text[]) AS s(source_id, slug))
        AND lr_t.semantics = 'state' AND t.deleted_at IS NULL${privacy}`,
    [subjects.map(s => s.source_id), subjects.map(s => s.slug)],
  );
  const bySubject = new Map<string, Map<string, NoteEdge>>();
  for (const raw of rows) {
    const r = annotateTemporalRow(raw);
    const key = relationshipNoteKey(r.source_id, r.from_slug);
    const edges = bySubject.get(key) ?? new Map<string, NoteEdge>();
    const last = r.stints?.[r.stints.length - 1];
    edges.set(`${r.link_type}\u0000${r.to_slug}`, {
      type: r.link_type, slug: r.to_slug, title: r.to_title ?? '', status: r.status,
      since: last?.from ?? null, until: last?.until ?? null,
      untilUpperBound: r.end_upper_bound === true && last?.until != null && last.until === String(r.last_end).slice(0, 10),
    });
    bySubject.set(key, edges);
  }
  for (const s of subjects) {
    const key = relationshipNoteKey(s.source_id, s.slug);
    const edges = bySubject.get(key);
    const note = edges ? renderNote(s.summary ?? '', [...edges.values()]) : undefined;
    if (note) notes.set(key, note);
  }
  return notes;
}

/**
 * Ambient turn context: fold each page's note into its synopsis (world scope),
 * so the budget trimmer prices the rendered line. Fail-soft: an error leaves
 * the synopses unchanged.
 */
export async function appendRelationshipNotes(
  engine: RawExec,
  items: Array<{ slug: string; source_id: string; synopsis: string }>,
): Promise<void> {
  if (items.length === 0) return;
  const notes = await loadRelationshipNotes(engine, items.map(i => ({ slug: i.slug, source_id: i.source_id, summary: i.synopsis })), { excludePrivate: true })
    .catch(() => new Map<string, string>());
  for (const item of items) {
    const note = notes.get(relationshipNoteKey(item.source_id, item.slug));
    if (note) item.synopsis = item.synopsis ? `${item.synopsis} [${note}]` : `[${note}]`;
  }
}
