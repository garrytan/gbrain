/**
 * Wakeshift report-back, end to end on a repo-less PGLite brain against a fake Wakeshift (test/helpers/fake-wakeshift.ts):
 * watch, complete, exactly one emit carrying metadata only; a foreign id reads like a missing one and sends nothing;
 * an already-finished job wakes at once; a revoked principal ends the watch instead of emitting; two watchers never
 * collide; the failure schedule is bounded (5 attempts, then dead and ended); disabled means no tools and no fetch.
 *
 * Serial: points GBRAIN_HOME at a temporary home holding config.json and the 0600 key file.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disabledOpsForPublishGates } from '../src/mcp/publish-gates.ts';
import { encodeWakeshiftKey } from '../src/core/wakeshift/client.ts';
import { drainWakes, WAKE_MAX_ATTEMPTS } from '../src/core/wakeshift/drain.ts';
import { readWakeshiftKey, resetWakeshiftEnvKeyForTests } from '../src/core/wakeshift/config.ts';
import { loadConfig } from '../src/core/config.ts';
import { startFakeWakeshift, type FakeWakeshift } from './helpers/fake-wakeshift.ts';
import { runWakeshift } from '../src/commands/wakeshift.ts';
import { readFileSync } from 'node:fs';

const KEY = encodeWakeshiftKey(Buffer.alloc(32, 9));
const WATCH_OPS = ['watch_job', 'list_watches', 'unwatch'];
let engine: PGLiteEngine;
let fake: FakeWakeshift;
let home: string;
const prevHome = process.env.GBRAIN_HOME;
const prevKey = process.env.WAKESHIFT_API_KEY;

function writeConfig(wakeshift: Record<string, unknown> | null): void {
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...(wakeshift ? { wakeshift } : {}) }), { mode: 0o600 });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  process.env.GBRAIN_HOME = home;
  delete process.env.WAKESHIFT_API_KEY;
  resetWakeshiftEnvKeyForTests();
  writeFileSync(join(home, '.gbrain', 'wakeshift.key'), KEY + '\n', { mode: 0o600 });
  chmodSync(join(home, '.gbrain', 'wakeshift.key'), 0o600);
  fake = startFakeWakeshift(KEY);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  fake.stop();
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prevHome;
  if (prevKey !== undefined) process.env.WAKESHIFT_API_KEY = prevKey;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  writeConfig({ enabled: true, url: fake.url });
  fake.calls.length = 0;
  fake.respond.clear();
  await engine.executeRaw('DELETE FROM wake_subscriptions');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function seedJob(status: string, owner?: string): Promise<number> {
  const data = { __submitter: 'cli:test', ...(owner ? { __owner_client_id: owner } : {}), slug: 'people/alice-example', note: 'private canary text' };
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, started_at, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'sync', 'default', $1, $2::jsonb, now() - interval '3 minutes',
             CASE WHEN $1 IN ('completed','failed','dead','cancelled') THEN now() END) RETURNING id`, [status, JSON.stringify(data)]);
  return Number(rows[0]!.id);
}

const finish = (id: number, status = 'completed') => engine.executeRaw(`UPDATE minion_jobs SET status = $2, finished_at = now() WHERE id = $1`, [id, status]);
const stdio = { remote: true, transport: 'stdio' as const, sourceId: 'default', mcpCaller: { client: 'claude-code', meta: { 'claudecode/toolUseId': 't1' } } };
const emits = () => fake.calls.filter(c => c.path === '/events/emit');
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

describe('watch_job → completion → one pointer emit', () => {
  test('subscribes the conversation, renders the addition last, and emits once with metadata only', async () => {
    const id = await seedJob('active');
    const r = await dispatchToolCall(engine, 'watch_job', { id, harness: 'claude-code' }, stdio);
    expect(r.isError).toBeFalsy();
    expect(body(r)).toMatchObject({ watching: true, job: id, already_finished: false, status: 'active' });
    expect(r.content.at(-1)!.text).toContain('secret-addition-text');
    expect((r._meta as Record<string, unknown>)['wakeshift/session']).toBe('secret-addition-meta');

    const sub = fake.calls.find(c => c.path === '/event-subscriptions')!;
    expect(sub.assertionOk).toBe(true);
    expect(sub.body).toMatchObject({ name: 'gbrain.job.finished', arguments: { job: id }, once: true, ttl: '7d' });
    expect(sub.body.call).toMatchObject({ tool: 'watch_job', client: 'claude-code', harness: 'claude-code', meta: { 'claudecode/toolUseId': 't1' } });
    expect(sub.body.call.user).toMatch(/^[0-9a-f]{32}$/);

    expect((await drainWakes(engine)).delivered).toBe(0);
    expect(emits()).toHaveLength(0);
    await finish(id);
    expect((await drainWakes(engine)).delivered).toBe(1);
    expect((await drainWakes(engine)).delivered).toBe(0);
    expect(emits()).toHaveLength(1);
    const e = emits()[0]!;
    expect(e.assertionOk).toBe(true);
    expect(e.body.name).toBe('gbrain.job.finished');
    expect(e.body.to).toEqual([{ user: sub.body.call.user, subscription: 'sub_1' }]);
    expect(e.body.text).toMatch(new RegExp(`^gbrain: job ${id} \\(sync\\) finished ok in 3m0[0-9]s\\. Call get_job ${id} for the result\\.$`));
    expect(e.body.id).toMatch(new RegExp(`^gbrain\\.job\\.finished:${id}:\\d+:completed:\\d+:[0-9a-f]{12}$`));
    const raw = JSON.stringify(e.body);
    expect(raw).not.toContain('alice-example');
    expect(raw).not.toContain('canary');
    const [row] = await engine.executeRaw<{ state: string }>('SELECT state FROM wake_subscriptions');
    expect(row!.state).toBe('delivered');
  });

  test('a job that already finished wakes during the watch call', async () => {
    const id = await seedJob('failed');
    const r = await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    expect(body(r)).toMatchObject({ already_finished: true, status: 'failed' });
    expect(emits()).toHaveLength(1);
    expect(emits()[0]!.body.payload).toMatchObject({ job: id, status: 'failed', next: `get_job ${id}` });
  });

  test('a removed job emits "details gone"', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [id]);
    await drainWakes(engine);
    expect(emits()[0]!.body.payload).toMatchObject({ job: id, status: 'gone' });
  });
});

describe('access', () => {
  const agent = (clientId: string) => ({ remote: true, transport: 'http' as const, sourceId: 'default', auth: { token: 't', clientId, principal: { kind: 'oauth_client' as const, id: clientId }, member: null, scopes: ['agent'] } });

  test('a foreign job id answers exactly like a missing id, and nothing reaches Wakeshift', async () => {
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('client-b', 'client-b') ON CONFLICT DO NOTHING`);
    const foreign = await seedJob('active', 'client-a');
    const missing = foreign + 1000;
    const a = await dispatchToolCall(engine, 'watch_job', { id: foreign }, agent('client-b'));
    const b = await dispatchToolCall(engine, 'watch_job', { id: missing }, agent('client-b'));
    expect(a.isError).toBe(true);
    expect(a.content[0]!.text.replaceAll(String(foreign), 'N')).toBe(b.content[0]!.text.replaceAll(String(missing), 'N'));
    expect(fake.calls).toHaveLength(0);
    const own = await seedJob('active', 'client-b');
    expect((await dispatchToolCall(engine, 'watch_job', { id: own }, agent('client-b'))).isError).toBeFalsy();
  });

  test('a principal revoked before completion gets no emit, and its watch is ended at Wakeshift', async () => {
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('client-r', 'client-r') ON CONFLICT DO NOTHING`);
    const id = await seedJob('active', 'client-r');
    expect((await dispatchToolCall(engine, 'watch_job', { id }, agent('client-r'))).isError).toBeFalsy();
    await engine.executeRaw(`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'client-r'`);
    await finish(id);
    expect(await drainWakes(engine)).toMatchObject({ delivered: 0, ended: 1 });
    expect(emits()).toHaveLength(0);
    expect(fake.calls.filter(c => c.path === '/event-subscriptions/end')).toHaveLength(1);
    const [row] = await engine.executeRaw<{ state: string; last_error: string }>('SELECT state, last_error FROM wake_subscriptions');
    expect(row).toMatchObject({ state: 'ended', last_error: 'principal_revoked' });
  });

  test('two watchers of one job each get their own emit with distinct ids', async () => {
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('client-c', 'client-c') ON CONFLICT DO NOTHING`);
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    const admin = { remote: true, transport: 'http' as const, sourceId: 'default', auth: { token: 't', clientId: 'client-c', principal: { kind: 'oauth_client' as const, id: 'client-c' }, member: null, scopes: ['admin'] } };
    await dispatchToolCall(engine, 'watch_job', { id }, admin);
    await finish(id);
    expect((await drainWakes(engine)).delivered).toBe(2);
    const ids = emits().map(e => e.body.id);
    expect(new Set(ids).size).toBe(2);
    expect(new Set(emits().map(e => e.body.to[0].user)).size).toBe(2);
  });

  test('list_watches and unwatch act only on the caller\'s own watches', async () => {
    await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('client-d', 'client-d') ON CONFLICT DO NOTHING`);
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    const other = { remote: true, transport: 'http' as const, sourceId: 'default', auth: { token: 't', clientId: 'client-d', principal: { kind: 'oauth_client' as const, id: 'client-d' }, member: null, scopes: ['admin'] } };
    expect(body(await dispatchToolCall(engine, 'list_watches', {}, other)).watches).toEqual([]);
    expect(body(await dispatchToolCall(engine, 'unwatch', { job: id }, other))).toMatchObject({ ended: 0 });
    expect(body(await dispatchToolCall(engine, 'list_watches', {}, stdio)).watches).toHaveLength(1);
    expect(body(await dispatchToolCall(engine, 'unwatch', { job: id }, stdio))).toMatchObject({ ended: 1 });
    await finish(id);
    await drainWakes(engine);
    expect(emits()).toHaveLength(0);
  });
});

describe('failure schedule', () => {
  const due = () => engine.executeRaw("UPDATE wake_subscriptions SET next_attempt_at = now() - interval '1 second'");

  test('server errors retry on the schedule, then the row dies and is ended once', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await finish(id);
    fake.respond.set('/events/emit', () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } }));
    const delays: number[] = [];
    for (let i = 1; i <= WAKE_MAX_ATTEMPTS; i++) {
      await drainWakes(engine);
      const [row] = await engine.executeRaw<{ state: string; attempts: number; delay: number }>(
        'SELECT state, attempts, round(extract(epoch FROM next_attempt_at - now()))::int AS delay FROM wake_subscriptions');
      expect(row!.attempts).toBe(i);
      if (i < WAKE_MAX_ATTEMPTS) { expect(row!.state).toBe('open'); delays.push(row!.delay); await due(); } else expect(row!.state).toBe('dead');
    }
    expect(delays).toEqual([30, 120, 480, 1800]);
    await due();
    await drainWakes(engine);
    expect(emits()).toHaveLength(WAKE_MAX_ATTEMPTS);
    expect(fake.calls.filter(c => c.path === '/event-subscriptions/end')).toHaveLength(1);
  });

  test('429 waits its Retry-After; another 4xx is final at once; id_reused is recorded', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await finish(id);
    fake.respond.set('/events/emit', () => ({ status: 429, body: { error: { code: 'rate_limited', message: 'slow' } }, headers: { 'retry-after': '7' } }));
    await drainWakes(engine);
    const [r1] = await engine.executeRaw<{ delay: number }>('SELECT round(extract(epoch FROM next_attempt_at - now()))::int AS delay FROM wake_subscriptions');
    expect(r1!.delay).toBe(7);
    await due();
    fake.respond.set('/events/emit', () => ({ status: 409, body: { error: { code: 'id_reused', message: 'x' } } }));
    await drainWakes(engine);
    const [r2] = await engine.executeRaw<{ state: string; last_error: string; attempts: number }>('SELECT state, last_error, attempts FROM wake_subscriptions');
    expect(r2).toMatchObject({ state: 'dead', last_error: 'id_reused', attempts: 2 });
  });

  test('a lease held by another drainer is never emitted twice', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await finish(id);
    await engine.executeRaw("UPDATE wake_subscriptions SET lease_until = now() + interval '1 minute'");
    expect((await drainWakes(engine)).delivered).toBe(0);
    expect(emits()).toHaveLength(0);
  });

  test('an unwatch while a drainer holds the lease stays ended when the emit then fails', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await finish(id);
    fake.respond.set('/events/emit', async () => {
      await dispatchToolCall(engine, 'unwatch', { job: id }, stdio);
      return { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
    });
    expect(await drainWakes(engine)).toMatchObject({ retried: 0 });
    const [row] = await engine.executeRaw<{ state: string; attempts: number }>('SELECT state, attempts FROM wake_subscriptions');
    expect(row).toMatchObject({ state: 'ended', attempts: 0 });
  });

  test('a row whose processing throws backs off and does not block the rows behind it', async () => {
    const a = await seedJob('active');
    const b = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id: a }, stdio);
    await dispatchToolCall(engine, 'watch_job', { id: b }, stdio);
    await finish(a); await finish(b);
    await engine.executeRaw("UPDATE wake_subscriptions SET principal_kind = 'oauth_client', principal_id = 'poison-client' WHERE target = $1", [String(a)]);
    const poisoned = new Proxy(engine, {
      get(t, k, r) {
        if (k !== 'executeRaw') return Reflect.get(t, k, r);
        return (sql: string, params?: unknown[]) => sql.includes('FROM oauth_clients') && params?.[0] === 'poison-client'
          ? Promise.reject(new Error('lookup failed')) : t.executeRaw(sql, params);
      },
    });
    await expect(drainWakes(poisoned)).rejects.toThrow('lookup failed');
    const rows = await engine.executeRaw<{ target: string; state: string; attempts: number; delay: number; lease: boolean }>(
      'SELECT target, state, attempts, round(extract(epoch FROM next_attempt_at - now()))::int AS delay, lease_until IS NOT NULL AS lease FROM wake_subscriptions ORDER BY id');
    expect(rows[0]).toMatchObject({ target: String(a), state: 'open', attempts: 1, delay: 30, lease: false });
    expect(rows[1]).toMatchObject({ target: String(b), state: 'delivered' });
    expect(emits()).toHaveLength(1);
    await engine.executeRaw("UPDATE wake_subscriptions SET attempts = $1, next_attempt_at = now() - interval '1 second' WHERE target = $2", [WAKE_MAX_ATTEMPTS - 1, String(a)]);
    await expect(drainWakes(poisoned)).rejects.toThrow('lookup failed');
    const [last] = await engine.executeRaw<{ state: string; last_error: string }>('SELECT state, last_error FROM wake_subscriptions WHERE target = $1', [String(a)]);
    expect(last).toMatchObject({ state: 'dead', last_error: 'drain_error' });
    expect(fake.calls.filter(c => c.path === '/event-subscriptions/end')).toHaveLength(1);
  });

  test('an emit nobody matched ends the watch instead of calling it delivered; a duplicate counts as delivered', async () => {
    const a = await seedJob('active');
    const b = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id: a }, stdio);
    await dispatchToolCall(engine, 'watch_job', { id: b }, stdio);
    await finish(a); await finish(b);
    fake.respond.set('/events/emit', e => (e.arguments.job === a
      ? { status: 200, body: { matched: 0, duplicate: false, unmatched: e.to, ended: [] } }
      : { status: 200, body: { matched: 0, duplicate: true, unmatched: [], ended: [] } }));
    expect(await drainWakes(engine)).toMatchObject({ delivered: 1, ended: 1 });
    const rows = await engine.executeRaw<{ target: string; state: string; last_error: string | null }>('SELECT target, state, last_error FROM wake_subscriptions ORDER BY id');
    expect(rows).toEqual([{ target: String(a), state: 'ended', last_error: 'unmatched' }, { target: String(b), state: 'delivered', last_error: null }]);
  });

  test('a member added after enable pauses reporting back: watch_job refuses and the drainer sends nothing', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await finish(id);
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example') ON CONFLICT DO NOTHING");
    try {
      const other = await seedJob('active');
      const r = await dispatchToolCall(engine, 'watch_job', { id: other }, stdio);
      expect(r.isError).toBe(true);
      const env = JSON.parse(r.content[0]!.text);
      expect(env.code ?? env.error).toBe('wakeshift_shared_brain');
      expect(JSON.stringify(env)).not.toMatch(/\d+ live access member/);
      expect(await drainWakes(engine)).toMatchObject({ skipped: 'shared' });
      expect(emits()).toHaveLength(0);
      expect(fake.calls.filter(c => c.path === '/event-subscriptions')).toHaveLength(1);
    } finally {
      await engine.executeRaw("DELETE FROM access_members WHERE id = 'alice-example'");
    }
  });

  test('a 429 without Retry-After backs off on the schedule', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await finish(id);
    fake.respond.set('/events/emit', () => ({ status: 429, body: { error: { code: 'rate_limited', message: 'slow' } } }));
    await drainWakes(engine);
    const [row] = await engine.executeRaw<{ delay: number; attempts: number }>('SELECT attempts, round(extract(epoch FROM next_attempt_at - now()))::int AS delay FROM wake_subscriptions');
    expect(row).toMatchObject({ attempts: 1, delay: 30 });
  });

  test('a drainer holding a stale snapshot never skips the backoff another drainer just set', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await finish(id);
    const stale = new Proxy(engine, {
      get(t, k, r) {
        if (k !== 'executeRaw') return Reflect.get(t, k, r);
        return async (sql: string, params?: unknown[]) => {
          const out = await t.executeRaw(sql, params);
          if (sql.includes('FROM wake_subscriptions w')) {
            await t.executeRaw("UPDATE wake_subscriptions SET attempts = 2, next_attempt_at = now() + interval '2 minutes', lease_until = NULL");
          }
          return out;
        };
      },
    });
    expect(await drainWakes(stale)).toMatchObject({ delivered: 0, retried: 0 });
    expect(emits()).toHaveLength(0);
    const [row] = await engine.executeRaw<{ attempts: number }>('SELECT attempts FROM wake_subscriptions');
    expect(row!.attempts).toBe(2);
  });

  test('a terminal job with no finished_at still wakes its watcher', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    await engine.executeRaw("UPDATE minion_jobs SET status = 'cancelled', finished_at = NULL WHERE id = $1", [id]);
    expect(await drainWakes(engine)).toMatchObject({ delivered: 1 });
    expect(emits()).toHaveLength(1);
  });

  test('Wakeshift down during watch_job: a clear error with the wait_job fix and no row', async () => {
    const id = await seedJob('active');
    fake.respond.set('/event-subscriptions', () => ({ status: 503, body: { error: { code: 'unavailable', message: 'down' } } }));
    const r = await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    expect(r.isError).toBe(true);
    const env = JSON.parse(r.content[0]!.text);
    expect(env.code ?? env.error).toBe('wakeshift_unavailable');
    expect(JSON.stringify(env)).toContain('wait_job');
    expect(await engine.executeRaw('SELECT 1 FROM wake_subscriptions')).toHaveLength(0);
  });
});

describe('off means inert', () => {
  test('disabled: the three tools are hidden, calls refuse, the drainer sends nothing', async () => {
    writeConfig({ enabled: false, url: fake.url });
    const disabled = await disabledOpsForPublishGates(engine, null, { transport: 'stdio' });
    for (const op of WATCH_OPS) expect(disabled.has(op)).toBe(true);
    const id = await seedJob('completed');
    const r = await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('wakeshift_not_enabled');
    expect(await drainWakes(engine)).toMatchObject({ skipped: 'off' });
    expect(fake.calls).toHaveLength(0);
  });

  test('enabled without a usable key is still off; a DB-plane flag never turns it on', async () => {
    writeConfig(null);
    await engine.setConfig('mcp.publish_wakeshift', 'true');
    try {
      expect((await disabledOpsForPublishGates(engine, null)).has('watch_job')).toBe(true);
    } finally {
      await engine.executeRaw("DELETE FROM config WHERE key = 'mcp.publish_wakeshift'");
    }
    writeConfig({ enabled: true, url: fake.url });
    expect((await disabledOpsForPublishGates(engine, null)).has('watch_job')).toBe(false);
    chmodSync(join(home, '.gbrain', 'wakeshift.key'), 0o644);
    try {
      expect((await disabledOpsForPublishGates(engine, null)).has('watch_job')).toBe(true);
    } finally {
      chmodSync(join(home, '.gbrain', 'wakeshift.key'), 0o600);
    }
  });

  test('a local CLI caller is told to use gbrain jobs wait', async () => {
    const id = await seedJob('active');
    const r = await dispatchToolCall(engine, 'watch_job', { id }, { remote: false });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('gbrain jobs wait');
    expect(fake.calls).toHaveLength(0);
  });
});

async function cli(args: string[]): Promise<{ out: string; error?: unknown }> {
  const orig = console.log;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try { await runWakeshift(engine, args); return { out }; } catch (error) { return { out, error }; } finally { console.log = orig; }
}

describe('gbrain wakeshift', () => {
  test('enable checks the key, merges the manifest and writes only the file plane; status shows the kid, never the key', async () => {
    writeConfig(null);
    const r = await cli(['enable', '--yes', '--url', fake.url, '--json']);
    expect(r.error).toBeUndefined();
    expect(fake.calls.map(c => c.path)).toEqual(['/app', '/manifest/merge']);
    expect(fake.calls[1]!.body.events[0].name).toBe('gbrain.job.finished');
    const cfg = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
    expect(cfg.wakeshift).toEqual({ enabled: true, url: fake.url });
    expect(JSON.stringify(cfg)).not.toContain(KEY.slice(4));
    const st = await cli(['status', '--json']);
    const doc = JSON.parse(st.out);
    expect(doc).toMatchObject({ enabled: true, active: true, key: { source: 'file' } });
    expect(doc.key.kid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(st.out + r.out).not.toContain(KEY.slice(4));
  });

  test('enable refuses a brain with live access members, and nothing is sent or written', async () => {
    writeConfig(null);
    await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example') ON CONFLICT DO NOTHING");
    try {
      const r = await cli(['enable', '--yes', '--url', fake.url]);
      expect(String((r.error as Error)?.message)).toContain('live access member');
      expect(fake.calls).toHaveLength(0);
      expect(JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).wakeshift).toBeUndefined();
    } finally {
      await engine.executeRaw("DELETE FROM access_members WHERE id = 'alice-example'");
    }
  });

  test('disable reports a failed watch-ending update instead of claiming it ended none', async () => {
    const failing = new Proxy(engine, {
      get(t, k, r) {
        if (k !== 'executeRaw') return Reflect.get(t, k, r);
        return (sql: string, params?: unknown[]) => sql.includes("last_error = 'disabled'") ? Promise.reject(new Error('db down')) : t.executeRaw(sql, params);
      },
    });
    const orig = console.log;
    console.log = () => {};
    try {
      await expect(runWakeshift(failing, ['disable', '--json'])).rejects.toThrow('db down');
    } finally { console.log = orig; }
    expect(JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).wakeshift.enabled).toBe(false);
  });

  test('a key in ~/.gbrain/.env is taken out of process.env when config loads, so children never inherit it', async () => {
    const envFile = join(home, '.gbrain', '.env');
    writeFileSync(envFile, `WAKESHIFT_API_KEY=${KEY}\n`, { mode: 0o600 });
    try {
      loadConfig();
      expect(process.env.WAKESHIFT_API_KEY).toBeUndefined();
      expect(readWakeshiftKey()).toEqual({ source: 'env', raw: KEY });
      loadConfig();
      expect(process.env.WAKESHIFT_API_KEY).toBeUndefined();
    } finally {
      rmSync(envFile, { force: true });
      delete process.env.WAKESHIFT_API_KEY;
      resetWakeshiftEnvKeyForTests();
    }
  });

  test('a shell-exported key leaves process.env on config load with no .env, and keeps precedence over a .env key', async () => {
    const other = encodeWakeshiftKey(Buffer.alloc(32, 7));
    const envFile = join(home, '.gbrain', '.env');
    process.env.WAKESHIFT_API_KEY = KEY;
    try {
      loadConfig();
      expect(process.env.WAKESHIFT_API_KEY).toBeUndefined();
      writeFileSync(envFile, `WAKESHIFT_API_KEY=${other}\n`, { mode: 0o600 });
      loadConfig();
      expect(process.env.WAKESHIFT_API_KEY).toBeUndefined();
      expect(readWakeshiftKey()).toEqual({ source: 'env', raw: KEY });
    } finally {
      rmSync(envFile, { force: true });
      delete process.env.WAKESHIFT_API_KEY;
      resetWakeshiftEnvKeyForTests();
    }
  });

  test('enable with the default URL drops a custom URL saved earlier', async () => {
    writeConfig({ enabled: true, url: 'http://127.0.0.1:9' });
    const realFetch = globalThis.fetch;
    const hosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      hosts.push(u.origin);
      return Response.json(u.pathname.endsWith('/app') ? { id: 'app_test', name: 'Test app' } : { events: [] });
    }) as typeof fetch;
    try {
      const r = await cli(['enable', '--yes', '--url', 'https://app.wakeshift.ai']);
      expect(r.error).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect([...new Set(hosts)]).toEqual(['https://app.wakeshift.ai']);
    expect(JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).wakeshift).toEqual({ enabled: true });
  });

  test('enable without --yes off a terminal refuses through consent, sending nothing', async () => {
    writeConfig(null);
    const r = await cli(['enable', '--url', fake.url]);
    expect(r.error).toBeDefined();
    expect(fake.calls).toHaveLength(0);
  });

  test('disable hides the tools at once and ends open watches at Wakeshift', async () => {
    const id = await seedJob('active');
    await dispatchToolCall(engine, 'watch_job', { id }, stdio);
    const r = await cli(['disable', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ enabled: false, ended: 1, told_wakeshift: 1 });
    expect((await disabledOpsForPublishGates(engine, null)).has('watch_job')).toBe(true);
    await finish(id);
    expect(await drainWakes(engine)).toMatchObject({ skipped: 'off' });
    expect(emits()).toHaveLength(0);
  });

  test('test reports the app, and a refused key exits non-zero', async () => {
    const ok = await cli(['test', '--json']);
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, app: { id: 'app_test' } });
    fake.respond.set('/app', () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'unknown key' } } }));
    const bad = await cli(['test', '--json']);
    expect(JSON.parse(bad.out)).toMatchObject({ ok: false });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
