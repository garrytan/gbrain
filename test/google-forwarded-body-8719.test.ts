import { afterAll, beforeAll, expect, test } from 'bun:test';
import { trimQuotedReply } from '../src/core/google/google-render.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint, withGoogleAccount } from './helpers/connector-fixture.ts';

const FORWARD = '---------- Forwarded message ---------\nFrom: Peer <peer@example.invalid>\nSubject: Venue\n\nThe venue opens Thursday.\n\nOn Monday, Pat wrote:\n> Is Thursday available?';
for (const marker of ['---------- Forwarded message ---------', 'Begin forwarded message:']) {
  test(`keeps ${marker} and its nested reply, including quoted tail`, () => {
    const text = `FYI\n\n${FORWARD.replace('---------- Forwarded message ---------', marker)}`;
    expect(trimQuotedReply(text)).toBe(text);
    expect(trimQuotedReply(text.slice(5))).toBe(text.slice(5));
  });
}
test('a reply boundary before a forward still trims the quoted reply', () => {
  expect(trimQuotedReply(`Thanks!\n\nOn Monday, Pat wrote:\n${FORWARD}`)).toBe('Thanks!');
  expect(trimQuotedReply('Thanks!\n\n> Begin forwarded message:\n> old body')).toBe('Thanks!');
});

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('legacy completed and partial cursors recover unchanged forwarded threads once, resume after interruption, and preserve deltas', async () => withEnv(env, async () => {
  for (const engine of engines) for (const completed of [true, false]) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const now = Math.floor(Date.now() / 1000) * 1000;
    const threads = Array.from({ length: 27 }, (_, i) => ({ id: `17aa00000000${String(i).padStart(4, '0')}`, ms: now - (i + 1) * 86_400_000 }));
    let legacy = true;
    let interrupted = false;
    let controller: AbortController | undefined;
    const fetched: string[] = [];
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
      if (u.pathname.endsWith('/users/me/messages')) {
        const q = u.searchParams.get('q') ?? '';
        const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
        const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
        return json({ messages: threads.filter(t => t.ms / 1000 >= after && t.ms / 1000 < before).map(t => ({ id: t.id, threadId: t.id })) });
      }
      const id = /\/threads\/([^/]+)$/.exec(u.pathname)?.[1];
      const t = threads.find(t => t.id === id);
      if (!t) throw new Error(`unexpected fixture route ${u.pathname}`);
      fetched.push(t.id);
      if (!legacy && fetched.length === 27 && controller) { interrupted = true; controller.abort(); }
      return json({ id: t.id, messages: [{ id: t.id, internalDate: String(t.ms), labelIds: [], payload: { mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'Peer <peer@example.invalid>' }, { name: 'To', value: cfg.account }, { name: 'Subject', value: `Fwd: Venue ${t.id}` }],
        body: { data: Buffer.from(legacy ? 'FYI' : `FYI\n\n${FORWARD}`).toString('base64url') } } }] });
    };
    const run = () => runGoogleSync(engine, f.id, cfg, { ...options, ...(controller ? { signal: controller.signal } : {}) }, withGoogleAccount(fetcher, cfg.account));
    const state = async () => {
      await disposePersistenceConsumer(engine);
      const rows = await sourceCheckpoint(engine, f.id) as Array<{ completed_keys: Array<{ state: Record<string, unknown> }> }>;
      return rows[0]!.completed_keys[0]!.state;
    };
    expect((await run()).status).not.toBe('partial');
    // Simulate a pre-fix cursor, without changing its identity or source config.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,state}',
      ((completed_keys->0->'state') - 'gmail_body_render_version') || $2::text::jsonb)
      WHERE op='managed-connector' AND fingerprint IN (SELECT intent->>'checkpointKey' FROM persistence_requests WHERE source_id=$1)`,
      [f.id, JSON.stringify({ gmail_backfill_done: completed, gmail_backfill_floor_ms: completed ? null : threads[24]!.ms })]);
    legacy = false;
    fetched.length = 0;
    controller = new AbortController();
    await run().catch(error => { if (!controller!.signal.aborted) throw error; });
    expect(interrupted).toBe(true);
    const partial = await state();
    expect(partial.gmail_history_id).toBe('1000');
    expect(partial.gmail_backfill_done).toBe(false);
    expect(partial.gmail_backfill_floor_ms).toBe(threads[24]!.ms);
    controller = undefined;
    fetched.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(fetched).toEqual(threads.slice(25).map(t => t.id));
    expect((await state()).gmail_backfill_done).toBe(true);
    const pages = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1', [f.id]);
    expect(pages).toHaveLength(27);
    for (const p of pages) expect(p.compiled_truth).toContain('The venue opens Thursday.');
    fetched.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(fetched).toEqual([]);
  }
}), 240_000);
