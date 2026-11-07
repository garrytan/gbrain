import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, withGoogleAccount } from './helpers/connector-fixture.ts';

// Protects the history feed's age window. Old and recent changed threads distinguish a missing filter;
// backfill tests query the date range and do not cover old IDs arriving from history.list. No test-only seam.
const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const OLD = { tid: '17cc000000000001', ms: NOW_MS - 40 * 86_400_000 };
const RECENT = { tid: '17cc000000000002', ms: NOW_MS - 3_600_000 };

test('gmail history delta skips threads older than the configured history window', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 7 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let historyId = '1000';
    let changed: typeof OLD[] = [];
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/messages')) return json({ messages: [] });
      if (u.pathname.endsWith('/users/me/history')) {
        const records = u.searchParams.get('startHistoryId') === historyId ? [] : [{ id: '1001', messages: changed.map(({ tid }) => ({ threadId: tid })) }];
        return json({ historyId, history: records });
      }
      const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        const thread = [...changed, OLD, RECENT].find(({ tid }) => tid === m[1])!;
        return json({ id: thread.tid, messages: [{ id: `18cc${thread.tid.slice(-8)}`, threadId: thread.tid, labelIds: [], internalDate: String(thread.ms),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'sender' },
            { name: 'To', value: cfg.account }, { name: 'Subject', value: `Topic ${thread.tid}` }], body: { data: b64url(`Body ${thread.tid}.`) } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const run = () => runGoogleSync(engine, f.id, cfg, options, withGoogleAccount(fetcher, cfg.account));
    const imports = async () => (await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY slug", [f.id])).map((r) => r.slug);

    await run(); // anchor the cursor and complete the empty backfill
    historyId = '1010';
    changed = [OLD, RECENT];
    expect((await run()).status).not.toBe('partial');
    const imported = await imports();
    expect(imported).toHaveLength(1);
    expect(imported[0]).toContain(RECENT.tid);
    expect(imported.some((slug) => slug.includes(OLD.tid))).toBe(false);
    await disposePersistenceConsumer(engine);
  }
}), 120_000);
