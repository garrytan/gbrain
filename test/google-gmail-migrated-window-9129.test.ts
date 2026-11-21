import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint, withGoogleAccount } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);
const DAY = 86_400_000;
const now = Math.floor(Date.now() / 1000) * 1000;
const migrated = { tid: '1700000000000001', ms: now - 5 * DAY };
const ordinary = { tid: '1700000000000002', ms: now - 2 * DAY };

for (const managed of [true, false]) for (const mode of ['complete', 'listing-failure', 'expired-token', 'cancelled', 'thread-failure', 'history-gap'] as const) {
  test(`out-of-date listing order cannot skip unseen mail: ${mode}, ${managed ? 'managed' : 'classic'}`, async () => withEnv(env, async () => {
    for (const engine of engines) {
      const config = { ...googleConfig, g_services: 'gmail', g_history_days: 30 };
      const f = await source(engine, config);
      if (!managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const cfg = parseGoogleSourceConfig(config, f.dir);
      const interrupt = ['listing-failure', 'expired-token', 'cancelled', 'thread-failure'].includes(mode);
      let failPage = mode === 'listing-failure' || mode === 'expired-token';
      let expireToken = false;
      let failThread = mode === 'thread-failure';
      let cancel = mode === 'cancelled';
      let controller = new AbortController();
      let historyExpired = false;
      let gapActive = false;
      const listed: Array<{ q: string; token: string | null }> = [];
      const fetched: string[] = [];
      const fetcher = async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
        if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: historyExpired ? '2000' : '1000' });
        if (u.pathname.endsWith('/users/me/history')) {
          if (historyExpired) { historyExpired = false; gapActive = true; return json({ error: { message: 'History expired' } }, 404); }
          return json({ historyId: gapActive ? '2000' : '1000', history: [] });
        }
        if (u.pathname.endsWith('/users/me/messages')) {
          const q = u.searchParams.get('q')!;
          const token = u.searchParams.get('pageToken');
          listed.push({ q, token });
          if (mode === 'history-gap' && !gapActive) return json({ messages: [] });
          if (token === 'page-2' && expireToken) return json({ error: { message: 'Invalid pageToken' } }, 400);
          if (token === 'page-2' && failPage) return json({ error: { message: 'synthetic listing interruption' } }, 400);
          if (token === 'page-2' && cancel) controller.abort();
          const after = Number(/after:(\d+)/.exec(q)?.[1]);
          const before = Number(/before:(\d+)/.exec(q)?.[1]);
          const hits = [migrated, ordinary].filter(m => m.ms / 1000 > after && m.ms / 1000 < before);
          if (!hits.length) return json({ messages: [] });
          // Twenty listing pages precede the newer ordinary message. Migrated
          // mail has old internalDate but a recent listing position; no ordering
          // contract permits advancing the date floor from the fetched thread.
          const page = token ? Number(token.split('-')[1]) : 1;
          const t = page <= 20 && hits.includes(migrated) ? migrated : ordinary;
          return json({ messages: [{ id: `180000000000${String(page).padStart(4, '0')}`, threadId: t.tid }],
            ...(page < 21 && hits.includes(ordinary) ? { nextPageToken: `page-${page + 1}` } : {}) });
        }
        const match = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
        if (match) {
          const t = [migrated, ordinary].find(m => m.tid === match[1])!;
          if (t === ordinary && failThread) return json({ error: { message: 'synthetic thread failure' } }, 400);
          fetched.push(t.tid);
          return json({ id: t.tid, messages: [{ id: `180000000000${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
            payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer <peer@example.invalid>' },
              { name: 'To', value: cfg.account }, { name: 'Subject', value: `Topic ${t.tid}` }],
            body: { data: Buffer.from(`Synthetic body ${t.tid}.`).toString('base64url') } } }] });
        }
        throw new Error(`Unexpected synthetic route ${u.pathname}`);
      };
      const run = () => runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, withGoogleAccount(fetcher, cfg.account));
      const checkpoint = async () => {
        if (!managed) return readGoogleState(f.dir);
        await disposePersistenceConsumer(engine);
        const rows = await sourceCheckpoint(engine, f.id) as Array<{ completed_keys: Array<{ state: Record<string, unknown> }> }>;
        return rows[0]?.completed_keys[0]?.state;
      };
      if (mode === 'history-gap') {
        expect((await run()).status).not.toBe('partial');
        expect((await checkpoint())?.gmail_backfill_done).toBe(true);
        historyExpired = true;
      }
      if (interrupt) {
        const result = await run().catch(error => { if (!controller.signal.aborted) throw error; return null; });
        if (mode !== 'cancelled') expect(result?.status).toBe('partial');
        expect((await checkpoint())?.gmail_backfill_done).toBe(false);
        failPage = false;
        failThread = false;
        cancel = false;
        controller = new AbortController();
        if (mode === 'expired-token') {
          const before = await checkpoint();
          expireToken = true;
          expect((await run()).status).toBe('partial');
          const after = await checkpoint();
          expect(after?.gmail_backfill_floor_ms).toBe(before?.gmail_backfill_floor_ms);
          expect(after?.gmail_backfill_page).toBeNull();
          expect(after?.gmail_backfill_done).toBe(false);
          expireToken = false;
        }
        listed.length = 0;
      }
      expect((await run()).status).not.toBe('partial');
      expect(fetched).toContain(ordinary.tid);
      const pages = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id]);
      expect(pages.some(p => p.slug.includes(migrated.tid))).toBe(true);
      expect(pages.some(p => p.slug.includes(ordinary.tid))).toBe(true);
      expect((await checkpoint())?.gmail_backfill_done).toBe(true);
      if (mode === 'listing-failure' || mode === 'cancelled') expect(listed[0].token).toBe('page-2');
      if (mode === 'thread-failure') expect(listed[0].token).toBe('page-21');
      if (mode === 'expired-token') expect(listed[0].token).toBeNull();
      // A clean retry is idempotent and no longer lists historical messages.
      fetched.length = 0;
      listed.length = 0;
      expect((await run()).status).not.toBe('partial');
      expect(fetched).toEqual([]);
      expect(listed).toEqual([]);
    }
  }), 120_000);
}
