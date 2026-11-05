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
