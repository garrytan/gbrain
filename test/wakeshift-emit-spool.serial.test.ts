/**
 * GST-2679: `gbrain wakeshift emit cron.finished` on a PGLite brain held by another gbrain process (serve, the job
 * worker) spools the run under the brain's own gbrain home, and the holder's wake drainer records it with its original
 * finished time. Repo-less PGLite brain on disk, fake Wakeshift (test/helpers/fake-wakeshift.ts).
 *
 * Serial: every test runs under withEnv with GBRAIN_HOME at a temporary home holding config.json and the 0600 key file.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { encodeWakeshiftKey } from '../src/core/wakeshift/client.ts';
import { drainWakes } from '../src/core/wakeshift/drain.ts';
import { resetWakeshiftEnvKeyForTests } from '../src/core/wakeshift/config.ts';
import { wakeshiftManifestHash } from '../src/core/wakeshift/events.ts';
import { SPOOL_MAX_BYTES, SPOOL_MAX_FILES, cronSpoolDir, ingestCronSpool, spoolCronRun } from '../src/core/wakeshift/spool.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { reportEmitConnectFailure, runWakeshift } from '../src/commands/wakeshift.ts';
import { startFakeWakeshift, type FakeWakeshift } from './helpers/fake-wakeshift.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const KEY = encodeWakeshiftKey(Buffer.alloc(32, 22));
let engine: PGLiteEngine;
let fake: FakeWakeshift;
let home: string;
let datastore: string;

const inHome = <T>(fn: () => Promise<T> | T) => withEnv({ GBRAIN_HOME: home, WAKESHIFT_API_KEY: undefined }, async () => {
  resetWakeshiftEnvKeyForTests();
  return fn();
});

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config), { mode: 0o600 });
}
const pgliteOn = () => writeConfig({ engine: 'pglite', database_path: datastore, wakeshift: { enabled: true, url: fake.url, manifest_hash: wakeshiftManifestHash() } });
const spoolDir = () => inHome(() => cronSpoolDir(datastore));
const pending = async () => { const dir = await spoolDir(); return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json') || f.includes('.claimed-')) : []; };
const runs = () => engine.executeRaw<{ name: string; status: string; finished_at: Date }>('SELECT name, status, finished_at FROM wake_cron_runs ORDER BY id');
const emits = () => fake.calls.filter(c => c.path === '/events/emit');
const log = { info() {}, warn() {}, error() {} };
const stdio = { remote: true, transport: 'stdio' as const, sourceId: 'default', config: { engine: 'pglite' }, logger: log, mcpCaller: { client: 'claude-code' } };

async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const [log0, err0] = [console.log, console.error];
  let out = '', err = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  try { return { value: await inHome(fn), out, err }; } finally { console.log = log0; console.error = err0; }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-spool-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'wakeshift.key'), KEY + '\n', { mode: 0o600 });
  datastore = join(home, '.gbrain', 'brain.pglite');
  fake = startFakeWakeshift(KEY);
  engine = new PGLiteEngine();
  await inHome(async () => {
    await engine.connect({ engine: 'pglite', database_path: datastore });
    await engine.initSchema();
    await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
  });
}, 120_000);

afterAll(async () => {
  fake.stop();
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  pgliteOn();
  fake.calls.length = 0;
  fake.respond.clear();
  rmSync(join(home, '.gbrain', 'wakeshift-spool'), { recursive: true, force: true });
  for (const table of ['wake_subscriptions', 'wake_crons', 'wake_cron_runs']) await engine.executeRaw(`DELETE FROM ${table}`);
});

describe('emit while another gbrain process holds the PGLite brain', () => {
  test('the real CLI exits 0 and spools the run; the holder\'s drainer records it with its own time and wakes the watcher', async () => {
    await captured(() => runWakeshift(engine, ['cron', 'add', 'nightly-example']));
    const watch = await inHome(() => dispatchToolCall(engine, 'watch_cron', { name: 'nightly-example' }, stdio as never));
    expect(watch.isError).toBeFalsy();
    const before = Date.now();
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, WAKESHIFT_API_KEY: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
    const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, 'wakeshift', 'emit', 'cron.finished', '--name', 'nightly-example', '--status', 'failed'], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const after = Date.now();
    expect(exitCode).toBe(0);
    expect(stderr).toContain('so the nightly-example run was spooled');
    const files = await pending();
    expect(files).toHaveLength(1);
    const file = join(await spoolDir(), files[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(file.startsWith(join(home, '.gbrain', 'wakeshift-spool'))).toBe(true);
    const spooledAt = Date.parse(JSON.parse(readFileSync(file, 'utf8')).finished_at);
    expect(spooledAt).toBeGreaterThanOrEqual(before);
    expect(spooledAt).toBeLessThanOrEqual(after);
    expect(await runs()).toHaveLength(0);
    await Bun.sleep(20);
    expect(await inHome(() => drainWakes(engine))).toMatchObject({ delivered: 1 });
    const recorded = await runs();
    expect(recorded.map(r => [r.name, r.status])).toEqual([['nightly-example', 'failed']]);
    expect(new Date(recorded[0]!.finished_at).getTime()).toBe(spooledAt);
    expect(await pending()).toHaveLength(0);
    expect(emits()).toHaveLength(1);
    expect(emits()[0]!.body.payload).toMatchObject({ name: 'nightly-example', status: 'failed' });
    expect((await inHome(() => drainWakes(engine))).delivered).toBe(0);
    expect(await runs()).toHaveLength(1);
  }, 120_000);
});

describe('the spool', () => {
  test('two drainers ingesting at once record each spooled run exactly once, and a replayed claim is not recorded again', async () => {
    await inHome(() => { for (let i = 0; i < 5; i++) spoolCronRun(datastore, { name: 'nightly-example', status: 'ok' }, new Date(Date.now() - (5 - i) * 1000)); });
    await engine.executeRaw("INSERT INTO wake_crons (name) VALUES ('nightly-example')");
    const [a, b] = await inHome(() => Promise.all([ingestCronSpool(engine, datastore), ingestCronSpool(engine, datastore)]));
    expect(a.recorded + b.recorded).toBe(5);
    expect(await runs()).toHaveLength(5);
    expect(await pending()).toHaveLength(0);

    const dir = await spoolDir();
    const [run] = await runs();
    const stale = join(dir, `${String(new Date(run!.finished_at).getTime()).padStart(13, '0')}-00112233aabbccdd.json.claimed-0011223344556677`);
    writeFileSync(stale, JSON.stringify({ name: run!.name, status: run!.status, finished_at: new Date(run!.finished_at).toISOString() }), { mode: 0o600 });
    const old = new Date(Date.now() - 11 * 60_000);
    (await import('node:fs')).utimesSync(stale, old, old);
    expect(await inHome(() => ingestCronSpool(engine, datastore))).toEqual({ recorded: 1, rejected: 0 });
    expect(await runs()).toHaveLength(5);
    expect(await pending()).toHaveLength(0);
  });

  test('a malformed or oversized file is moved to rejected/ and reported once, never retried', async () => {
    const dir = await spoolDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0000000000001-aaaaaaaaaaaaaaaa.json'), '{not json', { mode: 0o600 });
    writeFileSync(join(dir, '0000000000002-bbbbbbbbbbbbbbbb.json'), JSON.stringify({ name: 'x', status: 'ok', finished_at: new Date().toISOString(), pad: 'p'.repeat(SPOOL_MAX_BYTES) }), { mode: 0o600 });
    writeFileSync(join(dir, '0000000000003-cccccccccccccccc.json'), JSON.stringify({ name: 'Bad Name', status: 'ok', finished_at: new Date().toISOString() }), { mode: 0o600 });
    const first = await captured(() => ingestCronSpool(engine, datastore));
    expect(first.value).toEqual({ recorded: 0, rejected: 3 });
    expect(first.err).toContain('not JSON');
    expect(first.err).toContain(`at most ${SPOOL_MAX_BYTES}`);
    expect(first.err).toContain('not a cron run');
    expect(readdirSync(join(dir, 'rejected')).sort()).toHaveLength(3);
    expect(await pending()).toHaveLength(0);
    const again = await captured(() => ingestCronSpool(engine, datastore));
    expect(again.value).toEqual({ recorded: 0, rejected: 0 });
    expect(again.err).toBe('');
    expect(await runs()).toHaveLength(0);
  });

  test('a spooled time the database cannot store is moved to rejected/ and does not hold back the runs after it', async () => {
    const dir = await spoolDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0000000000001-aaaaaaaaaaaaaaaa.json'), JSON.stringify({ name: 'nightly-example', status: 'ok', finished_at: '0000-01-01T00:00:00.000Z' }), { mode: 0o600 });
    await inHome(() => spoolCronRun(datastore, { name: 'nightly-example', status: 'failed' }));
    const r = await captured(() => ingestCronSpool(engine, datastore));
    expect(r.value).toEqual({ recorded: 1, rejected: 1 });
    expect(r.err).toContain('not a cron run');
    expect(readdirSync(join(dir, 'rejected'))).toEqual(['0000000000001-aaaaaaaaaaaaaaaa.json']);
    expect((await runs()).map(x => x.status)).toEqual(['failed']);
    expect(await pending()).toHaveLength(0);
  });

  test('a direct emit records its own run even when the spool cannot be ingested', async () => {
    const dir = await spoolDir();
    mkdirSync(join(dir, 'rejected'), { recursive: true });
    writeFileSync(join(dir, '0000000000001-aaaaaaaaaaaaaaaa.json'), '{not json', { mode: 0o600 });
    chmodSync(join(dir, 'rejected'), 0o500);
    try {
      const r = await captured(() => runWakeshift(engine, ['emit', 'cron.finished', '--name', 'nightly-example', '--status', 'ok']));
      expect(r.err).toContain('could not take the spooled cron runs');
      expect((await runs()).map(x => [x.name, x.status])).toEqual([['nightly-example', 'ok']]);
    } finally {
      chmodSync(join(dir, 'rejected'), 0o700);
    }
  });

  test('a spooled run of an unregistered cron is recorded with the same hint as the direct path, and the next direct emit takes leftovers', async () => {
    await inHome(() => spoolCronRun(datastore, { name: 'never-added', status: 'ok' }));
    const r = await captured(() => runWakeshift(engine, ['emit', 'cron.finished', '--name', 'never-added', '--status', 'failed']));
    expect(r.err).toContain('cron never-added is not registered');
    expect((await runs()).map(x => x.status)).toEqual(['ok', 'failed']);
    expect(await pending()).toHaveLength(0);
  });

  test('a full spool keeps the cron script\'s status and says why the run was dropped', async () => {
    const dir = await spoolDir();
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < SPOOL_MAX_FILES; i++) writeFileSync(join(dir, `${String(i).padStart(13, '0')}-${i.toString(16).padStart(16, '0')}.json`), '{}');
    const r = await captured(() => reportEmitConnectFailure(['cron.finished', '--name', 'nightly-example', '--status', 'ok'], new Error('busy')));
    expect(r.err).toContain(`${SPOOL_MAX_FILES} runs already wait in the spool`);
    expect(await pending()).toHaveLength(SPOOL_MAX_FILES);
  });

  test('nothing is spooled when reporting back is off, or on a Postgres brain', async () => {
    writeConfig({ engine: 'pglite', database_path: datastore, wakeshift: { enabled: false } });
    const off = await captured(() => reportEmitConnectFailure(['cron.finished', '--name', 'nightly-example', '--status', 'ok'], new Error('busy')));
    expect(off.err).toBe('[wakeshift] could not record the nightly-example run: the brain could not be opened (busy).\n');
    writeConfig({ engine: 'postgres', database_url: 'postgresql://nobody@127.0.0.1:1/none', wakeshift: { enabled: true, url: fake.url, manifest_hash: wakeshiftManifestHash() } });
    const pg = await captured(() => reportEmitConnectFailure(['cron.finished', '--name', 'nightly-example', '--status', 'ok'], new Error('refused')));
    expect(pg.err).toBe('[wakeshift] could not record the nightly-example run: the brain could not be opened (refused).\n');
    expect(existsSync(join(home, '.gbrain', 'wakeshift-spool'))).toBe(false);
  });
});
