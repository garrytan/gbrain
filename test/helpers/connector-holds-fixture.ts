/**
 * Fix wave 4 lane B: synthetic Gmail and GitHub providers for the connector
 * item-hold, #5752, #5740 and #5581 suites. Every route is served in memory;
 * failures are injected per item. Synthetic data only.
 */
import { json } from './connector-fixture.ts';

export interface FakeGmailThread { id: string; messages: Array<{ id: string; ms: number; body: string; subject?: string; from?: string }> }

export interface FakeGmail {
  account: string;
  profileHistoryId: string;
  historyResponseId: string;
  /** Thread ids the history listing returns (one record each). */
  history: string[];
  historyExpired: boolean;
  threads: Map<string, FakeGmailThread>;
  /** Thread id -> HTTP status served for the thread fetch. */
  failThreads: Map<string, number>;
  rateLimited: Set<string>;
  fetched: string[];
  onThreadFetch?: (id: string) => void;
}

export function fakeGmail(account: string): FakeGmail {
  return { account, profileHistoryId: '100', historyResponseId: '100', history: [], historyExpired: false, threads: new Map(),
    failThreads: new Map(), rateLimited: new Set(), fetched: [] };
}

export function addThread(fx: FakeGmail, id: string, ms: number, body = `Synthetic body for ${id}.`, subject = `Subject ${id}`) {
  fx.threads.set(id, { id, messages: [{ id: `${id}0000`, ms, body, subject, from: 'Sender Example <sender@example.com>' }] });
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function gmailFetch(fx: FakeGmail) {
  return async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: fx.account, historyId: fx.profileHistoryId });
    if (u.pathname.endsWith('/users/me/history')) {
      if (fx.historyExpired) return json({ error: { code: 404, message: 'Start history id is too old' } }, 404);
      // One record per flagged thread, ids after the profile anchor; history.list returns records after startHistoryId.
      const start = Number(u.searchParams.get('startHistoryId') ?? 0);
      const records = fx.history.map((threadId, i) => ({ id: String(Number(fx.profileHistoryId) + i + 1), messages: [{ threadId }] }))
        .filter(record => Number(record.id) > start);
      return json({ historyId: fx.historyResponseId, history: records });
    }
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Number.MAX_SAFE_INTEGER);
      const messages = [...fx.threads.values()].flatMap(t => t.messages.map(m => ({ id: m.id, threadId: t.id, ms: m.ms })))
        .filter(m => Math.floor(m.ms / 1000) >= after && Math.floor(m.ms / 1000) < before).sort((a, b) => b.ms - a.ms);
      return json({ messages: messages.map(({ id, threadId }) => ({ id, threadId })) });
    }
    const thread = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/)?.[1];
    if (thread) {
      fx.fetched.push(thread);
      fx.onThreadFetch?.(thread);
      const status = fx.failThreads.get(thread);
      if (status) return json({ error: { code: status, message: 'synthetic thread failure' } }, status);
      if (fx.rateLimited.has(thread)) return json({ error: { message: 'rate limit' } }, 429, { 'retry-after': '0' });
      const t = fx.threads.get(thread);
      if (!t) return json({ error: { code: 404, message: 'not found' } }, 404);
      return json({ id: t.id, messages: t.messages.map(m => ({ id: m.id, threadId: t.id, labelIds: ['INBOX'], internalDate: String(m.ms), payload: {
        mimeType: 'text/plain', headers: [{ name: 'From', value: m.from ?? 'Sender Example <sender@example.com>' }, { name: 'To', value: fx.account },
          { name: 'Subject', value: m.subject ?? `Subject ${t.id}` }], body: { data: b64(m.body) } } })) });
    }
    return json({ error: { message: `unhandled ${u.pathname}` } }, 400);
  };
}

export interface FakeGitHubIssue { number: number; title: string; body: string; updated_at: string }
export interface FakeGitHub { repo: string; issues: FakeGitHubIssue[]; failDetail: Map<number, number>; since: Array<string | null>; detailFetches: number[] }

export function fakeGitHub(repo = 'acme-example/app'): FakeGitHub {
  return { repo, issues: [], failDetail: new Map(), since: [], detailFetches: [] };
}

export function githubHoldsFetch(fx: FakeGitHub) {
  const issue = (i: FakeGitHubIssue) => ({ number: i.number, title: i.title, state: 'open', body: i.body, created_at: '2026-01-01T00:00:00Z',
    updated_at: i.updated_at, labels: [], assignees: [], user: { login: 'example-user' }, html_url: `https://github.com/${fx.repo}/issues/${i.number}` });
  return async (url: string): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname;
    if (path === `/repos/${fx.repo}/issues`) {
      const since = u.searchParams.get('since');
      fx.since.push(since);
      return json(fx.issues.filter(i => !since || i.updated_at >= since).map(issue));
    }
    if (path.endsWith('/pulls') || path.endsWith('/comments')) return json([]);
    const n = path.match(new RegExp(`^/repos/${fx.repo}/issues/(\\d+)$`))?.[1];
    if (n) {
      fx.detailFetches.push(Number(n));
      const status = fx.failDetail.get(Number(n));
      if (status) return json({ message: 'synthetic detail failure' }, status);
      const found = fx.issues.find(i => i.number === Number(n));
      return found ? json(issue(found)) : json({ message: 'Not Found' }, 404);
    }
    if (path === `/repos/${fx.repo}`) return json({ full_name: fx.repo, private: true, default_branch: 'main' });
    if (path === '/user') return json({ login: 'example-user' });
    return json({ message: `unhandled ${path}` }, 400);
  };
}
