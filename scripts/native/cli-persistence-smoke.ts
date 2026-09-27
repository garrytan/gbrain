#!/usr/bin/env bun
/** Exercise the executable being released, with no source imports or operator state. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--binary') throw new Error('Usage: bun scripts/native/cli-persistence-smoke.ts --binary <release executable>');
const root = mkdtempSync(join(tmpdir(), 'gbrain-release-persistence-'));
const binary = join(root, process.platform === 'win32' ? 'gbrain.exe' : 'gbrain');
const database = process.platform === 'win32' ? join(root, 'brain.pglite')
  : join(root, 'long-界'.repeat(18), 'brain.pglite');
const checkout = join(root, 'pages');
const childTemp = join(root, 'tmp');
// Copying the artifact away from the checkout also rules out adjacent source
// files or native prebuilds accidentally satisfying a broken release bundle.
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: root, USERPROFILE: root, GBRAIN_HOME: root,
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp,
  LANG: 'C.UTF-8', LC_ALL: 'C',
  GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: 'default',
  GBRAIN_NO_BANNER: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SWEEP: '0',
  GBRAIN_INIT_SKIP_EMBED_CHECK: '1',
};
// Never spread process.env: release jobs may have publishing/provider tokens,
// database URLs, Git configuration overrides, or an unrelated operator home.
for (const name of ['SystemRoot', 'WINDIR', 'ComSpec']) if (process.env[name]) env[name] = process.env[name]!;
type OwnedChild = { exitCode: number | null; exited: Promise<number>; kill(signal?: NodeJS.Signals | number): void };
const children = new Set<OwnedChild>();
const outputLimit = 2 * 1024 * 1024;

async function collect(stream: ReadableStream<Uint8Array>, child: OwnedChild, append?: (part: string) => void): Promise<string> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return text;
      bytes += next.value.byteLength;
      if (bytes > outputLimit) { child.kill('SIGKILL'); throw new Error('Release CLI exceeded its bounded output allowance.'); }
      const part = decoder.decode(next.value, { stream: true });
      text += part; append?.(part);
    }
  } finally { reader.releaseLock(); }
}

async function run(argv: string[], expected: number | null = 0, timeoutMs = 60000) {
  const label = argv[0] === 'call' ? `call ${argv[3]}` : argv.slice(0, 3).join(' ');
  console.log(`[release-cli] ${label}`);
  const child = Bun.spawn([binary, ...argv], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  children.add(child);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([collect(child.stdout, child), collect(child.stderr, child), child.exited]);
    assert.equal(timedOut, false, `CLI timed out: ${argv.slice(0, 2).join(' ')}`);
    if (expected !== null) assert.equal(code, expected, `${argv.slice(0, 2).join(' ')} exited ${code}: ${stdout.slice(-6000)}\n${stderr.slice(-6000)}`);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); if (child.exitCode !== null) children.delete(child); }
}

function json(text: string): Record<string, any> {
  assert(text.trim(), 'The release CLI returned an empty JSON response.');
  const value = JSON.parse(text);
  assert(value && typeof value === 'object' && !Array.isArray(value), 'CLI must emit one JSON object.');
  return value;
}
async function call(operation: string, params: Record<string, unknown>, expected = 0) {
  const result = await run(['call', '--source', 'default', operation, JSON.stringify(params)], expected);
  assert(result.stdout.trim(), `${operation} returned no JSON receipt: ${result.stderr.slice(-6000)}`);
  return json(result.stdout);
}
function committed(result: Record<string, any>, requestId: string): string {
  assert.equal(result.state, 'committed');
  assert.equal(result.request_id, requestId);
  assert.equal(result.write_request?.request_id, requestId);
  assert.equal(result.write_request?.state, 'committed');
  assert.equal(result.persistence?.mode, 'filesystem');
  assert.match(result.revision, /^[0-9a-f-]{36}$/i);
  return result.revision;
}
async function readPage(slug: string, revision: string, sentinel: string) {
  const page = await call('get_page', { slug, include_content: true, source_id: 'default' });
  assert.equal(page.revision, revision);
  assert.equal(typeof page.content, 'string');
  assert(page.content.includes(sentinel), 'Reopened canonical page lost the expected content.');
  assert(readFileSync(join(checkout, `${slug}.md`), 'utf8').includes(sentinel), 'Canonical file does not match the acknowledged write.');
}
function ownerPid(): number { return JSON.parse(readFileSync(join(database, '.gbrain-lock', 'lock'), 'utf8')).pid; }

let owner: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
let ownerReads: Promise<unknown>[] = [];
async function stopOwner() {
  if (!owner) return;
  if (owner.exitCode === null) await owner.stdin.end();
  let forced = false;
  const timer = setTimeout(() => { forced = true; owner?.kill('SIGKILL'); }, 30000);
  try {
    const code = await owner.exited;
    await Promise.all(ownerReads);
    assert.equal(forced, false, 'Resident CLI did not drain and release its datastore.');
    assert.equal(code, 0, 'Resident CLI shutdown failed.');
  } finally { clearTimeout(timer); children.delete(owner); owner = undefined; ownerReads = []; }
}

try {
  mkdirSync(checkout); mkdirSync(childTemp); mkdirSync(dirname(database), { recursive: true });
  copyFileSync(resolve(args[1]), binary); chmodSync(binary, 0o700);
  await run(['init', '--pglite', '--path', database, '--non-interactive', '--no-embedding', '--json'], 0, 120000);
  const config = JSON.parse(readFileSync(join(root, '.gbrain', 'config.json'), 'utf8'));
  assert.equal(config.engine, 'pglite'); assert.equal(config.database_path, database); assert.equal(config.embedding_disabled, true);
  await run(['auth', 'local-writer', 'register', 'cli', '--json']);
  await run(['auth', 'local-writer', 'register', 'stdio', '--json']);
  const claimed = json((await run(['sources', 'writer', 'claim', 'default', '--path', checkout, '--json'])).stdout);
  assert.equal(claimed.claimed, true);
  const activated = json((await run(['sources', 'writer', 'activate', '--confirm-quiesced', '--json'])).stdout);
  assert.equal(activated.enabled, true);
  const status = json((await run(['sources', 'writer', 'status', '--probe', '--json'])).stdout);
  assert.equal(status.native_lock?.acquired, true); assert.equal(status.native_lock?.released, true);
  assert.equal(status.native_lock?.napi, 3);

  const slug = 'notes/release-smoke';
  const firstId = randomUUID();
  const first = { slug, source_id: 'default', request_id: firstId, content: '# Release example\n\nInitial canonical release sentinel.\n' };
  const firstRevision = committed(await call('put_page', first), firstId);
  await readPage(slug, firstRevision, 'Initial canonical release sentinel.');
  assert.equal(committed(await call('put_page', first), firstId), firstRevision, 'Same-ID replay created a new revision.');
  const updateId = randomUUID();
  const update = { ...first, request_id: updateId, expected_revision: firstRevision, content: '# Release example\n\nUpdated canonical release sentinel.\n' };
  const updateRevision = committed(await call('put_page', update), updateId);
  assert.notEqual(updateRevision, firstRevision);
  const staleId = randomUUID();
  const refused = await call('put_page', { ...update, request_id: staleId, content: '# Release example\n\nStale content must never publish.\n' }, 1);
  assert.equal(refused.error, 'revision_conflict');
  assert.equal(refused.write_request?.request_id, staleId); assert.equal(refused.write_request?.state, 'conflict');
  await readPage(slug, updateRevision, 'Updated canonical release sentinel.');

  owner = Bun.spawn([binary, 'serve'], { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  children.add(owner);
  let frames = '', ownerErrors = '';
  ownerReads = [collect(owner.stdout, owner, part => { frames += part; }), collect(owner.stderr, owner, part => { ownerErrors += part; })];
  // The stream readers must be observed immediately even when readiness fails.
  for (const read of ownerReads) void read.catch(() => {});
  owner.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-smoke', version: '1' },
  } }) + '\n');
  const deadline = performance.now() + 60000;
  for (;;) {
    const response = frames.split('\n').slice(0, -1).filter(Boolean).map(line => json(line)).find(frame => frame.id === 1);
    if (response) { assert(!response.error, JSON.stringify(response.error)); break; }
    assert.equal(owner.exitCode, null, `Resident CLI exited before initialization: ${ownerErrors.slice(-6000)}`);
    assert(performance.now() < deadline, `Resident CLI initialization timed out: ${ownerErrors.slice(-6000)}`);
    await delay(25);
  }
  owner.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal(ownerPid(), owner.pid);
  // MCP initialization precedes the separate persistence listener's boot. Use
  // an authenticated read through the release executable as its readiness
  // probe; never retry a mutation or mistake a queued receipt for readiness.
  const persistenceDeadline = performance.now() + 60000;
  const socketPath = join(database, '.gbrain-persistence.sock');
  if (process.platform !== 'win32') assert(Buffer.byteLength(socketPath) > 103, 'Release smoke must exercise the long Unix address fallback.');
  const diagnostics = () => `legacy_socket_path_bytes=${Buffer.byteLength(socketPath)}; owner stderr: ${ownerErrors.slice(-6000)}`;
  for (;;) {
    assert.equal(owner.exitCode, null, `Resident CLI exited before persistence readiness: ${diagnostics()}`);
    assert(!ownerErrors.includes('[persistence-ipc] listener unavailable'), `Resident persistence listener failed to bind: ${diagnostics()}`);
    assert(performance.now() < persistenceDeadline, `Resident persistence readiness timed out: ${diagnostics()}`);
    const probe = await run(['call', '--source', 'default', 'get_page', JSON.stringify({ slug, include_content: true, source_id: 'default' })],
      null, Math.max(1, Math.min(15000, persistenceDeadline - performance.now())));
    const result = json(probe.stdout);
    if (probe.code === 0) {
      assert.equal(result.revision, updateRevision);
      assert(result.content?.includes('Updated canonical release sentinel.'), `Readiness probe returned the wrong page: ${diagnostics()}`);
      assert.equal(ownerPid(), owner.pid, 'Readiness probe replaced the resident datastore owner.');
      break;
    }
    assert(probe.code === 1 && result.error === 'owner_unavailable' && result.submission_status === 'not_sent',
      `Readiness probe failed: ${probe.stdout.slice(-6000)}\n${probe.stderr.slice(-6000)}\n${diagnostics()}`);
    await delay(25);
  }
  const residentId = randomUUID();
  const resident = { ...update, request_id: residentId, expected_revision: updateRevision, content: '# Release example\n\nResident canonical release sentinel.\n' };
  const residentRevision = committed(await call('put_page', resident), residentId);
  assert.equal(ownerPid(), owner.pid, 'Delegated write replaced the resident datastore owner.');
  await readPage(slug, residentRevision, 'Resident canonical release sentinel.');
  assert.equal(committed(await call('put_page', resident), residentId), residentRevision);
  assert.equal(ownerPid(), owner.pid);
  await stopOwner();
  await readPage(slug, residentRevision, 'Resident canonical release sentinel.');
  assert.equal(committed(await call('put_page', resident), residentId), residentRevision, 'Receipt did not survive resident shutdown and reopen.');
  console.log(JSON.stringify({ ok: true, target: status.native_lock.target, binary: 'release artifact',
    legacy_socket_path_bytes: Buffer.byteLength(socketPath), checks: [...(process.platform === 'win32' ? [] : ['long-unicode-ipc-path']), 'keyless-init', 'native-probe', 'filesystem-publication', 'durable-replay', 'revision-conflict', 'authenticated-owner-readiness', 'resident-ipc', 'shutdown-reopen'] }));
} finally {
  try { await stopOwner(); }
  finally {
    for (const child of children) { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
    await Promise.allSettled(ownerReads);
    rmSync(root, { recursive: true, force: true });
  }
}
