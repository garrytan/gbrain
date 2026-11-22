/**
 * A synthetic GBrain Helper behind the two iMessage routes the imessage source calls, answering in the helper's own wire
 * shape (snake_case JSON envelopes, problem+json refusals). Placeholder names and reserved numbers only; never real data.
 */
import { json } from './connector-fixture.ts';

export interface FakeIMessage {
  rowid: number;
  /** Epoch ms. */
  at: number;
  text: string;
  fromMe?: boolean;
  from?: string;
  edited?: boolean;
  retracted?: boolean;
  attachment?: boolean;
  undecodable?: boolean;
}
export interface FakeChat { threadId: string; displayName: string; participants: string[]; isGroup?: boolean; messages: FakeIMessage[] }
export interface FakeHelper {
  token: string;
  chats: FakeChat[];
  calls: string[];
  /** Messages per page, to exercise the cursor. */
  pageSize?: number;
  /** A problem code every /v1 route answers with (no_access, schema_mismatch, source_disabled, insufficient_scope). */
  problem?: string;
  /** The transport fails as if nothing listened on the port. */
  down?: boolean;
  /** Rewrites each /v1/imessage/threads row, to exercise a helper whose wire shape drifted. */
  threadRow?: (row: Record<string, unknown>) => Record<string, unknown>;
}

export const HELPER_TEST_TOKEN = 'helper-test-token-0001';

const iso = (ms: number) => new Date(ms).toISOString();
const PROBLEM_STATUS: Record<string, number> = { no_access: 503, schema_mismatch: 503, source_disabled: 403, insufficient_scope: 403, unauthorized: 401, db_busy: 503 };

function problem(code: string) {
  return new Response(JSON.stringify({ type: `https://example.invalid/problems/${code}`, title: code, status: PROBLEM_STATUS[code] ?? 500, code, detail: code, retryable: false, request_id: 'r1' }),
    { status: PROBLEM_STATUS[code] ?? 500, headers: { 'content-type': 'application/problem+json' } });
}

const wire = (m: FakeIMessage, chat: FakeChat) => ({
  id: `guid-${chat.threadId}-${m.rowid}`, rowid: m.rowid, timestamp: iso(m.at), is_from_me: !!m.fromMe,
  text: m.undecodable ? '' : m.text, text_status: m.undecodable ? 'undecodable' : m.text ? 'ok' : 'empty',
  from: m.fromMe ? null : chat.isGroup ? m.from ?? null : null, from_identifier: null, has_attachments: !!m.attachment,
  edited_at: m.edited ? iso(m.at + 60_000) : null, retracted: !!m.retracted,
});

export function helperFetch(fake: FakeHelper) {
  return async (url: string, init: RequestInit) => {
    const u = new URL(url);
    fake.calls.push(u.pathname + (u.searchParams.get('thread_id') ? `:${u.searchParams.get('thread_id')}` : ''));
    if (fake.down) throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1');
    if (u.hostname !== '127.0.0.1') throw new Error('the helper is reached only on 127.0.0.1');
    if (url.includes(fake.token)) throw new Error('token outside the authorization header');
    const auth = new Headers(init.headers).get('authorization');
    if (auth !== `Bearer ${fake.token}`) return problem('unauthorized');
    if (fake.problem) return problem(fake.problem);
    const p = u.searchParams;
    if (u.pathname === '/v1/imessage/threads') {
      const limit = Number(p.get('limit') ?? 30);
      const last = (c: FakeChat) => Math.max(0, ...c.messages.map(m => m.at));
      const data = [...fake.chats].sort((a, b) => last(b) - last(a)).slice(0, limit).map(c => ({
        thread_id: c.threadId, chat_rowids: [1], chat_guids: [`chat-${c.threadId}`], display_name: c.displayName, participant_count: c.participants.length,
        participants: c.participants, is_group: !!c.isGroup, service: 'iMessage', ...(c.messages.length ? { last_message_at: iso(last(c)) } : {}) })).map(row => fake.threadRow?.(row) ?? row);
      return json({ data, meta: { count: data.length, undecodable: 0 } });
    }
    if (u.pathname === '/v1/imessage/thread') {
      const chat = fake.chats.find(c => c.threadId === p.get('thread_id'));
      if (!chat) return problem('not_found');
      const sinceRowid = p.has('since_rowid') ? Number(p.get('since_rowid')) : null;
      const since = p.has('since_iso') ? Date.parse(p.get('since_iso')!) : null;
      const limit = Math.min(Number(p.get('limit') ?? 50), fake.pageSize ?? 500);
      const all = [...chat.messages].sort((a, b) => a.rowid - b.rowid)
        .filter(m => (sinceRowid === null || m.rowid > sinceRowid) && (since === null || m.at >= since));
      const page = all.slice(0, limit);
      const hasMore = all.length > limit;
      return json({ data: { contact: chat.displayName, thread_id: chat.threadId, is_group: !!chat.isGroup, messages: page.map(m => wire(m, chat)) },
        meta: { count: page.length, undecodable: 0, has_more: hasMore, next_since_rowid: hasMore ? page.at(-1)!.rowid : null } });
    }
    return problem('not_found');
  };
}
