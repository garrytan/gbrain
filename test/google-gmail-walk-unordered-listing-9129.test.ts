import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, withGoogleAccount } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
// A (newest) and B (tail of the page-capped listing) are ordinary threads;
// M is migrated: old internalDate, listed alongside newer mail. C sits between
// B and M and is only reachable if the floor stays at B instead of jumping to M.
const THREADS: Record<string, number> = { ta: NOW_MS - 10 * DAY, tm: NOW_MS - 100 * DAY, tb: NOW_MS - 11 * DAY, tc: NOW_MS - 50 * DAY };

test('a page-capped gmail listing with a migrated old-dated thread does not drop the floor past unlisted mail', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const cfg0 = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };
    const f = await source(engine, cfg0);
    const fetched: string[] = [];
    const fetcher = (account: string) => async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: '2000' });
      if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '2000', history: [] });
      if (u.pathname.endsWith('/users/me/messages')) {
        const before = Number(/before:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? Infinity);
        const all: Array<{ id: string; threadId: string }> = [];
        if (before * 1000 > NOW_MS) {
          for (let i = 0; i < 1998; i++) all.push({ id: `m${i}`, threadId: 'ta' });
          all.push({ id: 'mm', threadId: 'tm' }, { id: 'mb', threadId: 'tb' });
        } else if (before * 1000 > THREADS.tc && before * 1000 <= THREADS.tb) {
          all.push({ id: 'mc', threadId: 'tc' });
        }
        const start = Number(u.searchParams.get('pageToken') ?? 0);
        const page = all.slice(start, start + 100);
        return json({ messages: page, ...(start + 100 < all.length ? { nextPageToken: String(start + 100) } : {}) });
      }
      const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        fetched.push(m[1]);
        return json({ id: m[1], messages: [{ id: `x${m[1]}`, threadId: m[1], labelIds: [], internalDate: String(THREADS[m[1]]),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
            { name: 'To', value: account }, { name: 'Subject', value: `Topic ${m[1]}` }], body: { data: b64url(`Body ${m[1]}.`) } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const cfg = parseGoogleSourceConfig(cfg0, f.dir);
    await runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetcher(cfg.account), cfg.account));
    expect(fetched).toContain('tc');
  }
}));
