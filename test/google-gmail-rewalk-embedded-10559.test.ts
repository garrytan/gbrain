/**
 * #10559: a Gmail walk that lists an unchanged page whose chunks are embedded but whose contextual mode was never
 * stamped must skip it, not admit another connector_v2_import receipt on every walk.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, withGoogleAccount, settleConnectorWrites } from './helpers/connector-fixture.ts';
const { engines, env, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);
const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
const config = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };
const OLD = Array.from({ length: 5 }, (_, i) => ({ tid: `17bb00000000a${String(i).padStart(3, '0')}`, ms: NOW_MS - (40 + i) * DAY }));
function gmail(account: string) {
  const fetcher = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: '1000' });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = OLD.filter(m => m.ms / 1000 >= after && m.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
      return json({ messages: hits.map((m, i) => ({ id: `18d2f4a9b3d2${String(i).padStart(4, '0')}`, threadId: m.tid })) });
    }
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
    const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (m) {
      const t = OLD.find(x => x.tid === m[1])!;
      return json({ id: t.tid, messages: [{ id: `18d2f4a9b3d3${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
          { name: 'To', value: account }, { name: 'Subject', value: `Topic ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
    }
    return json({ error: { message: 'unexpected' } }, 400);
  };
  return withGoogleAccount(fetcher, account);
}
test('#10559: re-walking unchanged embedded Gmail pages admits no further import receipts', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const walk = async () => {
      await runGoogleSync(engine, f.id, cfg, options, gmail(cfg.account));
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
    };
    await walk();
    const [d] = await engine.executeRaw<{ dim: number }>(`SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'`);
    await engine.executeRaw(`UPDATE content_chunks SET embedding = array_fill(0.1::real, ARRAY[${d.dim}])::vector, embedded_at=now()`);
    await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL');
    for (let i = 0; i < 2; i++) {
      // Reopen the backfill so the next sweep lists every thread again.
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(jsonb_set(completed_keys, '{0,state,gmail_backfill_done}', 'false'), '{0,state,gmail_backfill_cutoff_ms}', 'null') WHERE op='managed-connector'`);
      await walk();
    }
    const rows = await engine.executeRaw<{ slug: string; n: number }>(`SELECT slug,count(*)::int n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' GROUP BY slug`, [f.id]);
    expect(rows).toHaveLength(OLD.length);
    expect(Math.max(...rows.map(r => r.n))).toBe(1);
  }
}), 240_000);
