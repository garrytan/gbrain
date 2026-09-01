/**
 * google-render — pure render functions for the google source kind.
 *
 * No I/O, no engine: raw normalized data in, { relPath, markdown } out.
 * Deterministic by construction — Gmail deep links are code-generated via
 * the typed emailCitation scaffold, never composed by an LLM.
 *
 * The noise/signature rules were SPECIFIED as prose in
 * recipes/email-to-brain.md for agent-authored collectors; this is their
 * first real implementation. Keep the two in sync.
 */

import { createHash } from 'node:crypto';

import { emailCitation } from '../output/scaffold.ts';
import type { CalendarEventData, ContactData, GmailThreadData } from './types.ts';

// ── Noise + signature rules (recipes/email-to-brain.md, now code) ───────────

const NOISE_SENDER_SUBSTRINGS = [
  'noreply',
  'no-reply',
  'notifications@',
  'notification@',
  'calendar-notification',
  'mailer-daemon',
  'postmaster',
  'donotreply',
  'do-not-reply',
];

export function isNoiseSender(fromAddress: string): boolean {
  const f = fromAddress.toLowerCase();
  return NOISE_SENDER_SUBSTRINGS.some((p) => f.includes(p));
}

/**
 * Google Calendar system mail — the invitation/response/cancellation notices
 * Calendar sends ON BEHALF OF a human organiser or attendee.
 *
 * Why this needs its own predicate: the mail arrives FROM the colleague's real
 * address, so neither isNoiseSender nor `loops mute sender` can exclude it —
 * muting the address would also silence that person's genuine email. In a
 * measured audit these notices were a large fraction of all open loops, every
 * one of them a "reply owed" that no human ever expected an answer to.
 *
 * PRIMARY signal is structural: a `calendarMethod` that is one of the
 * iCalendar METHOD values (RFC 5546 — REQUEST/REPLY/CANCEL/…), which Calendar
 * stamps on all of these and which ordinary human mail never has. Only the
 * allowlisted values count: an EMPTY method ('' — an .ics-ish part was seen
 * but no iCalendar METHOD was found, e.g. a human attaching an invite file)
 * and an unrecognised value are both deliberately NOT trusted as a stamp —
 * classifying them as system silenced genuine human questions, which could
 * then neither open nor close loops.
 *
 * The subject prefix is a deliberate FALLBACK, reached when no usable MIME
 * method was captured for the message. It is anchored to the start of the
 * subject and refuses anything carrying a Re:/Fwd: prefix, so a human forward
 * that happens to begin "Invitation: ..." still opens a loop. The prefixes
 * are Calendar's OWN localised headers only — a generic word like
 * "Notification:" is a human/vendor subject and must never match.
 */
const CALENDAR_METHODS = new Set([
  'REQUEST', 'REPLY', 'CANCEL', 'PUBLISH', 'COUNTER', 'DECLINECOUNTER', 'REFRESH', 'ADD',
]);

const CALENDAR_SUBJECT_PREFIXES = [
  // en
  'invitation:', 'updated invitation:', 'invitation with note:',
  'updated invitation with note:', 'accepted:', 'declined:', 'tentative:',
  'canceled event:', 'cancelled event:',
  // ru
  'приглашение:', 'обновлённое приглашение:', 'обновленное приглашение:',
  'принято:', 'отклонено:', 'под вопросом:', 'отменено:', 'отмена мероприятия:',
  // es / fr / de — the locales Calendar localises these headers into
  'invitación:', 'invitación actualizada:', 'aceptada:', 'rechazada:',
  'invitation mise à jour:', 'acceptée:', 'refusée:',
  'einladung:', 'aktualisierte einladung:', 'zugesagt:', 'abgesagt:',
];

const REPLY_OR_FORWARD_PREFIX = /^\s*((re|fwd?|aw|sv|vs)\s*:\s*)+/i;

export function isCalendarSystemMail(
  msg: { calendarMethod?: string | null; subject?: string },
): boolean {
  // Allowlisted iCalendar METHOD only; '' and unknown values fall through.
  if (msg.calendarMethod && CALENDAR_METHODS.has(msg.calendarMethod.trim().toUpperCase())) return true;
  const subject = (msg.subject ?? '').trim();
  // A human reply/forward is never Calendar system mail, whatever it is titled.
  if (REPLY_OR_FORWARD_PREFIX.test(subject)) return false;
  const lowered = subject.toLowerCase();
  return CALENDAR_SUBJECT_PREFIXES.some((p) => lowered.startsWith(p));
}

const SIGNATURE_PATTERNS = [
  /docusign/i,
  /dropbox sign/i,
  /hellosign/i,
  /pandadoc/i,
  /please sign/i,
  /signature needed/i,
  /ready for your signature/i,
  /everyone has signed/i,
  /you just signed/i,
];

/** Signature requests stay rendered (they're often real loops) but tagged. */
export function isSignatureRequest(subject: string, from: string): boolean {
  return SIGNATURE_PATTERNS.some((p) => p.test(subject) || p.test(from));
}

// ── HTML → text (hand-rolled; no dependency) ─────────────────────────────────

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};

export function htmlToText(html: string): string {
  let t = html;
  t = t.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n');
  t = t.replace(/<li[^>]*>/gi, '- ');
  t = t.replace(/<[^>]+>/g, '');
  for (const [k, v] of Object.entries(ENTITIES)) t = t.replaceAll(k, v);
  t = t.replace(/&#(\d+);/g, (_m, d: string) => {
    const n = Number(d);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
  // Collapse whitespace: runs of blank lines → one; trailing spaces gone.
  t = t
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .join('\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * Trim quoted-reply tails: trailing '>'-quoted runs and the "On ... wrote:"
 * marker line and everything after it. Conservative — only the TAIL is cut,
 * inline quotes mid-message survive.
 */
export function trimQuotedReply(text: string): string {
  const lines = text.split('\n');
  // Find the "On <date>, <name> wrote:" marker (also matches forwarded-message separators).
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^On .{4,80} wrote:$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(l)) {
      cut = i;
      break;
    }
  }
  let trimmed = lines.slice(0, cut);
  // Drop a trailing run of quoted lines (and blanks between them).
  let end = trimmed.length;
  while (end > 0) {
    const l = trimmed[end - 1].trim();
    if (l === '' || l.startsWith('>')) end--;
    else break;
  }
  trimmed = trimmed.slice(0, end);
  return trimmed.join('\n').trim();
}

// ── Thread page ──────────────────────────────────────────────────────────────

export function sha8(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export function subjectSlug(subject: string): string {
  const s = subject
    .replace(/^((re|fwd?|aw):\s*)+/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'no-subject';
}

function yamlStr(v: string): string {
  return JSON.stringify(v);
}

function yamlList(v: string[]): string {
  if (v.length === 0) return '[]';
  return `\n${v.map((s) => `  - ${yamlStr(s)}`).join('\n')}`;
}

/**
 * Stable path per thread: keyed on the FIRST message's date + de-prefixed
 * subject + sha8(threadId), so re-renders upsert the same page forever.
 */
export function threadRelPath(thread: GmailThreadData): string {
  const first = thread.messages[0];
  const d = new Date(first?.internalDateMs ?? 0);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `emails/${yyyy}/${mm}/${yyyy}-${mm}-${day}-${subjectSlug(first?.subject ?? '')}-${sha8(thread.threadId)}.md`;
}

export interface RenderedPage {
  relPath: string;
  markdown: string;
}

/**
 * Render one Gmail thread as a page. Returns null for pure noise (every
 * message from a noise sender) — those threads never materialize.
 */
export function renderThreadPage(thread: GmailThreadData): RenderedPage | null {
  if (thread.messages.length === 0) return null;
  const nonNoise = thread.messages.filter((m) => !isNoiseSender(m.fromAddress));
  if (nonNoise.length === 0) return null;

  const first = thread.messages[0];
  const last = thread.messages[thread.messages.length - 1];
  const subject = first.subject || '(no subject)';
  const signature = thread.messages.some((m) => isSignatureRequest(m.subject, m.from));
  const participants = new Set<string>();
  // Message AUTHORS only — `loops mute sender` gates on these, never on
  // recipients, so muting one person cannot silence a whole group thread.
  const senders = new Set<string>();
  for (const m of thread.messages) {
    participants.add(m.fromAddress);
    if (m.fromAddress) senders.add(m.fromAddress);
    for (const a of [...m.to, ...m.cc]) participants.add(a);
  }

  const fm: string[] = [
    '---',
    `type: email`,
    `title: ${yamlStr(subject)}`,
    `thread_id: ${yamlStr(thread.threadId)}`,
    `message_id: ${yamlStr(last.id)}`,
    `message_ids: ${yamlList(thread.messages.map((m) => m.id))}`,
    `account: ${yamlStr(thread.account)}`,
    `from: ${yamlStr(last.from)}`,
    `to: ${yamlList(last.to)}`,
    `cc: ${yamlList(last.cc)}`,
    `date: ${yamlStr(last.dateIso)}`,
    `first_message_date: ${yamlStr(first.dateIso)}`,
    `message_count: ${thread.messages.length}`,
    `participants: ${yamlList([...participants].sort())}`,
    `senders: ${yamlList([...senders].sort())}`,
    `labels: ${yamlList([...new Set(thread.messages.flatMap((m) => m.labelIds))].sort())}`,
    ...(signature ? [`noise: signature-request`] : []),
    '---',
  ];

  const body: string[] = ['', `# ${subject}`, ''];
  for (const m of thread.messages) {
    const cite = emailCitation({
      account: thread.account,
      messageId: m.id,
      subject: m.subject || subject,
      dateISO: m.dateIso.slice(0, 10),
    });
    const sent = m.labelIds.includes('SENT');
    body.push(
      `## ${sent ? '→ ' : ''}${m.from || m.fromAddress} · ${m.dateIso.slice(0, 16).replace('T', ' ')}`,
      '',
      cite,
      '',
    );
    if (m.to.length > 0) body.push(`To: ${m.to.join(', ')}${m.cc.length > 0 ? ` · Cc: ${m.cc.join(', ')}` : ''}`, '');
    body.push(m.bodyText || '_empty message_', '');
  }

  return { relPath: threadRelPath(thread), markdown: fm.join('\n') + body.join('\n') + '\n' };
}

// ── Calendar event page ──────────────────────────────────────────────────────

export function calendarRelPath(ev: CalendarEventData): string {
  const d = new Date(ev.startIso || 0);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `calendar/${yyyy}/${mm}/${yyyy}-${mm}-${day}-${subjectSlug(ev.summary)}-${sha8(ev.id)}.md`;
}

/** Cancelled instances return null (and the caller reconciles deletions). */
export function renderCalendarEventPage(ev: CalendarEventData): RenderedPage | null {
  if (ev.status === 'cancelled') return null;
  const attendees = ev.attendees.filter((a) => a.email.length > 0);
  const fm: string[] = [
    '---',
    `type: meeting`,
    `title: ${yamlStr(ev.summary)}`,
    `event_id: ${yamlStr(ev.id)}`,
    `account: ${yamlStr(ev.account)}`,
    `start: ${yamlStr(ev.startIso)}`,
    `end: ${yamlStr(ev.endIso)}`,
    `all_day: ${ev.allDay}`,
    `organizer: ${yamlStr(ev.organizer ?? '')}`,
    `attendees: ${yamlList(attendees.map((a) => a.email))}`,
    ...(ev.location ? [`location: ${yamlStr(ev.location)}`] : []),
    ...(ev.htmlLink ? [`url: ${yamlStr(ev.htmlLink)}`] : []),
    '---',
  ];
  const body: string[] = [
    '',
    `# ${ev.summary}`,
    '',
    `${ev.startIso.slice(0, 16).replace('T', ' ')} → ${ev.endIso.slice(11, 16) || ev.endIso.slice(0, 10)}${ev.location ? ` · ${ev.location}` : ''}`,
    '',
  ];
  if (attendees.length > 0) {
    body.push('## Attendees', '');
    for (const a of attendees) {
      body.push(`- ${a.displayName ? `${a.displayName} <${a.email}>` : a.email}${a.responseStatus ? ` · ${a.responseStatus}` : ''}`);
    }
    body.push('');
  }
  if (ev.description) body.push('## Description', '', htmlToText(ev.description), '');
  if (ev.hangoutLink) body.push(`Meet: ${ev.hangoutLink}`, '');
  return { relPath: calendarRelPath(ev), markdown: fm.join('\n') + body.join('\n') + '\n' };
}

// ── Person page (contacts) ───────────────────────────────────────────────────

export function personSlugFromContact(c: ContactData, disambiguate = false): string | null {
  const base = c.displayName ?? c.emails[0]?.split('@')[0] ?? null;
  if (!base) return null;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!slug) return null;
  // Two different contacts named "John Smith" must not fight over one page —
  // the caller requests disambiguation when the base slug is already owned
  // by a DIFFERENT google_contact_id.
  return disambiguate ? `people/${slug}-${sha8(c.resourceName)}` : `people/${slug}`;
}

/**
 * Render a person page for a contact. Ownership rule (enforced in
 * google-source.ts:sweepContacts): pages carrying the google_contact_id
 * marker are connector-owned and fully re-rendered; hand-authored pages at
 * the same path are skipped entirely — body AND frontmatter untouched.
 */
export function renderPersonPage(c: ContactData, disambiguate = false): RenderedPage | null {
  const slug = personSlugFromContact(c, disambiguate);
  if (!slug || c.emails.length === 0) return null;
  const name = c.displayName ?? c.emails[0];
  const aliases = [...new Set([...c.emails, ...(c.displayName ? [c.displayName] : [])])];
  const fm: string[] = [
    '---',
    `type: person`,
    `title: ${yamlStr(name)}`,
    `aliases: ${yamlList(aliases)}`,
    `emails: ${yamlList(c.emails)}`,
    `google_contact_id: ${yamlStr(c.resourceName)}`,
    ...(c.organization ? [`company: ${yamlStr(c.organization)}`] : []),
    ...(c.title ? [`role: ${yamlStr(c.title)}`] : []),
    '---',
  ];
  const body = [
    '',
    `# ${name}`,
    '',
    [
      c.title && c.organization ? `${c.title} at ${c.organization}.` : c.organization ? `Works at ${c.organization}.` : null,
      `Contact: ${c.emails.join(', ')}.`,
      `[Source: Google Contacts]`,
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
