/**
 * One iMessage chat day → one `imessage` page at `imessage/<chat-key>/<yyyy-mm-dd>.md`, in the inline-date chat layout
 * the conversation parser reads (`**Speaker** (YYYY-MM-DD H:MM AM): text`), the same layout Slack day pages use. The chat
 * key is a hash of the chat identifier, so no handle appears in a slug, a path or a log line. The day boundary is midnight
 * in the source's time zone. Every page is `visibility: private` and stamped `source_kind: imessage`, so a copy keeps
 * the external-untrusted tier.
 *
 * Every outside field passes through `neutralizeOutsideText`, and a continuation line shaped like a chat anchor is
 * escaped, so message text cannot forge another speaker, a timeline line or a gbrain marker. An unsent message is left
 * out, so the day converges when it is re-read inside the lookback. Nothing run-specific is rendered, so an unchanged
 * day renders byte-identical and publishes nothing.
 */
import { createHash } from 'node:crypto';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { neutralizeOutsideText } from '../outside-content.ts';
import { BUILTIN_PATTERNS } from '../conversation-parser/builtins.ts';
import type { IMessageMessage, IMessageThread } from './types.ts';
import { SPEAKER_OWNER_KEY, speakerOwnerFromTurns, type SpeakerOwnerStamp } from '../identity/speaker-owner.ts';

/** A rendered page larger than this is held, never truncated. */
export const MAX_IMESSAGE_PAGE_BYTES = 2 * 1024 * 1024;
/** Bumped when the render changes, so every day in the lookback re-renders once. */
const RENDER_VERSION = 1;

export class IMessagePageTooLargeError extends Error {
  readonly code = 'connector_item_too_large';
  constructor(readonly bytes: number) {
    super(`the rendered iMessage day page is ${bytes} bytes, over the ${MAX_IMESSAGE_PAGE_BYTES}-byte limit; it was held, not truncated`);
    this.name = 'IMessagePageTooLargeError';
  }
}

/** The stable, handle-free key of a chat. */
export function imessageChatKey(threadId: string): string {
  return createHash('sha256').update(`imessage:${threadId}`).digest('hex').slice(0, 16);
}

export function imessagePagePath(chatKey: string, day: string): string {
  return `imessage/${chatKey}/${day}.md`;
}

const inline = (text: string) => neutralizeOutsideText(text.replace(/\s+/g, ' ').trim());
/** A speaker name inside gbrain's own anchor: no emphasis, colon, bracket or parenthesis can break out of it. */
const speakerName = (text: string) => inline(text.replace(/[*:()[\]]/g, ' ')) || 'Unknown';

/** The anchor time of a message as the wall clock of the page's time zone, so it agrees with the page's day. */
function anchorTime(iso: string, zone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const hour = Number(parts.hour);
  return `${parts.year}-${parts.month}-${parts.day} ${hour % 12 || 12}:${parts.minute} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function imessageChatTitle(thread: IMessageThread): string {
  const name = thread.displayName ?? (thread.participants.length ? thread.participants.join(', ') : 'Unnamed chat');
  return name.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Unnamed chat';
}

/** The messages that appear on a page: an unsent message is left out. */
export const shownMessages = (messages: readonly IMessageMessage[]) => messages.filter(m => !m.retracted);

/** What decides whether a day page changed since its last publish. */
export function imessageDayFingerprint(thread: IMessageThread, day: string, messages: readonly IMessageMessage[]): string {
  const rows = shownMessages(messages).map(m => [m.id, m.timestamp, m.isFromMe, m.from ?? '', m.text ?? '', m.textStatus, m.hasAttachments, m.editedAt ?? '']);
  return createHash('sha256').update(JSON.stringify([RENDER_VERSION, imessageChatTitle(thread), thread.isGroup, day, rows])).digest('hex').slice(0, 32);
}

const speakerOf = (m: IMessageMessage, thread: IMessageThread) =>
  speakerName(m.isFromMe ? 'Me' : m.from ?? (thread.isGroup ? 'Unknown' : thread.displayName ?? thread.participants[0] ?? 'Unknown'));

function messageLines(m: IMessageMessage, thread: IMessageThread, zone: string): string[] {
  const speaker = speakerOf(m, thread);
  const body = m.textStatus === 'undecodable' ? '_(message could not be decoded)_'
    : neutralizeOutsideText((m.text ?? '').split('\n').map(line => line.trimStart()).filter(Boolean).join('\n'));
  const lines = body ? body.split('\n') : [];
  if (m.hasAttachments) lines.push('[attachment]');
  if (!lines.length) lines.push('_(no text)_');
  for (let i = 1; i < lines.length; i++) if (BUILTIN_PATTERNS.some(p => p.regex.test(lines[i]!))) lines[i] = `\\${lines[i]}`;
  const edited = m.editedAt ? ' _(edited)_' : '';
  lines[lines.length - 1] += edited;
  return [`**${speaker}** (${anchorTime(m.timestamp, zone)}): ${lines[0]}`, ...lines.slice(1)];
}

export interface IMessageDayInput {
  thread: IMessageThread;
  chatKey: string;
  day: string;
  timezone: string;
  /** The day's messages, oldest first. */
  messages: readonly IMessageMessage[];
  /** GST-3216: stamp speaker_owner from the Mac's own is-from-me flag (identity/speaker-owner.ts). */
  owner?: SpeakerOwnerStamp;
}

export function renderIMessageDay(input: IMessageDayInput): string {
  const shown = shownMessages(input.messages);
  const title = imessageChatTitle(input.thread);
  const frontmatter: Record<string, unknown> = {
    type: 'imessage',
    title: `${title} ${input.day}`,
    date: input.day,
    timezone: input.timezone,
    connector: 'imessage',
    source_kind: 'imessage',
    imessage_chat: input.chatKey,
    group: input.thread.isGroup,
    messages: shown.length,
    visibility: 'private',
  };
  const owner = input.owner ? speakerOwnerFromTurns(shown.map(m => ({ label: speakerOf(m, input.thread), owner: m.isFromMe })), 'is_from_me', input.owner.member) : null;
  if (owner) frontmatter[SPEAKER_OWNER_KEY] = owner;
  const lines = [`# ${inline(title)} ${input.day}`, '', `**Chat:** ${inline(title)} · **Day:** ${input.day} (${input.timezone}) · **Messages:** ${shown.length}`, '',
    ...shown.flatMap(m => messageLines(m, input.thread, input.timezone))];
  const page = `---\n${dumpFrontmatterYaml(frontmatter, { lineWidth: 1000 })}---\n\n${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(page, 'utf8');
  if (bytes > MAX_IMESSAGE_PAGE_BYTES) throw new IMessagePageTooLargeError(bytes);
  return page;
}
