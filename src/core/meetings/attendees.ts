/**
 * GST-2904 (GBRA-592): who was on an imported call. `gbrain import --calls` keeps a call to the brain owner plus the
 * teammates its header names (src/commands/import-calls.ts); `gbrain repair visibility --propose` reads the same header
 * for calls imported before that (src/commands/repair-propose.ts).
 *
 * Only the call's header counts: an `attendees:` key in a leading frontmatter block, or an `Attendees:` /
 * `Participants:` line (plain or bold) within the first 15 lines and before the header ends. The header ends at the
 * first blank line after text or at the first speaker turn (`Name: words` whose label is not a header label such as
 * Date). A line deeper in the transcript never counts, so a speaker reading out "Attendees: ..." adds no reader.
 *
 * Matching is exact (skills/conventions/brain-first.md, identity rule): an entry carrying an email matches by that email
 * only; otherwise the member id, then a display name exactly one enabled person member holds, letter case ignored.
 * Disabled members and audience members never match. The literal `owner` is covered by the owner, who reads every
 * scoped call. Anything else stays unmatched and is listed, never guessed.
 */
import { FAILSAFE_SCHEMA } from 'js-yaml';
import { loadBoundedYaml } from '../data-frontmatter.ts';
import type { MemberRecord } from '../access/members.ts';

const HEADER_LINES = 15;
const LIST_LINE_RE = /^(?:\*\*)?(attendees|participants)(?::\*\*|\*\*:|:)[ \t]*(.*)$/i;
const HEADER_LABELS = new Set(['date', 'time', 'when', 'call', 'title', 'subject', 'meeting', 'topic', 'duration', 'location', 'where', 'organizer', 'organiser', 'host', 'recorded', 'recording', 'source', 'platform', 'agenda', 'attendees', 'participants']);
const TURN_RE = /^(?:\*\*)?([^:*\n]{1,60}?)(?:\*\*)?:\s+\S/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** One attendee as the header gives it: the printed entry, and the email it carries when it has one. */
export interface CallAttendee { entry: string; email?: string }

function attendeeOf(raw: string): CallAttendee | null {
  const entry = raw.trim().replace(/^[-*]\s+/, '').replace(/^\[\[|\]\]$/g, '').trim();
  if (!entry) return null;
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(entry)?.[1];
  const email = angled ?? (EMAIL_RE.test(entry) ? entry : undefined);
  return email ? { entry, email: email.toLowerCase() } : { entry };
}

const splitList = (text: string): CallAttendee[] => text.split(/[,;]/).map(attendeeOf).filter((a): a is CallAttendee => a !== null);

function inlineAttendees(value: string): CallAttendee[] {
  let parsed: unknown;
  try { parsed = loadBoundedYaml(value, { schema: FAILSAFE_SCHEMA }); } catch { return splitList(value.replace(/^\[|\]$/g, '').replace(/["']/g, '')); }
  if (typeof parsed === 'string') return splitList(parsed);
  if (!Array.isArray(parsed)) return [];
  return (parsed.flat(Infinity) as unknown[]).flatMap(item => typeof item === 'string' ? [attendeeOf(item)] : []).filter((a): a is CallAttendee => a !== null);
}

function frontmatterAttendees(lines: string[]): { attendees: CallAttendee[] | null; end: number } {
  if (lines[0]?.trim() !== '---') return { attendees: null, end: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { attendees: null, end: 0 };
  for (let i = 1; i < end; i++) {
    const m = /^attendees:[ \t]*(.*)$/i.exec(lines[i]!);
    if (!m) continue;
    const inline = m[1]!.trim();
    if (inline) return { attendees: inlineAttendees(inline), end: end + 1 };
    const items: CallAttendee[] = [];
    for (let j = i + 1; j < end && /^\s+-\s+/.test(lines[j]!); j++) {
      const a = attendeeOf(lines[j]!.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, ''));
      if (a) items.push(a);
    }
    return { attendees: items, end: end + 1 };
  }
  return { attendees: null, end: end + 1 };
}

/** The attendees the call's header names, in order, or null when the header names none. */
export function parseCallAttendees(text: string): CallAttendee[] | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const fm = frontmatterAttendees(lines);
  if (fm.attendees) return fm.attendees;
  let seenText = false;
  for (let i = fm.end; i < Math.min(lines.length, fm.end + HEADER_LINES); i++) {
    const line = lines[i]!.trim();
    if (!line) { if (seenText) break; continue; }
    const list = LIST_LINE_RE.exec(line);
    if (list) return splitList(list[2]!);
    const turn = TURN_RE.exec(line);
    if (turn && !HEADER_LABELS.has(turn[1]!.trim().toLowerCase())) break;
    seenText = true;
  }
  return null;
}

/** How one attendee entry resolved. */
export type AttendeeMatch =
  | { kind: 'member'; member: string; by: 'email' | 'id' | 'name' }
  | { kind: 'owner' }
  | { kind: 'unmatched' };

const fold = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Exact match of one attendee against the enabled person members (see the file comment). */
export function matchAttendee(attendee: CallAttendee, members: readonly MemberRecord[]): AttendeeMatch {
  const people = members.filter(m => m.status === 'enabled' && m.kind === 'person');
  if (attendee.email) {
    const hit = people.filter(m => fold(m.email) === attendee.email);
    return hit.length === 1 ? { kind: 'member', member: hit[0]!.id, by: 'email' } : { kind: 'unmatched' };
  }
  const key = fold(attendee.entry);
  if (key === 'owner') return { kind: 'owner' };
  const byId = people.find(m => fold(m.id) === key);
  if (byId) return { kind: 'member', member: byId.id, by: 'id' };
  const byName = people.filter(m => fold(m.display_name) === key);
  return byName.length === 1 ? { kind: 'member', member: byName[0]!.id, by: 'name' } : { kind: 'unmatched' };
}

/** The readers a call page gets: the owner first, then each matched teammate once, with how each matched and what did not. */
export interface CallReaders {
  readers: string[];
  matched_by: Record<string, 'email' | 'id' | 'name'>;
  unmatched: string[];
  /** The call names no attendees, so it is kept to the owner. */
  no_list: boolean;
}

export function callReadersFor(attendees: CallAttendee[] | null, owner: string, members: readonly MemberRecord[]): CallReaders {
  const readers = [owner];
  const matched_by: CallReaders['matched_by'] = {};
  const unmatched: string[] = [];
  for (const a of attendees ?? []) {
    const m = matchAttendee(a, members);
    if (m.kind === 'unmatched') { if (!unmatched.includes(a.entry)) unmatched.push(a.entry); continue; }
    if (m.kind === 'owner' || readers.includes(m.member)) continue;
    readers.push(m.member);
    matched_by[m.member] = m.by;
  }
  return { readers, matched_by, unmatched, no_list: attendees === null || attendees.length === 0 };
}
