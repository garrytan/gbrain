import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, withGoogleAccount, settleConnectorWrites } from './helpers/connector-fixture.ts';

/**
 * #10559: a Gmail sweep that re-fetches threads it already imported (a change-feed record naming an old thread, a
 * backfill re-walk) must not admit a new connector_v2_import receipt for a page that is unchanged, embedded and has no
 * contextual retrieval mode. A publication of unchanged content never stamps that mode, so admitting the page for it
 * wrote one receipt per page per sweep. A thread whose content did change is still admitted.
 */
const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
const config = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };
const THREADS = Array.from({ length: 4 }, (_, i) => ({ tid: `19aa0000000c${String(i).padStart(4, '0')}`, ms: NOW_MS - (30 + i * 20) * DAY }));

/** Fake Gmail: the backfill lists every thread; from `touchFrom` on, each history listing names every thread again. */
function fakeGmail(account: string, world: { historyId: number; touch: boolean; body: (tid: string) => string }) {
  const fetcher = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: String(world.historyId) });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = THREADS.filter(t => t.ms / 1000 >= after && t.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
      return json({ messages: hits.map(t => ({ id: `m-${t.tid}`, threadId: t.tid })) });
    }
    if (u.pathname.endsWith('/users/me/history')) {
      if (!world.touch) return json({ historyId: String(world.historyId), history: [] });
      world.historyId++;
      return json({ historyId: String(world.historyId), history: THREADS.map((t, i) => ({ id: String(world.historyId * 10 + i),
        labelsAdded: [{ message: { id: `m-${t.tid}`, threadId: t.tid }, labelIds: ['IMPORTANT'] }] })) });
    }
    const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (m) {
      const t = THREADS.find(x => x.tid === m[1])!;
      return json({ id: t.tid, messages: [{ id: `m-${t.tid}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Bob Example <bob@example.com>' }, { name: 'To', value: account },
          { name: 'Subject', value: `Planning ${t.tid}` }], body: { data: b64url(world.body(t.tid)) } } }] });
    }
    return json({ error: { message: 'unexpected fixture route' } }, 400);
  };
  return withGoogleAccount(fetcher, account);
}

/** Every chunk embedded and no contextual mode recorded, as a `--no-embed` import followed by `gbrain embed` leaves a page. */
async function embedWithoutMode(engine: BrainEngine, sourceId: string) {
  const [{ dim }] = await engine.executeRaw<{ dim: number }>("SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
  await engine.executeRaw('UPDATE content_chunks c SET embedding=$2::text::vector FROM pages p WHERE p.id=c.page_id AND p.source_id=$1',
    [sourceId, `[${Array(Number(dim)).fill(0.02).join(',')}]`]);
  await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL WHERE source_id=$1', [sourceId]);
  const [pending] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.contextual_retrieval_mode IS NULL
    AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NOT NULL)`, [sourceId]);
  expect(pending.n).toBe(THREADS.length);
}

const receipts = async (engine: BrainEngine, sourceId: string) => Object.fromEntries((await engine.executeRaw<{ slug: string; n: number }>(
  `SELECT slug, count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' GROUP BY slug ORDER BY slug`,
  [sourceId])).map(r => [r.slug, r.n]));

for (const bound of [true, false]) {
  test(`#10559: re-fetched unchanged embedded Gmail pages admit no new receipt (${bound ? 'managed checkout' : 'no checkout'})`, async () => withEnv(env, async () => {
    for (const engine of engines) {
      const f = bound ? await boundSource(engine, config) : await source(engine, config);
      const cfg = parseGoogleSourceConfig(config, f.dir);
      const edited = new Set<string>();
      const world = { historyId: 1000, touch: false, body: (tid: string) => edited.has(tid) ? `Revised agenda for ${tid}.` : `Agenda for ${tid}.` };
      const sweep = async () => {
        await runGoogleSync(engine, f.id, cfg, options, fakeGmail(cfg.account, world));
        await settleConnectorWrites(engine, f.id);
        await disposePersistenceConsumer(engine);
      };
      await sweep();
      const first = await receipts(engine, f.id);
      expect(Object.keys(first)).toHaveLength(THREADS.length);
      expect(Object.values(first).every(n => n === 1)).toBe(true);
      await embedWithoutMode(engine, f.id);

      world.touch = true;
      await sweep();
      await sweep();
      expect(await receipts(engine, f.id)).toEqual(first);

      edited.add(THREADS[0]!.tid);
      await sweep();
      const after = await receipts(engine, f.id);
      const changed = Object.entries(after).filter(([slug, n]) => n !== first[slug]);
      expect(changed).toHaveLength(1);
      expect(changed[0]![1]).toBe(2);
      const [page] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [f.id, changed[0]![0]]);
      expect(page!.compiled_truth).toContain('Revised agenda');
    }
  }), 240_000);
}
