/**
 * Wakeshift PR 2 on a repo-less PGLite brain against a fake Wakeshift (test/helpers/fake-wakeshift.ts):
 * gbrain.write.settled (committed, failed, recovering, a foreign id reading like get_write_request's not_found, and a
 * git-canonical source), gbrain.cron.finished (unregistered name, registered run, emit while off), the shared-brain
 * agreement step (enable needs links, accept, changed links re-ask, an unaccepted watch ends), forget on remove
 * (member remove, token revoke, client delete) and the gate staying inert when off.
 *
 * Serial: every test runs under withEnv with GBRAIN_HOME at a temporary home holding config.json and the 0600 key file.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disabledOpsForPublishGates } from '../src/mcp/publish-gates.ts';
import { encodeWakeshiftKey } from '../src/core/wakeshift/client.ts';
import { drainWakes } from '../src/core/wakeshift/drain.ts';
import { resetWakeshiftEnvKeyForTests } from '../src/core/wakeshift/config.ts';
import { wakeshiftManifest, wakeshiftManifestHash } from '../src/core/wakeshift/events.ts';
import { forgetWakePrincipal } from '../src/core/wakeshift/forget.ts';
import { WAKESHIFT_CONNECTOR_TERMS_URL, WAKESHIFT_PRIVACY_URL } from '../src/core/wakeshift/terms.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { removeMember } from '../src/core/access/members.ts';
import { mintLegacyToken, revokeLegacyTokenById } from '../src/core/token-mint.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { runWakeshift } from '../src/commands/wakeshift.ts';
import { wakeshiftEntry } from '../src/commands/doctor/checks/wakeshift.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { startFakeWakeshift, type FakeWakeshift } from './helpers/fake-wakeshift.ts';
import { withEnv } from './helpers/with-env.ts';

const KEY = encodeWakeshiftKey(Buffer.alloc(32, 21));
const PR2_OPS = ['watch_write_request', 'watch_cron', 'accept_wakeshift_terms', 'watch_job', 'list_watches', 'unwatch'];
const TERMS = 'https://example.com/terms';
const PRIVACY = 'https://example.com/privacy';
let engine: PGLiteEngine;
let fake: FakeWakeshift;
let home: string;
let writer: Awaited<ReturnType<typeof registerLocalWriter>>;

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, WAKESHIFT_API_KEY: undefined }, async () => {
  resetWakeshiftEnvKeyForTests();
  return fn();
});

function writeConfig(wakeshift: Record<string, unknown> | null): void {
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...(wakeshift ? { wakeshift } : {}) }), { mode: 0o600 });
}
const fileConfig = () => JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-pr2-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'wakeshift.key'), KEY + '\n', { mode: 0o600 });
  fake = startFakeWakeshift(KEY);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  writer = await inHome(() => registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null }));
}, 120_000);

afterAll(async () => {
  fake.stop();
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  writeConfig({ enabled: true, url: fake.url, manifest_hash: wakeshiftManifestHash() });
  fake.calls.length = 0;
  fake.respond.clear();
  for (const table of ['wake_subscriptions', 'wake_crons', 'wake_cron_runs', 'wake_terms_acceptances', 'wake_forgets', 'minion_jobs']) await engine.executeRaw(`DELETE FROM ${table}`);
  await engine.executeRaw('UPDATE access_members SET tombstoned_at = COALESCE(tombstoned_at, now()), disabled_at = COALESCE(disabled_at, now())');
});

const log = { info() {}, warn() {}, error() {} };
const stdio = { remote: true, transport: 'stdio' as const, sourceId: 'default', config: { engine: 'pglite' }, logger: log, mcpCaller: { client: 'claude-code' } };
const client = (clientId: string, scopes = ['admin', 'write', 'read']) => ({ remote: true, transport: 'http' as const, sourceId: 'default', config: { engine: 'pglite' }, logger: log,
  auth: { token: 't', clientId, principal: { kind: 'oauth_client' as const, id: clientId }, scopes } });
const doctorChecks = () => inHome(async () => {
  const out = await wakeshiftEntry.run({ engine, args: [], jsonOutput: true, fastMode: false, doFix: false, dryRun: false } as unknown as DoctorContext);
  if (!Array.isArray(out)) throw new Error('the wakeshift doctor entry stopped doctor');
  return out;
});
const call = (op: string, params: Record<string, unknown>, ctx: object = stdio) => inHome(() => dispatchToolCall(engine, op, params, ctx as never));
const drain = () => inHome(() => drainWakes(engine));
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const envelope = (r: { content: Array<{ text: string }> }, id: string) => { const { notices: _, ...rest } = JSON.parse(r.content[0]!.text.replaceAll(id, 'ID')); return rest; };
const emits = () => fake.calls.filter(c => c.path === '/events/emit');
const paths = (p: string) => fake.calls.filter(c => c.path === p);

async function addClient(id: string, member?: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, scope, member_id) VALUES ($1, $1, 'read write admin', $2)
    ON CONFLICT (client_id) DO UPDATE SET deleted_at = NULL, member_id = EXCLUDED.member_id`, [id, member ?? null]);
}

async function addMember(id: string): Promise<void> {
  await engine.executeRaw("INSERT INTO access_members (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET disabled_at = NULL, tombstoned_at = NULL", [id]);
}

async function seedJob(status = 'active'): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, started_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'sync', 'default', $1, '{"__submitter":"cli:test"}'::jsonb, now()) RETURNING id`, [status]);
  return Number(rows[0]!.id);
}

/** A real put_page over stdio on this repo-less brain; returns the committed request's id. */
async function writeNote(slug: string): Promise<string> {
  const requestId = randomUUID();
  const r = await call('put_page', { slug, content: `---\ntitle: Private canary\n---\n\nalice-example canary body for ${slug}.\n`, request_id: requestId });
  expect(r.isError).toBeFalsy();
  await disposePersistenceConsumer(engine);
  return requestId;
}

async function cli(args: string[]): Promise<{ out: string; err: string; error?: unknown }> {
  const [log0, err0] = [console.log, console.error];
  let out = '', err = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  try { await inHome(() => runWakeshift(engine, args)); return { out, err }; } catch (error) { return { out, err, error }; } finally { console.log = log0; console.error = err0; }
}

describe('gbrain.write.settled', () => {
  test('a committed write wakes during the watch call with a pointer payload and no slug or text', async () => {
    const id = await writeNote('notes/settled-a');
    const r = await call('watch_write_request', { request_id: id, harness: 'claude-code' });
    expect(r.isError).toBeFalsy();
    expect(body(r)).toMatchObject({ watching: true, request_id: id, event: 'gbrain.write.settled', state: 'committed', already_settled: true });
    const sub = paths('/event-subscriptions')[0]!;
    expect(sub.body).toMatchObject({ name: 'gbrain.write.settled', arguments: { request_id: id }, once: true, ttl: '7d' });
    expect(emits()).toHaveLength(1);
    const e = emits()[0]!.body;
    expect(e.payload).toMatchObject({ request_id: id, state: 'committed', operation: 'put_page', source_id: 'default', next: `get_write_request ${id}` });
    expect(e.text).toBe(`gbrain: write request ${id} (put_page) committed. Call get_write_request ${id} for the receipt.`);
    expect(e.id).toMatch(new RegExp(`^gbrain\\.write\\.settled:${id}:committed:\\d+:\\d+:[0-9a-f]{12}$`));
    const raw = JSON.stringify(e);
    for (const leak of ['notes/settled-a', 'canary', 'alice-example', 'Private']) expect(raw).not.toContain(leak);
    expect((await drain()).delivered).toBe(0);
  });

  test('a pending write wakes once it fails; a committed write with a live recovery record waits', async () => {
    const id = await writeNote('notes/settled-b');
    await engine.executeRaw("UPDATE persistence_requests SET state = 'queued' WHERE request_id = $1::uuid", [id]);
    expect(body(await call('watch_write_request', { request_id: id }))).toMatchObject({ watching: true, state: 'queued', already_settled: false });
    expect((await drain()).delivered).toBe(0);
    await engine.executeRaw(`UPDATE persistence_requests SET state = 'committed', recovery = '{"kind":"test"}'::jsonb WHERE request_id = $1::uuid`, [id]);
    expect((await drain()).delivered).toBe(0);
    await engine.executeRaw("UPDATE persistence_requests SET state = 'failed', recovery = NULL, error_code = 'storage_error', completed_at = now() WHERE request_id = $1::uuid", [id]);
    expect((await drain()).delivered).toBe(1);
    expect(emits()).toHaveLength(1);
    expect(emits()[0]!.body.payload).toMatchObject({ request_id: id, state: 'failed', next: `get_write_request ${id}` });
    expect((await drain()).delivered).toBe(0);
  });

  test('a foreign request id reads exactly like a missing one and like get_write_request, and nothing is sent', async () => {
    await addClient('client-w');
    const foreign = await writeNote('notes/settled-c');
    const missing = randomUUID();
    const a = await call('watch_write_request', { request_id: foreign }, client('client-w'));
    const b = await call('watch_write_request', { request_id: missing }, client('client-w'));
    const g = await call('get_write_request', { request_id: foreign }, client('client-w'));
    expect(a.isError).toBe(true);
    expect(envelope(a, foreign)).toEqual(envelope(b, missing));
    expect(envelope(a, foreign)).toEqual(envelope(g, foreign));
    expect(envelope(a, foreign).code ?? envelope(a, foreign).error).toBe('not_found');
    expect(fake.calls).toHaveLength(0);
  });

  test('a watch on a git-canonical source wakes when the write commits to the checkout', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-repo-'));
    const gitEngine = new PGLiteEngine();
    await gitEngine.connect({});
    await gitEngine.initSchema();
    try {
      await gitEngine.setConfig('sync.repo_path', repo);
      await inHome(() => registerLocalWriter(gitEngine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null }));
      const id = randomUUID();
      const put = await inHome(() => dispatchToolCall(gitEngine, 'put_page', { slug: 'notes/settled-git', content: '---\ntitle: Git\n---\n\nbody.\n', request_id: id }, stdio as never));
      expect(put.isError).toBeFalsy();
      expect(existsSync(join(repo, 'notes', 'settled-git.md'))).toBe(true);
      const r = await inHome(() => dispatchToolCall(gitEngine, 'watch_write_request', { request_id: id }, stdio as never));
      expect(body(r)).toMatchObject({ watching: true, state: 'committed', already_settled: true });
      expect(emits()).toHaveLength(1);
      expect(emits()[0]!.body.payload).toMatchObject({ request_id: id, state: 'committed', operation: 'put_page' });
      expect(JSON.stringify(emits()[0]!.body)).not.toContain('settled-git');
    } finally {
      await disposePersistenceConsumer(gitEngine);
      await gitEngine.disconnect();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);

  test('list_watches names the target generically, and unwatch takes a request_id, a cron or a watch id', async () => {
    const id = await writeNote('notes/settled-d');
    await engine.executeRaw("UPDATE persistence_requests SET state = 'queued' WHERE request_id = $1::uuid", [id]);
    await call('watch_write_request', { request_id: id });
    const job = await seedJob();
    await call('watch_job', { id: job });
    await engine.executeRaw("INSERT INTO wake_crons (name) VALUES ('nightly-digest')");
    await call('watch_cron', { name: 'nightly-digest' });
    const listed = body(await call('list_watches', {})).watches;
    expect(listed.map((w: Record<string, unknown>) => [w.event, w.target])).toEqual([
      ['gbrain.cron.finished', 'nightly-digest'], ['gbrain.job.finished', String(job)], ['gbrain.write.settled', id]]);
    expect(listed[1].job).toBe(job);
    expect(listed[2].request_id).toBe(id);
    expect(body(await call('unwatch', { request_id: id }))).toMatchObject({ request_id: id, ended: 1 });
    expect(body(await call('unwatch', { cron: 'Nightly Digest' }))).toMatchObject({ cron: 'nightly-digest', ended: 1 });
    expect(body(await call('unwatch', { watch: listed[1].watch }))).toMatchObject({ ended: 1 });
    expect((await call('unwatch', { job, cron: 'x' })).isError).toBe(true);
    await engine.executeRaw("UPDATE persistence_requests SET state = 'committed' WHERE request_id = $1::uuid", [id]);
    await drain();
    expect(emits()).toHaveLength(0);
  });
});

describe('gbrain.cron.finished', () => {
  test('an unregistered name reads not_found and nothing reaches Wakeshift', async () => {
    const r = await call('watch_cron', { name: 'never-added' });
    expect(r.isError).toBe(true);
    expect(body(r).code ?? body(r).error).toBe('not_found');
    expect(fake.calls).toHaveLength(0);
  });

  test('a registered cron wakes its watcher once on the next run, not on an earlier one', async () => {
    expect((await cli(['cron', 'add', 'Nightly Digest'])).out).toContain('stored as nightly-digest');
    expect((await cli(['emit', 'cron.finished', '--name', 'nightly-digest', '--status', 'ok'])).err).toBe('');
    await engine.executeRaw("UPDATE wake_cron_runs SET finished_at = now() - interval '1 minute'");
    const r = await call('watch_cron', { name: 'nightly-digest' });
    expect(body(r)).toMatchObject({ watching: true, cron: 'nightly-digest', event: 'gbrain.cron.finished', wakes: 'once, on the next run' });
    expect(paths('/event-subscriptions')[0]!.body).toMatchObject({ name: 'gbrain.cron.finished', arguments: { name: 'nightly-digest' }, once: true, ttl: '7d' });
    expect((await drain()).delivered).toBe(0);
    const emitted = await cli(['emit', 'cron.finished', '--name', 'nightly-digest', '--status', 'failed']);
    expect(emitted.error).toBeUndefined();
    expect(fake.calls.filter(c => c.path === '/events/emit')).toHaveLength(0);
    expect((await drain()).delivered).toBe(1);
    expect((await drain()).delivered).toBe(0);
    const e = emits()[0]!.body;
    expect(e.payload).toMatchObject({ name: 'nightly-digest', status: 'failed', next: 'watch_cron nightly-digest to hear about its next run' });
    expect(e.payload.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.id).toMatch(/^gbrain\.cron\.finished:nightly-digest:\d+:failed:\d+:[0-9a-f]{12}$/);
    const listed = await cli(['cron', 'list', '--json']);
    expect(JSON.parse(listed.out).crons).toMatchObject([{ name: 'nightly-digest', last_status: 'failed' }]);
  });

  test('emit while reporting back is off exits 0 with one stderr line, records nothing and sends nothing', async () => {
    writeConfig({ enabled: false, url: fake.url });
    await engine.executeRaw("INSERT INTO wake_crons (name) VALUES ('nightly-digest')");
    process.exitCode = 0;
    const r = await cli(['emit', 'cron.finished', '--name', 'nightly-digest', '--status', 'ok']);
    expect(r.error).toBeUndefined();
    expect(process.exitCode ?? 0).toBe(0);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('reporting back is off');
    expect(await engine.executeRaw('SELECT 1 FROM wake_cron_runs')).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  test('an unregistered emit is recorded with a stderr hint, and doctor names it', async () => {
    const r = await cli(['emit', 'cron.finished', '--name', 'typo-cron', '--status', 'ok']);
    expect(r.err).toContain('gbrain wakeshift cron add typo-cron');
    const checks = await doctorChecks();
    expect(checks[0]).toMatchObject({ status: 'warn', details: { unregistered_crons_7d: ['typo-cron'] } });
  });
});

describe('shared-brain terms', () => {
  test('enable on a brain with members refuses without links, and with links stores them and the manifest hash', async () => {
    await addMember('alice-example');
    writeConfig(null);
    const refused = await cli(['enable', '--yes', '--url', fake.url]);
    expect(String((refused.error as Error)?.message)).toContain('live access member');
    expect(JSON.stringify(refused.error)).toContain('--terms-url');
    expect(fake.calls).toHaveLength(0);
    const bad = await cli(['enable', '--yes', '--url', fake.url, '--terms-url', 'http://example.com/terms', '--privacy-url', PRIVACY]);
    expect(bad.error).toBeDefined();
    const ok = await cli(['enable', '--yes', '--url', fake.url, '--terms-url', TERMS, '--privacy-url', PRIVACY, '--json']);
    expect(ok.error).toBeUndefined();
    expect(fileConfig().wakeshift).toEqual({ enabled: true, url: fake.url, terms_url: TERMS, privacy_url: PRIVACY, manifest_hash: wakeshiftManifestHash() });
    expect(fake.calls.find(c => c.path === '/manifest/merge')!.body.events.map((e: { name: string }) => e.name))
      .toEqual(['gbrain.job.finished', 'gbrain.write.settled', 'gbrain.cron.finished']);
    expect(JSON.parse(ok.out).terms_version).toMatch(/^[0-9a-f]{16}$/);
    const again = await cli(['enable', '--yes', '--url', fake.url]);
    expect(again.error).toBeUndefined();
  });

  test('the first watch returns the agreement step, accept records it, and the watch then subscribes and wakes', async () => {
    await addMember('alice-example');
    await addClient('client-m', 'alice-example');
    writeConfig({ enabled: true, url: fake.url, terms_url: TERMS, privacy_url: PRIVACY });
    const job = await seedJob();
    const step = body(await call('watch_job', { id: job }, client('client-m')));
    expect(step).toMatchObject({ watching: false, agreement_required: true, operator_terms_url: TERMS, operator_privacy_url: PRIVACY,
      wakeshift_connector_terms_url: WAKESHIFT_CONNECTOR_TERMS_URL, wakeshift_privacy_url: WAKESHIFT_PRIVACY_URL,
      next: { tool: 'accept_wakeshift_terms', arguments: { terms_version: step.terms_version } } });
    expect(step.wakeshift_disclosure).toContain('Clawvisor Inc.');
    expect(fake.calls).toHaveLength(0);
    expect(body(await call('accept_wakeshift_terms', { terms_version: '0000000000000000' }, client('client-m')))).toMatchObject({ agreement_required: true });
    expect(body(await call('accept_wakeshift_terms', { terms_version: step.terms_version }, client('client-m')))).toMatchObject({ accepted: true });
    expect(await engine.executeRaw('SELECT principal_key FROM wake_terms_acceptances')).toEqual([{ principal_key: 'member:alice-example' }]);
    expect(body(await call('watch_job', { id: job }, client('client-m')))).toMatchObject({ watching: true, job });
    await engine.executeRaw("UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1", [job]);
    expect((await drain()).delivered).toBe(1);
    writeConfig({ enabled: true, url: fake.url, terms_url: 'https://example.com/terms-v2', privacy_url: PRIVACY });
    const reask = body(await call('watch_job', { id: job }, client('client-m')));
    expect(reask).toMatchObject({ agreement_required: true, operator_terms_url: 'https://example.com/terms-v2' });
    expect(reask.terms_version).not.toBe(step.terms_version);
  });

  test('a watch whose principal never accepted the current terms ends with terms_not_accepted instead of waking', async () => {
    await addClient('client-n');
    const job = await seedJob();
    expect(body(await call('watch_job', { id: job }, client('client-n')))).toMatchObject({ watching: true });
    await addMember('alice-example');
    writeConfig({ enabled: true, url: fake.url, terms_url: TERMS, privacy_url: PRIVACY });
    await engine.executeRaw("UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1", [job]);
    expect(await drain()).toMatchObject({ delivered: 0, ended: 1 });
    expect(emits()).toHaveLength(0);
    expect(paths('/event-subscriptions/end')).toHaveLength(1);
    const [row] = await engine.executeRaw<{ state: string; last_error: string }>('SELECT state, last_error FROM wake_subscriptions');
    expect(row).toMatchObject({ state: 'ended', last_error: 'terms_not_accepted' });
  });

  test('owner-only brains skip the step', async () => {
    const job = await seedJob();
    expect(body(await call('watch_job', { id: job }, stdio))).toMatchObject({ watching: true });
    expect(body(await call('accept_wakeshift_terms', { terms_version: '0000000000000000' }, stdio))).toMatchObject({ required: false });
  });
});

describe('forget on remove', () => {
  test('member remove ends its watches, drops its acceptance and the drainer sends one forget', async () => {
    await addMember('alice-example');
    await addClient('client-f', 'alice-example');
    writeConfig({ enabled: true, url: fake.url, terms_url: TERMS, privacy_url: PRIVACY });
    const step = body(await call('watch_job', { id: await seedJob() }, client('client-f')));
    await call('accept_wakeshift_terms', { terms_version: step.terms_version }, client('client-f'));
    expect(body(await call('watch_job', { id: await seedJob() }, client('client-f')))).toMatchObject({ watching: true });
    const user = paths('/event-subscriptions')[0]!.body.call.user;
    fake.calls.length = 0;
    await removeMember(engine, 'alice-example');
    expect(fake.calls).toHaveLength(0);
    expect(await engine.executeRaw('SELECT state, last_error FROM wake_subscriptions')).toEqual([{ state: 'ended', last_error: 'principal_revoked' }]);
    expect(await engine.executeRaw('SELECT 1 FROM wake_terms_acceptances')).toHaveLength(0);
    expect(await drain()).toMatchObject({ forgotten: 1 });
    expect(paths('/users/forget').map(c => c.body)).toEqual([{ user }]);
    expect(await engine.executeRaw('SELECT state FROM wake_forgets')).toEqual([{ state: 'done' }]);
    expect((await drain()).forgotten ?? 0).toBe(0);
  });

  test('token revoke ends the token\'s watches and queues its forget, with reporting back off and no network', async () => {
    const minted = await mintLegacyToken(engine, { name: 'wake-token', takesHolders: ['world'], scopes: ['read', 'write', 'admin'] });
    const ctx = { remote: true, transport: 'http' as const, sourceId: 'default', config: { engine: 'pglite' }, logger: log,
      auth: { token: 't', clientId: minted.id, principal: { kind: 'legacy_token' as const, id: minted.id }, scopes: ['read', 'write', 'admin'] } };
    expect(body(await call('watch_job', { id: await seedJob() }, ctx))).toMatchObject({ watching: true });
    writeConfig({ enabled: false, url: fake.url });
    fake.calls.length = 0;
    expect(await revokeLegacyTokenById(sqlQueryForEngine(engine), minted.id)).toBe(true);
    expect(await engine.executeRaw('SELECT state, last_error FROM wake_subscriptions')).toEqual([{ state: 'ended', last_error: 'principal_revoked' }]);
    expect(await engine.executeRaw("SELECT state FROM wake_forgets")).toEqual([{ state: 'pending' }]);
    expect(await drain()).toMatchObject({ skipped: 'off' });
    expect(fake.calls).toHaveLength(0);
    writeConfig({ enabled: true, url: fake.url });
    expect(await drain()).toMatchObject({ forgotten: 1 });
  });

  test('OAuth client delete: the revoke-client hook ends and queues; a delete the hook never saw is caught at emit time', async () => {
    await addClient('client-d1');
    await addClient('client-d2');
    const [j1, j2] = [await seedJob(), await seedJob()];
    await call('watch_job', { id: j1 }, client('client-d1'));
    await call('watch_job', { id: j2 }, client('client-d2'));
    await engine.executeRaw("DELETE FROM oauth_clients WHERE client_id = 'client-d1'");
    expect(await inHome(() => forgetWakePrincipal(sqlQueryForEngine(engine), { kind: 'oauth_client', id: 'client-d1' }))).toEqual({ ended: 1, queued: 1 });
    await engine.executeRaw("UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'client-d2'");
    await engine.executeRaw("UPDATE minion_jobs SET status = 'completed', finished_at = now()");
    expect(await drain()).toMatchObject({ delivered: 0, ended: 1, forgotten: 1 });
    expect(emits()).toHaveLength(0);
    expect(await drain()).toMatchObject({ forgotten: 1 });
    expect(paths('/users/forget')).toHaveLength(2);
    expect(new Set(paths('/users/forget').map(c => c.body.user)).size).toBe(2);
  });

  test('a refused forget is retried on the schedule and then dies', async () => {
    await engine.executeRaw("INSERT INTO wake_forgets (wake_user) VALUES ('0123456789abcdef0123456789abcdef')");
    fake.respond.set('/users/forget', () => ({ status: 503, body: { error: { code: 'unavailable', message: 'down' } } }));
    await drain();
    const [r1] = await engine.executeRaw<{ state: string; attempts: number; delay: number }>("SELECT state, attempts, round(extract(epoch FROM next_attempt_at - now()))::int AS delay FROM wake_forgets");
    expect(r1).toMatchObject({ state: 'pending', attempts: 1, delay: 30 });
    fake.respond.set('/users/forget', () => ({ status: 400, body: { error: { code: 'bad_request', message: 'no' } } }));
    await engine.executeRaw("UPDATE wake_forgets SET next_attempt_at = now() - interval '1 second'");
    await drain();
    expect(await engine.executeRaw('SELECT state, last_error FROM wake_forgets')).toEqual([{ state: 'dead', last_error: 'bad_request' }]);
  });
});

describe('status, doctor and the gate', () => {
  test('status and doctor say when the published manifest is older than this build', async () => {
    writeConfig({ enabled: true, url: fake.url, manifest_hash: 'feedfacefeedface' });
    const st = JSON.parse((await cli(['status', '--json'])).out);
    expect(st.manifest).toEqual({ current: false, fix: 'gbrain wakeshift enable' });
    const checks = await doctorChecks();
    expect(checks[0]).toMatchObject({ status: 'warn', details: { manifest_current: false } });
    expect(checks[0]!.message).toContain('gbrain wakeshift enable');
    writeConfig({ enabled: true, url: fake.url, manifest_hash: wakeshiftManifestHash() });
    expect(JSON.parse((await cli(['status', '--json'])).out).manifest).toEqual({ current: true });
  });

  test('doctor warns about a queued forget older than a day', async () => {
    await engine.executeRaw("INSERT INTO wake_forgets (wake_user, created_at) VALUES ('0123456789abcdef0123456789abcdef', now() - interval '2 days')");
    const checks = await doctorChecks();
    expect(checks[0]).toMatchObject({ status: 'warn', details: { stale_forgets: 1 } });
  });

  test('the manifest carries both new events, personal and deleted on delivery', () => {
    const events = wakeshiftManifest().events as Array<Record<string, any>>;
    for (const name of ['gbrain.write.settled', 'gbrain.cron.finished']) {
      const e = events.find(x => x.name === name)!;
      expect(e).toMatchObject({ personal: true, delete_on_delivery: true });
      expect(e.payload.additionalProperties).toBe(false);
      expect(Object.keys(e.payload.properties)).not.toContain('slug');
    }
  });

  test('gate off: every watch tool is hidden and refuses, and nothing is fetched', async () => {
    writeConfig({ enabled: false, url: fake.url });
    const disabled = await inHome(() => disabledOpsForPublishGates(engine, null, { transport: 'stdio' }));
    for (const op of PR2_OPS) expect(disabled.has(op)).toBe(true);
    await engine.executeRaw("INSERT INTO wake_crons (name) VALUES ('nightly-digest')");
    for (const [op, params] of [['watch_write_request', { request_id: randomUUID() }], ['watch_cron', { name: 'nightly-digest' }], ['accept_wakeshift_terms', { terms_version: '0000000000000000' }]] as const) {
      const r = await call(op, params);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('wakeshift_not_enabled');
    }
    expect(fake.calls).toHaveLength(0);
  });
});
