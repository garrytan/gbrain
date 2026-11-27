/**
 * Wakeshift report-back on real Postgres (PGLite coverage: test/wakeshift.serial.test.ts): watch, complete, exactly
 * one pointer emit; a foreign id answers like a missing one with nothing sent; two concurrent drainers emit a row
 * once (the lease); the failure schedule ends in dead plus one end call. Against test/helpers/fake-wakeshift.ts.
 * Skips without DATABASE_URL. Run: DATABASE_URL=... bun test test/e2e/wakeshift-postgres.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { encodeWakeshiftKey } from '../../src/core/wakeshift/client.ts';
import { drainWakes, WAKE_MAX_ATTEMPTS } from '../../src/core/wakeshift/drain.ts';
import { resetWakeshiftEnvKeyForTests } from '../../src/core/wakeshift/config.ts';
import { startFakeWakeshift, type FakeWakeshift } from '../helpers/fake-wakeshift.ts';

const d = hasDatabase() ? describe : describe.skip;
const KEY = encodeWakeshiftKey(Buffer.alloc(32, 11));
let fake: FakeWakeshift;
let home: string;
const prevHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  if (!hasDatabase()) return;
  await setupDB();
  home = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-pg-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  process.env.GBRAIN_HOME = home;
  delete process.env.WAKESHIFT_API_KEY;
  resetWakeshiftEnvKeyForTests();
  writeFileSync(join(home, '.gbrain', 'wakeshift.key'), KEY + '\n', { mode: 0o600 });
  chmodSync(join(home, '.gbrain', 'wakeshift.key'), 0o600);
  fake = startFakeWakeshift(KEY);
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', wakeshift: { enabled: true, url: fake.url } }), { mode: 0o600 });
});

afterAll(async () => {
  if (!hasDatabase()) return;
  fake.stop();
  await teardownDB();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!hasDatabase()) return;
  fake.calls.length = 0;
  fake.respond.clear();
  await getEngine().executeRaw('DELETE FROM wake_subscriptions');
  await getEngine().executeRaw('DELETE FROM wake_terms_acceptances');
  await getEngine().executeRaw('DELETE FROM minion_jobs');
});

async function seedJob(status: string, owner?: string): Promise<number> {
  const data = { __submitter: 'cli:test', ...(owner ? { __owner_client_id: owner } : {}), slug: 'people/alice-example' };
  const rows = await getEngine().executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, started_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'sync', 'default', $1, $2::jsonb, now()) RETURNING id`, [status, JSON.stringify(data)]);
  return Number(rows[0]!.id);
}
const finish = (id: number) => getEngine().executeRaw("UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1", [id]);
const stdio = { remote: true, transport: 'stdio' as const, sourceId: 'default', mcpCaller: { client: 'claude-code' } };
const emits = () => fake.calls.filter(c => c.path === '/events/emit');

d('wakeshift on Postgres', () => {
  test('watch, complete, one pointer emit with no page text', async () => {
    const id = await seedJob('active');
    expect((await dispatchToolCall(getEngine(), 'watch_job', { id }, stdio)).isError).toBeFalsy();
    await finish(id);
    const [a, b] = await Promise.all([drainWakes(getEngine()), drainWakes(getEngine())]);
    expect(a.delivered + b.delivered).toBe(1);
    expect(emits()).toHaveLength(1);
    expect(emits()[0]!.body.payload).toMatchObject({ job: id, status: 'completed' });
    expect(JSON.stringify(emits()[0]!.body)).not.toContain('alice-example');
  });

  test('a foreign job id answers like a missing one and nothing is sent', async () => {
    await getEngine().executeRaw("INSERT INTO oauth_clients (client_id, client_name) VALUES ('wk-b', 'wk-b') ON CONFLICT DO NOTHING");
    const agent = { remote: true, transport: 'http' as const, sourceId: 'default', auth: { token: 't', clientId: 'wk-b', principal: { kind: 'oauth_client' as const, id: 'wk-b' }, member: null, scopes: ['agent'] } };
    const foreign = await seedJob('active', 'wk-a');
    const a = await dispatchToolCall(getEngine(), 'watch_job', { id: foreign }, agent);
    const b = await dispatchToolCall(getEngine(), 'watch_job', { id: foreign + 1000 }, agent);
    const envelope = (text: string, id: number) => { const { notices: _, ...rest } = JSON.parse(text.replaceAll(String(id), 'N')); return rest; };
    expect(envelope(a.content[0]!.text, foreign)).toEqual(envelope(b.content[0]!.text, foreign + 1000));
    expect(fake.calls).toHaveLength(0);
  });

  test('an owner-bound watch rescoped below admin ends with job_not_visible instead of emitting (GST-4023)', async () => {
    const engine = getEngine();
    const config = (extra: Record<string, unknown>) => writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', wakeshift: { enabled: true, url: fake.url, ...extra } }), { mode: 0o600 });
    config({ terms_url: 'https://example.com/terms', privacy_url: 'https://example.com/privacy' });
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('owner-example') ON CONFLICT (id) DO UPDATE SET disabled_at = NULL, tombstoned_at = NULL");
    await engine.setConfig('access.owner_member', 'owner-example');
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, scope, member_id) VALUES ('wk-owner', 'wk-owner', 'read write admin', 'owner-example')
      ON CONFLICT (client_id) DO UPDATE SET deleted_at = NULL, scope = EXCLUDED.scope, member_id = EXCLUDED.member_id`);
    const owner = { remote: true, transport: 'http' as const, sourceId: 'default', auth: { token: 't', clientId: 'wk-owner', principal: { kind: 'oauth_client' as const, id: 'wk-owner' }, scopes: ['admin', 'write', 'read'] } };
    const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
    try {
      const before = await seedJob('active', 'wk-a');
      const after = await seedJob('active', 'wk-a');
      const step = body(await dispatchToolCall(engine, 'watch_job', { id: before }, owner));
      expect(body(await dispatchToolCall(engine, 'accept_wakeshift_terms', { terms_version: step.terms_version }, owner))).toMatchObject({ accepted: true });
      for (const id of [before, after]) expect(body(await dispatchToolCall(engine, 'watch_job', { id }, owner))).toMatchObject({ watching: true });
      await finish(before);
      expect(await drainWakes(engine)).toMatchObject({ delivered: 1, ended: 0 });
      await engine.executeRaw("UPDATE oauth_clients SET scope = 'read write' WHERE client_id = 'wk-owner'");
      await finish(after);
      expect(await drainWakes(engine)).toMatchObject({ delivered: 0, ended: 1 });
      expect(emits().map(e => e.body.payload.job)).toEqual([before]);
      expect(await engine.executeRaw('SELECT target, state, last_error FROM wake_subscriptions ORDER BY id'))
        .toEqual([{ target: String(before), state: 'delivered', last_error: null }, { target: String(after), state: 'ended', last_error: 'job_not_visible' }]);
    } finally {
      config({});
      await engine.executeRaw("DELETE FROM config WHERE key = 'access.owner_member'");
      await engine.executeRaw("UPDATE access_members SET disabled_at = now(), tombstoned_at = now() WHERE id = 'owner-example'");
    }
  });

  test('failures retry at most 5 times, then the watch dies and is ended once', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(getEngine(), 'watch_job', { id }, stdio);
    await finish(id);
    fake.respond.set('/events/emit', () => ({ status: 502, body: { error: { code: 'bad_gateway', message: 'x' } } }));
    for (let i = 0; i < WAKE_MAX_ATTEMPTS + 1; i++) {
      await drainWakes(getEngine());
      await getEngine().executeRaw("UPDATE wake_subscriptions SET next_attempt_at = now() - interval '1 second'");
    }
    const [row] = await getEngine().executeRaw<{ state: string; attempts: number }>('SELECT state, attempts FROM wake_subscriptions');
    expect(row).toMatchObject({ state: 'dead', attempts: WAKE_MAX_ATTEMPTS });
    expect(emits()).toHaveLength(WAKE_MAX_ATTEMPTS);
    expect(fake.calls.filter(c => c.path === '/event-subscriptions/end')).toHaveLength(1);
  });
});
