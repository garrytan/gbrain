/**
 * One meeting → one `meeting` page. Frontmatter is serialized as data, never
 * built from strings. Every provider-authored field passes through
 * `neutralizeOutsideText` on its own, so no title, summary, action item or
 * sentence can open a facts fence, forge a timeline row or a speaker turn;
 * gbrain's own structure (headings, metadata labels, transcript anchors) is
 * composed around the neutralized text. Run ids and fetch times stay out of
 * the page so an unchanged meeting renders byte-identical and publishes nothing.
 */
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { neutralizeOutsideText } from '../outside-content.ts';
import { slugifySegment } from '../sync.ts';
import type { MeetingAccount, MeetingRecord, MeetingsSourceConfig } from './types.ts';

/** A rendered page larger than this is held, never truncated. */
export const MAX_MEETING_PAGE_BYTES = 2 * 1024 * 1024;

export class MeetingPageTooLargeError extends Error {
  readonly code = 'connector_item_too_large';
  constructor(readonly bytes: number) {
    super(`the rendered meeting page is ${bytes} bytes, over the ${MAX_MEETING_PAGE_BYTES}-byte limit; it was held, not truncated`);
    this.name = 'MeetingPageTooLargeError';
  }
}

/** Outside text on one line: whitespace collapsed, then neutralized. */
const inline = (text: string) => neutralizeOutsideText(text.replace(/\s+/g, ' ').trim());
/** A speaker name inside gbrain's own `**Name** (hh:mm:ss):` anchor: no emphasis, colon or bracket can break out of it. */
const speakerName = (text: string) => inline(text.replace(/[*:()[\]]/g, ' ')) || 'Unknown speaker';

function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '00:00:00';
  const s = Math.floor(seconds);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':');
}

/** The page path for a new meeting: date, title and a short id suffix. An existing page keeps the path it was first written at. */
export function meetingPagePath(record: Pick<MeetingRecord, 'id' | 'title' | 'startedAt'>): string {
  const title = slugifySegment(record.title).slice(0, 60).replace(/-+$/, '') || 'meeting';
  const id = slugifySegment(record.id).replace(/-/g, '').slice(-6) || 'id';
  return `meetings/${record.startedAt.slice(0, 10)}-${title}-${id}.md`;
}

/**
 * D7 attendance rule: the key's owner attended when their account email is the organizer's or any attendee's
 * (case-insensitive). An account with no email cannot be shown to have attended, so its meetings are private.
 */
export function ownerAttended(record: MeetingRecord, account: MeetingAccount): boolean {
  const email = account.email?.toLowerCase();
  if (!email) return false;
  return record.organizerEmail === email || record.attendees.some(a => a.email === email);
}

export function attendeeLabel(a: { name: string | null; email: string | null }): string {
  return a.name ? (a.email ? `${a.name} <${a.email}>` : a.name) : a.email ?? 'unknown';
}

export function renderMeetingPage(record: MeetingRecord, opts: { cfg: Pick<MeetingsSourceConfig, 'provider' | 'privateOnly'>; account: MeetingAccount }): string {
  const isPrivate = opts.cfg.privateOnly || !ownerAttended(record, opts.account);
  const date = record.startedAt.slice(0, 10);
  const frontmatter: Record<string, unknown> = {
    type: 'meeting',
    title: record.title.replace(/\s+/g, ' ').trim(),
    date,
    started_at: record.startedAt,
    ...(record.durationSec !== null ? { duration_min: Math.round(record.durationSec / 60) } : {}),
    ...(record.organizerEmail ? { organizer: record.organizerEmail } : {}),
    attendees: record.attendees.map(attendeeLabel),
    ...(record.url ? { source_url: record.url } : {}),
    connector: 'meetings',
    provider: opts.cfg.provider,
    meeting_id: record.id,
    ...(opts.account.email ? { source_account: opts.account.email } : {}),
    ...(isPrivate ? { visibility: 'private' } : {}),
  };
  const lines: string[] = [`# ${inline(record.title) || 'Untitled meeting'}`, ''];
  lines.push(`**Date:** ${record.startedAt.slice(0, 16).replace('T', ' ')} UTC`);
  if (record.attendees.length) lines.push(`**Attendees:** ${record.attendees.map(a => inline(attendeeLabel(a))).join(', ')}`);
  if (record.organizerEmail) lines.push(`**Organizer:** ${inline(record.organizerEmail)}`);
  if (record.durationSec !== null) lines.push(`**Duration:** ${Math.round(record.durationSec / 60)} min`);
  lines.push('', '## Summary', '', record.summary ? neutralizeOutsideText(record.summary.trim()) : '_No summary from the provider._');
  if (record.actionItems.length) lines.push('', '## Action items', '', ...record.actionItems.map(item => `- ${inline(item)}`));
  if (record.keywords.length) lines.push('', '## Keywords', '', record.keywords.map(inline).join(', '));
  if (record.transcript?.length) {
    lines.push('', '## Transcript', '');
    for (const s of record.transcript) lines.push(`**${speakerName(s.speaker)}** (${clock(s.startSec)}): ${inline(s.text)}`);
  }
  const page = `---\n${dumpFrontmatterYaml(frontmatter, { lineWidth: 1000 })}---\n\n${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(page, 'utf8');
  if (bytes > MAX_MEETING_PAGE_BYTES) throw new MeetingPageTooLargeError(bytes);
  return page;
}
