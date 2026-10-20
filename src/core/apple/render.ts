/**
 * apple-render — pure render functions for the apple source kind.
 *
 * No I/O, no engine, no clock: normalized reader data in, `{ relPath,
 * markdown }` out. Deterministic by construction (same input → same bytes),
 * which is what lets the sweep hash-diff pages instead of re-importing them.
 *
 * Trust boundary: every string that comes from Apple (mail bodies, event
 * notes, subjects, display names) is untrusted data. Free text lives only
 *   - in double-quoted JSON-escaped YAML scalars (frontmatter), or
 *   - inside a code fence whose length exceeds every backtick run in the text
 *     (bodies, notes), so it can neither close the fence nor open structure
 *     (frontmatter delimiters, headings, timeline sentinels, wikilinks), or
 *   - collapsed to one line with link/HTML brackets neutralised (headings and
 *     metadata lines, see `inline`).
 */
import { compactMailMessage } from './loop-evidence.ts';
import type { AppleLoopMessage } from './types.ts';
import { createHash } from 'node:crypto';

import { isNoiseSender, sha8, subjectSlug } from '../google/google-render.ts';
import {
  DEFAULT_CONTACTS_DIR,
  type AppleCalendarEvent,
  type AppleContact,
  type AppleMailMessage,
} from './types.ts';

export interface RenderedPage {
  relPath: string;
  markdown: string;
}

/** Hard cap on one rendered free-text block (the readers cap mail at 20000 too). */
export const APPLE_TEXT_CAP = 20_000;

// ── Small helpers ────────────────────────────────────────────────────────────

/**
 * A double-quoted YAML scalar. JSON.stringify escapes C0 controls but leaves DEL, the C1 controls
 * (U+0080-U+009F, which includes NEL) and the Unicode line separators raw; YAML would read those
 * as line breaks / controls, so they are written as \uXXXX escapes (valid in YAML double quotes).
 */
const yamlStr = (v: string): string =>
  JSON.stringify(v).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function yamlList(v: readonly string[]): string {
  if (v.length === 0) return '[]';
  return `\n${v.map((s) => `  - ${yamlStr(s)}`).join('\n')}`;
}

/** sha256 over the rendered page's path and bytes: the sweep's change detector (not a stored-page content hash). */
export function renderedHash(relPath: string, markdown: string): string {
  return createHash('sha256').update(relPath).update('\0').update(markdown).digest('hex');
}

/**
 * One line of untrusted text for a heading or metadata line: control
 * characters and runs of whitespace collapse to one space, square and angle
 * brackets become parentheses (no wikilink, link, image or HTML construct can
 * form), and the result is length-capped.
 */
export function inline(raw: string, max = 200): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/</g, '(')
    .replace(/>/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Untrusted text for a frontmatter `title`/alias: one line (control characters
 * collapse to a space) with wikilink brackets neutralised. It stays inside a
 * JSON-quoted YAML scalar, so no other escaping is needed.
 */
export function titleText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\[\[/g, '((')
    .replace(/\]\]/g, '))')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Untrusted multi-line text as an inert fenced block. The fence is one
 * backtick longer than the longest backtick run anywhere in the text (minimum
 * three), so no line of the text can close it; line endings are normalised so
 * a bare CR cannot smuggle a line break past the scanner.
 */
export function fenceQuote(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').slice(0, APPLE_TEXT_CAP).replace(/\n+$/g, '');
  let longest = 0;
  for (const run of normalized.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${normalized}\n${fence}`;
}

/** `YYYY-MM-DD` of an ISO string as written (the local calendar day the user saw), else UTC from the parsed instant. */
export function isoDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(iso);
  const d = new Date(Number.isFinite(t) ? t : 0);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** `YYYY-MM-DD HH:MM` of an ISO string as written (date only for all-day values). */
function isoMinute(iso: string): string {
  return iso.length > 10 ? iso.slice(0, 16).replace('T', ' ') : iso;
}

// ── Calendar ─────────────────────────────────────────────────────────────────

export function calendarItemKey(ev: Pick<AppleCalendarEvent, 'calendarId' | 'id'>): string {
  return `${ev.calendarId}:${ev.id}`;
}

export function calendarRelPath(ev: AppleCalendarEvent): string {
  const day = isoDay(ev.start);
  const [yyyy, mm] = day.split('-');
  return `calendar/${yyyy}/${mm}/${day}-${subjectSlug(ev.title)}-${sha8(calendarItemKey(ev))}.md`;
}

const isCancelled = (status: string | undefined): boolean => /^cancel+ed$/i.test((status ?? '').trim());

/** Cancelled events return null (and a `--full` sweep reconciles the page away). */
export function renderCalendarEventPage(ev: AppleCalendarEvent, account: string): RenderedPage | null {
  if (isCancelled(ev.status)) return null;
  const title = titleText(ev.title) || '(untitled event)';
  // EventKit returns attendees in no stable order (observed on a live Mac: the same event listed
  // them differently on consecutive syncs, so the hash-diff rewrote unchanged pages every run).
  // Sort them so the rendered bytes depend only on the event's content.
  const attendees = ev.attendees
    .map((a) => ({ name: (a.name ?? '').trim(), email: (a.email ?? '').trim() }))
    .filter((a) => a.name.length > 0 || a.email.length > 0)
    .sort((a, b) => (a.email || a.name).localeCompare(b.email || b.name) || a.name.localeCompare(b.name));
  const fm: string[] = [
    '---',
    'type: meeting',
    `title: ${yamlStr(title)}`,
    `apple_event_id: ${yamlStr(ev.id)}`,
    `apple_calendar_id: ${yamlStr(ev.calendarId)}`,
    `calendar: ${yamlStr(ev.calendarTitle)}`,
    `account: ${yamlStr(account)}`,
    `start: ${yamlStr(ev.start)}`,
    `end: ${yamlStr(ev.end)}`,
    `all_day: ${ev.allDay === true}`,
    `organizer: ${yamlStr(ev.organizer ?? '')}`,
    `attendees: ${yamlList(attendees.map((a) => a.email || a.name))}`,
    ...(ev.location ? [`location: ${yamlStr(ev.location)}`] : []),
    `recurring: ${ev.recurring === true}`,
    ...(ev.status ? [`status: ${yamlStr(ev.status)}`] : []),
    'source_kind: apple',
    '---',
  ];
  const when = ev.allDay
    ? `${ev.start.slice(0, 10)}${ev.end && ev.end.slice(0, 10) !== ev.start.slice(0, 10) ? ` → ${ev.end.slice(0, 10)}` : ''} (all day)`
    : `${isoMinute(ev.start)} → ${ev.end.slice(0, 10) === ev.start.slice(0, 10) ? ev.end.slice(11, 16) || ev.end.slice(0, 10) : isoMinute(ev.end)}`;
  const body: string[] = [
    '',
    `# ${inline(title)}`,
    '',
    `${when}${ev.location ? ` · ${inline(ev.location)}` : ''}${ev.calendarTitle ? ` · ${inline(ev.calendarTitle, 80)}` : ''}`,
    '',
  ];
  if (attendees.length > 0) {
    body.push('## Attendees', '');
    for (const a of attendees) {
      body.push(`- ${a.name && a.email ? `${inline(a.name)} (${inline(a.email)})` : inline(a.email || a.name)}`);
    }
    body.push('');
  }
  if (ev.notes && ev.notes.trim()) body.push('## Notes', '', fenceQuote(ev.notes), '');
  body.push('[Source: Apple Calendar]', '');
  return { relPath: calendarRelPath(ev), markdown: fm.join('\n') + body.join('\n') };
}

// ── Contacts ─────────────────────────────────────────────────────────────────

/**
 * The page a contact with no usable name or email lives at, keyed on its id
 * (never on phone digits).
 */
export function contactIdSlug(contactId: string, dir: string = DEFAULT_CONTACTS_DIR): string {
  return `${dir}/contact-${sha8(contactId)}`;
}

export function contactDisplayName(c: AppleContact): string {
  const full = [c.givenName, c.familyName].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  return full || (c.nickname ?? '').trim() || (c.organization ?? '').trim();
}

/**
 * E.164 when the number states its country (`+` or `00` prefix, 8–15 digits);
 * otherwise exactly as entered (trimmed). No region is ever guessed.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const international = /^(\+|00)/.test(trimmed);
  if (!international) return trimmed;
  const digits = trimmed.replace(/^(\+|00)/, '').replace(/[\s().\-\u00a0]/g, '');
  return /^\d{8,15}$/.test(digits) && !digits.startsWith('0') ? `+${digits}` : trimmed;
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');

/**
 * The slug (no extension) a contact renders at, or null when it renders
 * nothing (no name, no email, no phone). A contact without a usable name is
 * keyed on its id (`contact-<sha8(id)>`), never on an email local part or
 * phone digits, so a page path never leaks an address.
 */
export function personSlugFromContact(c: AppleContact, disambiguate = false, dir: string = DEFAULT_CONTACTS_DIR): string | null {
  const emails = c.emails.map((e) => e.trim()).filter(Boolean);
  const phones = c.phones.map((p) => p.trim()).filter(Boolean);
  const name = contactDisplayName(c);
  if (!name && emails.length === 0 && phones.length === 0) return null;
  const base = slugify(name);
  if (!base) return contactIdSlug(c.id, dir);
  return disambiguate ? `${dir}/${base}-${sha8(c.id)}` : `${dir}/${base}`;
}

/**
 * Ownership rule (enforced in the sweep): a page carrying `apple_contact_id`
 * is connector-owned and fully re-rendered; a hand-authored page at the same
 * path is skipped entirely.
 */
export function renderPersonPage(c: AppleContact, disambiguate = false, dir: string = DEFAULT_CONTACTS_DIR): RenderedPage | null {
  const slug = personSlugFromContact(c, disambiguate, dir);
  if (!slug) return null;
  const emails = [...new Set(c.emails.map((e) => e.trim()).filter(Boolean))];
  const phones = [...new Set(c.phones.map((p) => normalizePhone(p)).filter(Boolean))];
  const groups = [...new Set(c.groups.map((g) => g.trim()).filter(Boolean))];
  const displayName = titleText(contactDisplayName(c));
  const name = displayName || emails[0] || phones[0] || `Contact ${sha8(c.id)}`;
  const aliases = [...new Set([...emails, ...(displayName ? [displayName] : []), ...(titleText(c.nickname ?? '') ? [titleText(c.nickname ?? '')] : [])])];
  const org = titleText(c.organization ?? '');
  const job = titleText(c.jobTitle ?? '');
  const fm: string[] = [
    '---',
    'type: person',
    `title: ${yamlStr(name)}`,
    `aliases: ${yamlList(aliases)}`,
    `emails: ${yamlList(emails)}`,
    ...(phones.length > 0 ? [`phones: ${yamlList(phones)}`] : []),
    `apple_contact_id: ${yamlStr(c.id)}`,
    ...(org ? [`company: ${yamlStr(org)}`] : []),
    ...(job ? [`role: ${yamlStr(job)}`] : []),
    ...(groups.length > 0 ? [`groups: ${yamlList(groups)}`] : []),
    'source_kind: apple',
    '---',
  ];
  const contactLine = [...emails, ...phones].map((v) => inline(v)).join(', ');
  const body = [
    '',
    `# ${inline(name)}`,
    '',
    [
      job && org ? `${inline(job)} at ${inline(org)}.` : org ? `Works at ${inline(org)}.` : null,
      contactLine ? `Contact: ${contactLine}.` : null,
      '[Source: Apple Contacts]',
    ]
      .filter(Boolean)
      .join(' '),
    '',
    '## Open Threads',
    '',
    '_none yet_',
    '',
  ];
  return { relPath: `${slug}.md`, markdown: fm.join('\n') + body.join('\n') };
}

// ── Mail ─────────────────────────────────────────────────────────────────────

export interface AppleMailThread {
  threadId: string;
  /** Ordered by date (ties by id). */
  messages: AppleMailMessage[];
}

const msgMs = (m: AppleMailMessage): number => {
  const t = Date.parse(m.date);
  return Number.isFinite(t) ? t : 0;
};

/** Group messages by thread, each thread's messages ordered by date then id; threads ordered by id. */
export function groupMailThreads(messages: readonly AppleMailMessage[]): AppleMailThread[] {
  const byThread = new Map<string, AppleMailMessage[]>();
  for (const m of messages) {
    const key = m.threadId || m.id;
    const list = byThread.get(key);
    if (list) list.push(m);
    else byThread.set(key, [m]);
  }
  return [...byThread.entries()]
    .map(([threadId, list]) => ({
      threadId,
      messages: [...list].sort((a, b) => msgMs(a) - msgMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }))
    .sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
}

/** Bare lower-cased address of a `Name <addr>` / `addr` string; otherwise the trimmed text. */
export function bareAddress(raw: string): string {
  const angle = /<([^<>]+)>/.exec(raw);
  return (angle ? angle[1] : raw).trim().toLowerCase();
}

export function mailRelPath(thread: AppleMailThread): string {
  const first = thread.messages[0];
  const day = isoDay(first?.date ?? '');
  const [yyyy, mm] = day.split('-');
  return `emails/${yyyy}/${mm}/${day}-${subjectSlug(first?.subject ?? '')}-${sha8(thread.threadId)}.md`;
}

const isSentMailbox = (mailbox: string): boolean => /^sent/i.test(mailbox.trim());

/** One message as a self-contained block (heading, recipients, inert fenced body), no trailing blank line. */
export function mailMessageBlock(m: AppleMailMessage): string {
  const lines: string[] = [`## ${isSentMailbox(m.mailbox) ? '→ ' : ''}${inline(m.from) || '(unknown sender)'} · ${isoMinute(m.date)}`, ''];
  if (m.to.length > 0 || m.cc.length > 0) {
    lines.push(`To: ${m.to.map((a) => inline(a)).join(', ')}${m.cc.length > 0 ? ` · Cc: ${m.cc.map((a) => inline(a)).join(', ')}` : ''}`, '');
  }
  lines.push(m.body.trim() ? fenceQuote(m.body) : '_empty message_');
  return lines.join('\n');
}

const MAIL_FOOTER = '[Source: Apple Mail]';

/**
 * What an existing thread page already holds. The reader only returns the
 * configured window, so as a conversation outlives it the oldest messages stop
 * being listed; their blocks are carried forward from the page instead of
 * being dropped (and the page keeps its path, first date and subject).
 */
export interface MailPrior {
  relPath: string;
  subject: string;
  firstDate: string;
  /** Message ids in page order; `blocks[i]` renders `ids[i]`. */
  ids: string[];
  blocks: string[];
  /** Timestamp aligned with ids; parsed from rendered headings for legacy pages. */
  dates: string[];
  loopMessages?: AppleLoopMessage[];
  latest: { id?: string; date: string; from: string; to: string[]; cc: string[]; mailbox: string };
  participants: string[];
  senders: string[];
  mailboxes: string[];
}

/**
 * Split a thread page body back into per-message blocks. Only the exact shape
 * this module renders is recognised: a `## ` heading outside a fence starts a
 * block, a fence is a line of 3+ backticks and closes only on the identical
 * line, and the footer ends the last block.
 */
export function parseMailBlocks(body: string): string[] {
  const blocks: string[] = [];
  let cur: string[] | null = null;
  let fence: string | null = null;
  const flush = (): void => {
    if (cur) blocks.push(cur.join('\n').replace(/\n+$/g, ''));
    cur = null;
  };
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence !== null) {
      cur!.push(line);
      if (line === fence) fence = null;
      continue;
    }
    if (line.startsWith('## ')) { flush(); cur = [line]; continue; }
    if (line === MAIL_FOOTER) { flush(); continue; }
    if (cur) {
      const open = /^(`{3,})$/.exec(line);
      if (open) fence = open[1];
      cur.push(line);
    }
  }
  flush();
  return blocks;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Build a MailPrior from a stored page's frontmatter and body; null when the page is not in a shape this module can carry forward. */
export function mailPriorFromPage(relPath: string, frontmatter: Record<string, unknown>, body: string, title: string | null): MailPrior | null {
  const ids = strList(frontmatter.apple_message_ids);
  const blocks = parseMailBlocks(body);
  if (ids.length === 0 || blocks.length !== ids.length) return null;
  if (!title || typeof frontmatter.first_message_date !== 'string') return null;
  const dates = ids.map((_, i) => {
    const stored = strList(frontmatter.apple_message_dates)[i];
    if (stored) return stored;
    const stamp = /^## .* · (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)/.exec(blocks[i] ?? '')?.[1];
    return stamp ? `${stamp.replace(' ', 'T')}:00Z` : frontmatter.first_message_date as string;
  });
  return {
    relPath, subject: titleText(title), firstDate: frontmatter.first_message_date, ids, blocks, dates,
    loopMessages: Array.isArray(frontmatter.apple_loop_messages) ? frontmatter.apple_loop_messages as AppleLoopMessage[] : [],
    latest: { id: ids[ids.length - 1], date: typeof frontmatter.date === 'string' ? frontmatter.date : frontmatter.first_message_date,
      from: typeof frontmatter.from === 'string' ? frontmatter.from : '', to: strList(frontmatter.to), cc: strList(frontmatter.cc),
      mailbox: typeof frontmatter.mailbox === 'string' ? frontmatter.mailbox : '' },
    participants: strList(frontmatter.participants), senders: strList(frontmatter.senders), mailboxes: strList(frontmatter.mailboxes),
  };
}

/**
 * Render one thread as a page (`type: email`, the same type google-render
 * uses). Pure automated mail (every listed message from a noise sender)
 * renders nothing, matching the Google connector. With `prior`, messages the
 * page holds that the reader no longer lists are carried forward verbatim.
 */
export function renderMailThreadPage(thread: AppleMailThread, account: string, prior?: MailPrior | null): RenderedPage | null {
  const current = [...thread.messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (current.length === 0 || current.every((m) => isNoiseSender(bareAddress(m.from)))) return null;
  const listed = new Set(current.map((m) => m.id));
  const keepIdx = prior ? prior.ids.map((id, i) => (listed.has(id) ? -1 : i)).filter((i) => i >= 0) : [];
  const carriedIds = prior ? keepIdx.map((i) => prior.ids[i]) : [];
  const carrying = prior != null && carriedIds.length > 0;
  const subject = carrying ? prior.subject : titleText(current[0]!.subject) || '(no subject)';
  const firstDate = carrying ? prior.firstDate : current[0]!.date;
  const relPath = carrying ? prior.relPath : mailRelPath({ ...thread, messages: current });
  const participants = new Set<string>(carrying ? prior.participants : []);
  const senders = new Set<string>(carrying ? prior.senders : []);
  for (const m of current) {
    const from = bareAddress(m.from);
    if (from) { participants.add(from); senders.add(from); }
    for (const a of [...m.to, ...m.cc]) { const addr = bareAddress(a); if (addr) participants.add(addr); }
  }
  const mailboxes = [...new Set([...(carrying ? prior.mailboxes : []), ...current.map((m) => m.mailbox)])].sort();
  const entries = new Map<string, { date: string; block: string }>();
  if (carrying && prior) for (const i of keepIdx) entries.set(prior.ids[i]!, { date: prior.dates[i] ?? prior.firstDate, block: prior.blocks[i]! });
  for (const m of current) entries.set(m.id, { date: m.date, block: mailMessageBlock(m) });
  const merged = [...entries.entries()].map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const currentLatest = current[current.length - 1]!;
  const latest = carrying && prior && (Date.parse(prior.latest.date) > Date.parse(currentLatest.date)
    || (Date.parse(prior.latest.date) === Date.parse(currentLatest.date) && (prior.latest.id ?? '') > currentLatest.id)) ? prior.latest : currentLatest;
  const ids = merged.map((m) => m.id);
  const loopById = new Map((carrying ? prior?.loopMessages ?? [] : []).map(m => [m.id, m]));
  for (const m of current) {
    const compact = compactMailMessage(m);
    if (compact) loopById.set(m.id, compact); else loopById.delete(m.id);
  }
  const loopMessages = ids.flatMap(id => loopById.has(id) ? [loopById.get(id)!] : []);
  const fm: string[] = [
    '---', 'type: email', `title: ${yamlStr(subject)}`, `apple_thread_id: ${yamlStr(thread.threadId)}`,
    `apple_message_ids: ${yamlList(ids)}`, `apple_message_dates: ${yamlList(merged.map((m) => m.date))}`,
    `apple_loop_messages: ${JSON.stringify(loopMessages)}`, `message_id: ${yamlStr(ids[ids.length - 1] ?? '')}`,
    `account: ${yamlStr(account)}`, `mailbox: ${yamlStr(latest.mailbox)}`, `mailboxes: ${yamlList(mailboxes)}`,
    `from: ${yamlStr(latest.from)}`, `to: ${yamlList(latest.to)}`, `cc: ${yamlList(latest.cc)}`,
    `date: ${yamlStr(latest.date)}`, `first_message_date: ${yamlStr(firstDate)}`, `message_count: ${ids.length}`,
    `participants: ${yamlList([...participants].sort())}`, `senders: ${yamlList([...senders].sort())}`, 'source_kind: apple', '---',
  ];
  const body: string[] = ['', `# ${inline(subject)}`, ''];
  for (const item of merged) body.push(item.block, '');
  body.push(MAIL_FOOTER, '');
  return { relPath, markdown: fm.join('\n') + body.join('\n') };
}
