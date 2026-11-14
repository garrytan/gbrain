/**
 * Wakeshift PR 2 on real Postgres (PGLite coverage: test/wakeshift-pr2.serial.test.ts): a real put_page's write
 * request watched with watch_write_request wakes once with a pointer payload, a pending one wakes when it fails, and a
 * foreign id reads like get_write_request's not_found; removing a member ends its watches and the drainer sends one
 * Wakeshift forget, with two concurrent drainers sending it once (the lease). Against test/helpers/fake-wakeshift.ts.
 * Skips without DATABASE_URL. Run: DATABASE_URL=... bun test test/e2e/wakeshift-pr2-postgres.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { encodeWakeshiftKey } from '../../src/core/wakeshift/client.ts';
import { drainWakes } from '../../src/core/wakeshift/drain.ts';
import { resetWakeshiftEnvKeyForTests } from '../../src/core/wakeshift/config.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { removeMember } from '../../src/core/access/members.ts';
import { startFakeWakeshift, type FakeWakeshift } from '../helpers/fake-wakeshift.ts';
import { withEnv } from '../helpers/with-env.ts';

const d = hasDatabase() ? describe : describe.skip;
const KEY = encodeWakeshiftKey(Buffer.alloc(32, 23));
let fake: FakeWakeshift;
let home: string;

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, WAKESHIFT_API_KEY: undefined }, async () => {
  resetWakeshiftEnvKeyForTests();
  return fn();
});
const writeConfig = (wakeshift: Record<string, unknown>) =>
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', wakeshift: { enabled: true, url: fake.url, ...wakeshift } }), { mode: 0o600 });

beforeAll(async () => {
  if (!hasDatabase()) return;
  await setupDB();
  home = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-pr2-pg-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'wakeshift.key'), KEY + '\n', { mode: 0o600 });
  fake = startFakeWakeshift(KEY);
  await inHome(() => registerLocalWriter(getEngine(), 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null }));
}, 120_000);

afterAll(async () => {
  if (!hasDatabase()) return;
  fake.stop();
  await disposePersistenceConsumer(getEngine());
  await teardownDB();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!hasDatabase()) return;
  writeConfig({});
  fake.calls.length = 0;
  fake.respond.clear();
  for (const table of ['wake_subscriptions', 'wake_terms_acceptances', 'wake_forgets', 'minion_jobs']) await getEngine().executeRaw(`DELETE FROM ${table}`);
});

const log = { info() {}, warn() {}, error() {} };
const stdio = { remote: true, transport: 'stdio' as const, sourceId: 'default', config: { engine: 'postgres' }, logger: log, mcpCaller: { client: 'claude-code' } };
const client = (id: string) => ({ remote: true, transport: 'http' as const, sourceId: 'default', config: { engine: 'postgres' }, logger: log,
  auth: { token: 't', clientId: id, principal: { kind: 'oauth_client' as const, id }, scopes: ['read', 'write', 'admin'] } });
const call = (op: string, params: Record<string, unknown>, ctx: object = stdio) => inHome(() => dispatchToolCall(getEngine(), op, params, ctx as never));
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const envelope = (r: { content: Array<{ text: string }> }, id: string) => { const { notices: _, ...rest } = JSON.parse(r.content[0]!.text.replaceAll(id, 'ID')); return rest; };
const emits = () => fake.calls.filter(c => c.path === '/events/emit');

async function writeNote(slug: string): Promise<string> {
  const id = randomUUID();
  const r = await call('put_page', { slug, content: `---\ntitle: Canary\n---\n\nalice-example canary body for ${slug}.\n`, request_id: id });
  expect(r.isError).toBeFalsy();
  await disposePersistenceConsumer(getEngine());
  return id;
}

d('wakeshift PR 2 on Postgres', () => {
  test('write.settled: a committed write wakes at once; a pending one wakes once it fails; no slug or text leaves', async () => {
    const a = await writeNote('notes/pg-settled-a');
    expect(body(await call('watch_write_request', { request_id: a }))).toMatchObject({ watching: true, state: 'committed', already_settled: true });
    expect(emits()).toHaveLength(1);
    expect(emits()[0]!.body.payload).toMatchObject({ request_id: a, state: 'committed', operation: 'put_page', next: `get_write_request ${a}` });
    const b = await writeNote('notes/pg-settled-b');
    await getEngine().executeRaw("UPDATE persistence_requests SET state = 'queued' WHERE request_id = $1::uuid", [b]);
    expect(body(await call('watch_write_request', { request_id: b }))).toMatchObject({ watching: true, already_settled: false });
    expect((await inHome(() => drainWakes(getEngine()))).delivered).toBe(0);
    await getEngine().executeRaw("UPDATE persistence_requests SET state = 'failed', error_code = 'storage_error', completed_at = now() WHERE request_id = $1::uuid", [b]);
    const [x, y] = await inHome(() => Promise.all([drainWakes(getEngine()), drainWakes(getEngine())]));
    expect(x.delivered + y.delivered).toBe(1);
    expect(emits()).toHaveLength(2);
    expect(emits()[1]!.body.payload).toMatchObject({ request_id: b, state: 'failed' });
    for (const e of emits()) for (const leak of ['pg-settled', 'canary', 'alice-example']) expect(JSON.stringify(e.body)).not.toContain(leak);
  });

  test('write.settled: a foreign request id reads like a missing one and like get_write_request', async () => {
    await getEngine().executeRaw("INSERT INTO oauth_clients (client_id, client_name, scope) VALUES ('wk2-b', 'wk2-b', 'read write admin') ON CONFLICT DO NOTHING");
    const foreign = await writeNote('notes/pg-settled-c');
    const missing = randomUUID();
    const a = await call('watch_write_request', { request_id: foreign }, client('wk2-b'));
    const b = await call('watch_write_request', { request_id: missing }, client('wk2-b'));
    const g = await call('get_write_request', { request_id: foreign }, client('wk2-b'));
    expect(envelope(a, foreign)).toEqual(envelope(b, missing));
    expect(envelope(a, foreign)).toEqual(envelope(g, foreign));
    expect(fake.calls).toHaveLength(0);
  });

  test('forget: member remove ends the watch and two concurrent drainers send one forget', async () => {
    await getEngine().executeRaw("INSERT INTO access_members (id) VALUES ('alice-example') ON CONFLICT (id) DO UPDATE SET disabled_at = NULL, tombstoned_at = NULL");
    await getEngine().executeRaw("INSERT INTO oauth_clients (client_id, client_name, scope, member_id) VALUES ('wk2-m', 'wk2-m', 'read write admin', 'alice-example') ON CONFLICT (client_id) DO UPDATE SET member_id = 'alice-example'");
    writeConfig({ terms_url: 'https://example.com/terms', privacy_url: 'https://example.com/privacy' });
    const [job] = await getEngine().executeRaw<{ id: number }>(`INSERT INTO minion_jobs (submission_authority, name, queue, status, data)
      VALUES ('{"version":1,"kind":"application"}'::jsonb, 'sync', 'default', 'active', '{"__submitter":"cli:test"}'::jsonb) RETURNING id`);
    const step = body(await call('watch_job', { id: Number(job!.id) }, client('wk2-m')));
    expect(step).toMatchObject({ agreement_required: true });
    expect(body(await call('accept_wakeshift_terms', { terms_version: step.terms_version }, client('wk2-m')))).toMatchObject({ accepted: true });
    expect(body(await call('watch_job', { id: Number(job!.id) }, client('wk2-m')))).toMatchObject({ watching: true });
    const user = fake.calls.find(c => c.path === '/event-subscriptions')!.body.call.user;
    await removeMember(getEngine(), 'alice-example');
    expect(await getEngine().executeRaw('SELECT state, last_error FROM wake_subscriptions')).toEqual([{ state: 'ended', last_error: 'principal_revoked' }]);
    const [x, y] = await inHome(() => Promise.all([drainWakes(getEngine()), drainWakes(getEngine())]));
    expect((x.forgotten ?? 0) + (y.forgotten ?? 0)).toBe(1);
    expect(fake.calls.filter(c => c.path === '/users/forget').map(c => c.body)).toEqual([{ user }]);
  });
});
