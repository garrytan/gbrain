/**
 * Life Chronicle ended-invite projection.
 *
 * A calendar invite page (slug under `calendar/` or `cal/`, or type
 * `calendar-event`) with a title and frontmatter `start` and `end` is fully
 * structured, so once its end has passed the chronicle phase projects it into
 * one event without a model call:
 *
 *   when = `start`, who = the page's attendees, where = `location`,
 *   kind = `meeting`, what = `Scheduled: <title>`,
 *   captured_via = `life-chronicle:invite`.
 *
 * An invite is not proof of attendance: the summary prefix and `captured_via`
 * say the meeting was scheduled, not that it happened. The projection stands
 * in for the judge inside the executor, so publication, ownership, the ledger
 * row and retirement are the judged path's; it takes no daily reservation and
 * records zero cost. An invite that has not ended, or a calendar page without
 * a title, start and end, keeps the judged path.
 */
import type { ChronicleEventProposal } from './extract-events.ts';
import type { BuiltChronicleEvent } from './publish.ts';
import { parseDateLoose } from '../effective-date.ts';

const CHRONICLE_INVITE_CAPTURED_VIA = 'life-chronicle:invite';
const SCHEDULED_PREFIX = 'Scheduled: ';
const INVITE_SLUG_PREFIXES = ['calendar/', 'cal/'];

/** pages-03: frontmatter keeps a timestamp as its text, read the way the YAML parser read it (an offset-less time as UTC). */
function instant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  return parseDateLoose(value);
}

/** The one event an ended invite projects to; null when the page is not a structured, ended invite. */
export function endedInviteProposal(page: { slug: string; type: string; title: string; frontmatter?: Record<string, unknown> | null },
  attendees: string[], now: Date): ChronicleEventProposal | null {
  const fm = page.frontmatter ?? {};
  const invite = page.type === 'calendar-event' || INVITE_SLUG_PREFIXES.some((p) => page.slug.startsWith(p));
  const start = instant(fm.start);
  const end = instant(fm.end);
  const title = (page.title ?? '').trim();
  if (!invite || !start || !end || !title || end.getTime() > now.getTime()) return null;
  const location = typeof fm.location === 'string' && fm.location.trim() ? fm.location.trim() : null;
  return { when: typeof fm.start === 'string' ? fm.start.trim() : start.toISOString(), who: attendees,
    what: `${SCHEDULED_PREFIX}${title}`, where: location, kind: 'meeting' };
}

/** Mark projected events with their provenance. */
export function markInviteEvents(events: BuiltChronicleEvent[]): BuiltChronicleEvent[] {
  return events.map((ev) => ({ ...ev, frontmatter: { ...ev.frontmatter, captured_via: CHRONICLE_INVITE_CAPTURED_VIA } }));
}
