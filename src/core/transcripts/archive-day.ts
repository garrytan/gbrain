/**
 * archive-day.ts — the conversation archive's day layout (GST-2768).
 *
 * One page per (harness, conversation, local day). The day comes from the source's pinned timezone, while the
 * message anchors inside the body stay UTC exactly as the per-session renderer writes them. Day pages live in their
 * own slug and id namespace, so they never meet a per-session page:
 *
 *   slug  conversations/<harness>/<YYYY-MM-DD>/<label>-<id8>      (parts 2..N append -pN)
 *   id    <harness>-<hash16>-d<YYYYMMDD>-pN                      (per-session pages use <harness>-<hash16>-pN)
 *
 * The label never carries a raw chat id or name: dm, group-<hash8>, room-<hash8>, cron-<job> from verified channel
 * metadata, else the harness name. The body, escaping and part split are the per-session renderer's
 * (renderSessionParts) run over the day's already-redacted messages; only the slug, id and frontmatter differ.
 * transcript_import stays on every day page (audit-secrets and Dream select on it) with layout: day, and
 * transcript_archive records the day, the pinned timezone and what the day holds.
 */

import { createHash } from 'node:crypto';
import { slugifySegment } from '../sync.ts';
import type { TranscriptFormat, TranscriptMessage } from './types.ts';
import { transcriptFullId, transcriptSlugId } from './types.ts';
import { renderPartContent, renderSessionParts, type RedactedSession, type RenderedPart } from './render.ts';

export type ArchiveChatType = 'direct' | 'group' | 'room';

export interface ArchiveChannel {
  /** From the harness's own session row; only a verified value can widen a page to a group. */
  chatType?: ArchiveChatType;
  verified: boolean;
  cronJob?: string;
}

/** YYYY-MM-DD of an instant in timeZone. */
export function localDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return get('year') + '-' + get('month') + '-' + get('day');
}

/** Throws a RangeError for a zone this runtime does not know. */
export function assertTimeZone(timeZone: string): string {
  new Intl.DateTimeFormat('en-CA', { timeZone });
  return timeZone;
}

/** day plus delta calendar days. */
export function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export interface DaySlice { day: string; messages: TranscriptMessage[]; indexes: number[] }

/**
 * Group messages by local day, oldest day first. A message without a timestamp carries the previous message's day
 * (the renderer carries its anchor the same way); one before any timestamp joins the first dated day.
 */
export function sliceSessionByDay(messages: readonly TranscriptMessage[], timeZone: string): DaySlice[] {
  const byDay = new Map<string, DaySlice>();
  let current: string | null = null;
  const pending: number[] = [];
  messages.forEach((m, i) => {
    if (m.timestamp && !Number.isNaN(Date.parse(m.timestamp))) current = localDay(m.timestamp, timeZone);
    if (current === null) { pending.push(i); return; }
    let slice = byDay.get(current);
    if (!slice) byDay.set(current, slice = { day: current, messages: [], indexes: [] });
    for (const p of pending.splice(0)) { slice.messages.push(messages[p]!); slice.indexes.push(p); }
    slice.messages.push(m);
    slice.indexes.push(i);
  });
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** 8 hex chars naming a conversation inside a label or a group principal; never the raw key. */
export function conversationHash8(harness: TranscriptFormat, conversationKey: string): string {
  return createHash('sha256').update(harness + ':' + conversationKey).digest('hex').slice(0, 8);
}

export function conversationLabel(harness: TranscriptFormat, conversationKey: string, channel?: ArchiveChannel): string {
  if (channel?.cronJob) return 'cron-' + (slugifySegment(channel.cronJob).slice(0, 24) || conversationHash8(harness, conversationKey));
  if (channel?.verified && (channel.chatType === 'group' || channel.chatType === 'room')) return channel.chatType + '-' + conversationHash8(harness, conversationKey);
  if (channel?.verified && channel.chatType === 'direct') return 'dm';
  return harness;
}

export function archiveDayBaseSlug(harness: TranscriptFormat, day: string, label: string, conversationKey: string): string {
  return 'conversations/' + harness + '/' + day + '/' + label + '-' + transcriptSlugId(conversationKey).slice(0, 8);
}

export function archiveDayId(harness: TranscriptFormat, conversationKey: string, day: string, part: number): string {
  return harness + '-' + transcriptFullId(conversationKey) + '-d' + day.replace(/-/g, '') + '-p' + part;
}

/** Counts of <REDACTED:rule> markers per rule in the day's text: the per-day receipt (never values). */
export function redactionCounts(messages: readonly TranscriptMessage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of messages) {
    for (const hit of (m.text + '\n' + (m.speaker ?? '')).matchAll(/<REDACTED:([A-Za-z0-9_.-]+)>/g)) out[hit[1]!] = (out[hit[1]!] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export interface ArchiveDayInput {
  harness: TranscriptFormat;
  conversationKey: string;
  channel?: ArchiveChannel;
  day: string;
  timezone: string;
  /** The whole session, redacted (redaction always runs over every day of it). */
  redacted: RedactedSession;
  slice: DaySlice;
  complete: boolean;
  partTargetBytes: number;
  readableBy?: string[];
}

export interface ArchiveDayRender { baseSlug: string; parts: RenderedPart[]; messages: number }

export function renderArchiveDay(input: ArchiveDayInput): ArchiveDayRender {
  const { harness, conversationKey, day, slice, redacted } = input;
  const flags = redacted.imperativeFlags;
  const sub: RedactedSession = {
    session: { meta: { ...redacted.session.meta, startedAt: slice.messages.find(m => m.timestamp)?.timestamp }, messages: slice.messages },
    redactionCount: 0,
    imperativesFlagged: flags ? slice.indexes.filter(i => flags[i]).length : 0,
    ...(flags ? { imperativeFlags: slice.indexes.map(i => flags[i] === true) } : {}),
  };
  const rendered = renderSessionParts(sub, { sourcePath: '', layout: 'single', partTargetBytes: input.partTargetBytes });
  const label = conversationLabel(harness, conversationKey, input.channel);
  const baseSlug = archiveDayBaseSlug(harness, day, label, conversationKey);
  const timestamps = slice.messages.map(m => m.timestamp).filter(Boolean);
  const single = rendered.parts.length === 1;
  const archive = {
    layout: 'day',
    harness,
    conversation_key_hash: transcriptFullId(conversationKey),
    day,
    timezone: input.timezone,
    ...(input.channel?.verified && input.channel.chatType ? { chat_type: input.channel.chatType } : {}),
    first_ts: timestamps[0] ?? null,
    last_ts: timestamps[timestamps.length - 1] ?? null,
    messages: slice.messages.length,
    redactions: redactionCounts(slice.messages),
    complete: input.complete,
  };
  const parts = rendered.parts.map((part): RenderedPart => {
    const slug = part.part === 1 ? baseSlug : baseSlug + '-p' + part.part;
    const frontmatterId = archiveDayId(harness, conversationKey, day, part.part);
    const imported = part.frontmatter.transcript_import as Record<string, unknown>;
    const frontmatter: Record<string, unknown> = {
      type: 'conversation',
      title: harness + ' ' + label + ' ' + day + (single ? '' : ' (part ' + part.part + ')'),
      date: day,
      id: frontmatterId,
      ...(input.readableBy ? { readable_by: input.readableBy } : {}),
      transcript_import: { ...imported, layout: 'day', day },
      transcript_archive: archive,
    };
    return { ...part, slug, frontmatterId, frontmatter, content: renderPartContent(frontmatter, part.body) };
  });
  return { baseSlug, parts, messages: slice.messages.length };
}

export interface DayIndexEntry { slug: string; harness: string; messages: number }

/** conversations/days/<day>: the day's conversation pages with message counts, so a dated question has one place to land. */
export function renderDayIndex(day: string, timezone: string, entries: readonly DayIndexEntry[], readableBy?: string[]): RenderedPart {
  const sorted = [...entries].sort((a, b) => a.harness.localeCompare(b.harness) || a.slug.localeCompare(b.slug));
  const frontmatter: Record<string, unknown> = {
    type: 'conversation',
    title: 'Conversations on ' + day,
    date: day,
    id: 'archive-day-index-d' + day.replace(/-/g, ''),
    ...(readableBy ? { readable_by: readableBy } : {}),
    transcript_archive_index: { day, timezone, conversations: sorted.length },
  };
  const lines = sorted.map(e => '- [[' + e.slug + ']] (' + e.harness + ', ' + e.messages + ' message' + (e.messages === 1 ? '' : 's') + ')');
  const body = ['# Conversations on ' + day, '', ...lines].join('\n');
  return { slug: 'conversations/days/' + day, content: renderPartContent(frontmatter, body), frontmatterId: String(frontmatter.id), part: 1, frontmatter, body };
}
