/**
 * #8482: the Gmail change feed reports a thread whenever anything on it
 * changes (a label, a read flag), however old its mail is. A thread whose
 * newest message is older than g_history_days stays out of the brain, the
 * same bound the backfill walk applies with `after:<cutoff>`. A thread the brain already holds keeps getting its
 * changes after it ages out of the window.
 *
 * Synthetic mailbox only: example.invalid addresses, no network.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, withGoogleAccount } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
const ARCHIVED = { tid: '17ee000000000a01', ms: NOW_MS - 400 * DAY };
const CURRENT = { tid: '17ee000000000c01', ms: NOW_MS - 2 * DAY };

test('a change-feed thread older than g_history_days is not imported; a current one is', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 30 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let historyId = '3000';
    let changed: Array<typeof ARCHIVED> = [];
    const fetched: string[] = [];
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '3000' });
      if (u.pathname.endsWith('/users/me/messages')) return json({ messages: [] });
      if (u.pathname.endsWith('/users/me/history')) {
        const replay = u.searchParams.get('startHistoryId') !== historyId;
        return json({ historyId, history: replay ? [{ id: historyId, messages: changed.map(({ tid }) => ({ id: `18ee${tid.slice(-8)}`, threadId: tid })) }] : [] });
      }
      const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        fetched.push(m[1]);
        const t = [ARCHIVED, CURRENT].find(({ tid }) => tid === m[1])!;
        return json({ id: t.tid, messages: [{ id: `18ee${t.tid.slice(-8)}`, threadId: t.tid, labelIds: ['INBOX'], internalDate: String(t.ms),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alice Example <alice@example.invalid>' },
            { name: 'To', value: cfg.account }, { name: 'Subject', value: `Topic ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const run = () => runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetcher, cfg.account));
    const imported = async () => (await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY slug", [f.id])).map((r) => r.slug);

    expect((await run()).status).not.toBe('partial');
    expect(await imported()).toEqual([]);

    historyId = '3010';
    changed = [ARCHIVED, CURRENT];
    const delta = await run();
    expect(delta.status).not.toBe('partial');
    expect(fetched.sort()).toEqual([ARCHIVED.tid, CURRENT.tid].sort());
    const slugs = await imported();
    expect(slugs).toHaveLength(1);
    expect(slugs[0]).toContain(CURRENT.tid);

    // The skipped thread is settled, not parked or held: the next run does not fetch it again.
    fetched.length = 0;
    changed = [];
    historyId = '3020';
    expect((await run()).status).not.toBe('partial');
    expect(fetched).toEqual([]);
    expect((await imported()).some((slug) => slug.includes(ARCHIVED.tid))).toBe(false);
    await disposePersistenceConsumer(engine);
  }
}), 120_000);

test('a thread already in the brain keeps updating after it ages out of the window', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 30 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const tid = '17ee000000000e01';
    const started = NOW_MS - 400 * DAY;
    let reply = { ms: NOW_MS - DAY, body: 'Second message.' };
    let historyId = '4000';
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '4000' });
      if (u.pathname.endsWith('/users/me/messages')) return json({ messages: [] });
      if (u.pathname.endsWith('/users/me/history')) {
        return json({ historyId, history: u.searchParams.get('startHistoryId') === historyId ? [] : [{ id: historyId, messages: [{ id: '18ee00000000e002', threadId: tid }] }] });
      }
      if (u.pathname.endsWith(`/users/me/threads/${tid}`)) {
        const msg = (id: string, ms: number, body: string) => ({ id, threadId: tid, labelIds: ['INBOX'], internalDate: String(ms),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alice Example <alice@example.invalid>' },
            { name: 'To', value: cfg.account }, { name: 'Subject', value: 'Long thread' }], body: { data: b64url(body) } } });
        return json({ id: tid, messages: [msg('18ee00000000e001', started, 'First message.'), msg('18ee00000000e002', reply.ms, reply.body)] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const run = () => runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetcher, cfg.account));
    const imports = async () => (await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' AND state='committed'", [f.id]))[0]!.n;

    expect((await run()).status).not.toBe('partial');
    historyId = '4010';
    expect((await run()).status).not.toBe('partial');
    expect(await imports()).toBe(1);

    reply = { ms: NOW_MS - 60 * DAY, body: 'Second message, edited upstream.' };
    historyId = '4020';
    expect((await run()).status).not.toBe('partial');
    expect(await imports()).toBe(2);
    await disposePersistenceConsumer(engine);
  }
}), 120_000);
