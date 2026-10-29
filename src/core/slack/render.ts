/**
 * One Slack channel day → one `slack` page at `slack/<channel-id>/<yyyy-mm-dd>.md`,
 * in the inline-date chat layout the conversation parser reads
 * (`**Speaker** (YYYY-MM-DD H:MM AM): text`, the `imessage-slack` builtin).
 * The day boundary is midnight in the source's time zone; every anchor carries
 * its own UTC date and time, so a thread reply posted on a later day is dated
 * correctly. Thread replies follow their parent, marked `↳`.
 *
 * Frontmatter is serialized as data. Every Slack-authored field passes through
 * `neutralizeOutsideText` on its own, after each continuation line loses its
 * leading whitespace (the parser trims lines, so an indented anchor-shaped line
 * would otherwise read as a turn). Nothing run-specific is rendered, so an
 * unchanged day renders byte-identical and publishes nothing.
 */
import { createHash } from 'node:crypto';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { neutralizeOutsideText } from '../outside-content.ts';
import type { SlackAccount, SlackChannelInfo, SlackMessage, SlackSkippable, SlackUser } from './types.ts';

/** A rendered page larger than this is held, never truncated. */
export const MAX_SLACK_PAGE_BYTES = 2 * 1024 * 1024;
/** Bumped when the render changes, so every day in the lookback re-renders once. */
const RENDER_VERSION = 1;

export class SlackPageTooLargeError extends Error {
  readonly code = 'connector_item_too_large';
  constructor(readonly bytes: number) {
    super(`the rendered Slack day page is ${bytes} bytes, over the ${MAX_SLACK_PAGE_BYTES}-byte limit; it was held, not truncated`);
    this.name = 'SlackPageTooLargeError';
  }
}

const tsMs = (ts: string) => Math.round(Number(ts) * 1000);

function zoneParts(ms: number, zone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms));
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

/** The calendar day (YYYY-MM-DD) an instant falls on in `zone`. */
export function slackDayKey(ms: number, zone: string): string {
  const p = zoneParts(ms, zone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The instant (epoch ms) a day starts in `zone`: midnight local time, found by correcting for the zone's offset. */
export function slackDayStartMs(day: string, zone: string): number {
  const wall = Date.parse(`${day}T00:00:00Z`);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, zone);
    const offset = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - guess;
    const next = wall - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** The start of the day that holds `ms` in `zone`. */
export const slackAlignToDay = (ms: number, zone: string) => slackDayStartMs(slackDayKey(ms, zone), zone);

/** The day after `day` (calendar arithmetic, zone-independent). */
export function nextSlackDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function slackPagePath(channelId: string, day: string): string {
  return `slack/${channelId}/${day}.md`;
}

/** Slack mrkdwn entities to plain text: mentions by name, channel and group names, link labels, and the three HTML escapes. */
export function slackText(text: string, userName: (id: string) => string): string {
  return text.replace(/<([^<>]+)>/g, (_whole, inner: string) => {
    const bar = inner.indexOf('|');
    const target = bar >= 0 ? inner.slice(0, bar) : inner;
    const label = bar >= 0 ? inner.slice(bar + 1) : null;
    if (target.startsWith('@')) return `@${label ?? userName(target.slice(1))}`;
    if (target.startsWith('#')) return `#${label ?? target.slice(1)}`;
    if (target.startsWith('!subteam^')) return label ?? '@group';
    if (target.startsWith('!date^')) return label ?? '';
    if (target.startsWith('!')) return `@${label ?? target.slice(1)}`;
    if (!label || label === target || label === target.replace(/^mailto:/, '')) return label ?? target;
    return `${label} (${target})`;
  }).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Outside text on one line: whitespace collapsed, then neutralized. */
const inline = (text: string) => neutralizeOutsideText(text.replace(/\s+/g, ' ').trim());
/** A speaker name inside gbrain's own anchor: no emphasis, colon, bracket or parenthesis can break out of it. */
const speakerName = (text: string) => inline(text.replace(/[*:()[\]]/g, ' ')) || 'Unknown';

function anchorTime(ts: string): string {
  const iso = new Date(tsMs(ts)).toISOString();
  const hour = Number(iso.slice(11, 13));
  return `${iso.slice(0, 10)} ${hour % 12 || 12}:${iso.slice(14, 16)} ${hour < 12 ? 'AM' : 'PM'}`;
}

export interface SlackDayInput {
  channel: SlackChannelInfo;
  day: string;
  timezone: string;
  account: SlackAccount;
  /** The day's top-level messages, oldest first. */
  messages: SlackMessage[];
  /** Thread replies by parent ts, oldest first. */
  replies: ReadonlyMap<string, SlackMessage[]>;
  users: Readonly<Record<string, SlackUser>>;
  privateOnly: boolean;
  skip: readonly SlackSkippable[];
}

/** Whether a message is left out of the page (T11 skips; Slack's own thread-join noise is never a turn). */
export function skippedMessage(m: SlackMessage, skip: readonly SlackSkippable[]): boolean {
  if (m.subtype === 'bot_message' || (!m.user && m.bot_id)) return skip.includes('bot_message');
  if (m.subtype === 'channel_join') return skip.includes('channel_join');
  return false;
}

/** A day's top-level messages that change its page: replies are fetched only for a day whose fingerprint moved. */
export function slackDayFingerprint(input: Pick<SlackDayInput, 'channel' | 'messages'> & { privateOnly: boolean }): string {
  const rows = input.messages.map(m => [m.ts, m.subtype ?? '', m.user ?? '', m.text ?? '', m.edited?.ts ?? '', m.reply_count ?? 0, m.latest_reply ?? '',
    (m.files ?? []).map(f => f.name ?? f.title ?? ''), m.bot_profile?.name ?? m.username ?? '']);
  return createHash('sha256').update(JSON.stringify([RENDER_VERSION, input.channel.name, input.channel.isPrivate, input.privateOnly, rows])).digest('hex').slice(0, 32);
}

function messageLines(m: SlackMessage, users: Readonly<Record<string, SlackUser>>, marker: string): string[] {
  const user = m.user ? users[m.user] : undefined;
  const base = m.user ? user?.name ?? m.user : m.bot_profile?.name ?? m.username ?? m.bot_id ?? 'Unknown';
  const speaker = `${speakerName(base)}${user?.deleted ? ' (deactivated)' : ''}${user?.bot || (!m.user && m.bot_id) ? ' (bot)' : ''}`;
  const userName = (id: string) => users[id]?.name ?? id;
  const files = (m.files ?? []).map(f => `[file: ${(f.name ?? f.title ?? 'attachment').replace(/[[\]]/g, ' ')}]`);
  const lines = m.subtype === 'tombstone' ? ['_(message deleted)_']
    : neutralizeOutsideText([slackText(m.text ?? '', userName), files.join(' ')].filter(Boolean).join('\n').split('\n').map(line => line.trimStart()).filter(Boolean).join('\n')).split('\n');
  const edited = m.edited ? ' _(edited)_' : '';
  const text = `${marker}${lines.shift() ?? ''}`;
  if (!lines.length) return [`**${speaker}** (${anchorTime(m.ts)}): ${text}${edited}`];
  return [`**${speaker}** (${anchorTime(m.ts)}): ${text}`, ...lines.slice(0, -1), `${lines.at(-1)}${edited}`];
}

export function renderSlackDay(input: SlackDayInput): string {
  const { channel, day } = input;
  const isPrivate = input.privateOnly || channel.isPrivate;
  const shown = input.messages.filter(m => !skippedMessage(m, input.skip));
  const body: string[] = [];
  let count = 0;
  for (const m of shown) {
    const broadcast = m.subtype === 'thread_broadcast';
    body.push(...messageLines(m, input.users, broadcast ? '↳ (thread reply, also sent to the channel) ' : ''));
    count++;
    if (broadcast) continue;
    for (const reply of input.replies.get(m.ts) ?? []) {
      if (reply.subtype === 'thread_broadcast' || skippedMessage(reply, input.skip)) continue;
      body.push(...messageLines(reply, input.users, '↳ '));
      count++;
    }
  }
  const frontmatter: Record<string, unknown> = {
    type: 'slack',
    title: `#${channel.name.replace(/\s+/g, ' ').trim()} ${day}`,
    date: day,
    timezone: input.timezone,
    connector: 'slack',
    slack_team_id: input.account.teamId,
    slack_channel_id: channel.id,
    slack_channel: channel.name,
    messages: count,
    ...(isPrivate ? { visibility: 'private' } : {}),
  };
  const lines = [`# #${inline(channel.name)} ${day}`, '',
    `**Channel:** #${inline(channel.name)} (${channel.id}) · **Day:** ${day} (${input.timezone}) · **Messages:** ${count}`, '', ...body];
  const page = `---\n${dumpFrontmatterYaml(frontmatter, { lineWidth: 1000 })}---\n\n${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(page, 'utf8');
  if (bytes > MAX_SLACK_PAGE_BYTES) throw new SlackPageTooLargeError(bytes);
  return page;
}
