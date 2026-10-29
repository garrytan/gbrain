/** A synthetic Slack workspace behind the Web API routes the slack source calls. Placeholder names only. */
import { json } from './connector-fixture.ts';

export interface FakeSlackMessage {
  ts: string; user?: string; text: string; subtype?: string; edited?: { ts: string };
  bot_id?: string; bot_profile?: { name: string }; files?: Array<{ name: string }>;
  /** Replies (each with thread_ts set to this message's ts on the wire). */
  replies?: FakeSlackMessage[];
}
export interface FakeSlackChannel { id: string; name: string; isPrivate?: boolean; member?: boolean; messages: FakeSlackMessage[] }
export interface FakeSlack {
  teamId: string;
  channels: FakeSlackChannel[];
  users: Record<string, { name: string; deleted?: boolean; bot?: boolean }>;
  calls: string[];
  rateLimited?: boolean;
  /** Messages per history page, to exercise the cursor. */
  pageSize?: number;
}

const wire = (m: FakeSlackMessage) => ({ type: 'message', ts: m.ts, text: m.text,
  ...(m.user ? { user: m.user } : {}), ...(m.subtype ? { subtype: m.subtype } : {}), ...(m.edited ? { edited: m.edited } : {}),
  ...(m.bot_id ? { bot_id: m.bot_id } : {}), ...(m.bot_profile ? { bot_profile: m.bot_profile } : {}), ...(m.files ? { files: m.files } : {}),
  ...(m.replies?.length ? { thread_ts: m.ts, reply_count: m.replies.length, latest_reply: m.replies.at(-1)!.ts } : {}) });

export function slackFetch(fake: FakeSlack) {
  return async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = u.pathname.replace('/api/', '');
    const p = u.searchParams;
    fake.calls.push(p.get('channel') ? `${method}:${p.get('channel')}` : method);
    if (u.toString().includes('xox') || String(init.body ?? '').includes('xox')) throw new Error('token outside the authorization header');
    if (fake.rateLimited) return json({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '600' });
    if (method === 'auth.test') return json({ ok: true, team_id: fake.teamId, team: 'Acme Example', user_id: 'UBOT00001' });
    if (method === 'users.list') {
      return json({ ok: true, members: Object.entries(fake.users).map(([id, u]) => ({ id, name: u.name.toLowerCase(), deleted: !!u.deleted, is_bot: !!u.bot,
        profile: { display_name: u.name, real_name: u.name } })), response_metadata: { next_cursor: '' } });
    }
    const channel = fake.channels.find(c => c.id === p.get('channel'));
    if (!channel || (channel.isPrivate && channel.member === false)) return json({ ok: false, error: 'channel_not_found' });
    if (method === 'conversations.info') {
      return json({ ok: true, channel: { id: channel.id, name: channel.name, is_private: !!channel.isPrivate, is_archived: false, is_member: channel.member !== false } });
    }
    if (channel.member === false) return json({ ok: false, error: 'not_in_channel' });
    if (method === 'conversations.history') {
      const oldest = Number(p.get('oldest')); const latest = Number(p.get('latest'));
      const hits = channel.messages.filter(m => Number(m.ts) >= oldest && Number(m.ts) <= latest).sort((a, b) => Number(b.ts) - Number(a.ts));
      const size = fake.pageSize ?? 200;
      const start = Number(p.get('cursor') || 0);
      const next = start + size < hits.length ? String(start + size) : '';
      return json({ ok: true, messages: hits.slice(start, start + size).map(wire), has_more: !!next, response_metadata: { next_cursor: next } });
    }
    if (method === 'conversations.replies') {
      const parent = channel.messages.find(m => m.ts === p.get('ts'));
      if (!parent) return json({ ok: false, error: 'thread_not_found' });
      return json({ ok: true, messages: [wire(parent), ...(parent.replies ?? []).map(r => ({ ...wire(r), thread_ts: parent.ts }))], response_metadata: { next_cursor: '' } });
    }
    return json({ ok: false, error: 'unknown_method' });
  };
}

/** A Slack ts for an epoch-ms instant (seconds with a microsecond suffix). */
export const slackTs = (ms: number, seq = 1) => `${Math.floor(ms / 1000)}.${String(seq).padStart(6, '0')}`;
