/** Real CLI → resident owner import, SIGKILL, and same-cursor recovery. */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';
import { inspectLockHolder } from '../../src/core/pglite-lock.ts';
import { persistenceSocketPathForConfig, requestPersistenceCapabilities,
  requestPersistenceAdministration, requestPersistenceOperation,
  type PersistenceIpcCapabilities, type PersistenceIpcOperation } from '../../src/core/persistence/ipc.ts';
import type { PersistenceAdminOperation } from '../../src/core/persistence/admin-contract.ts';
import { readPersistenceCliRegistration } from '../../src/core/persistence/local-client.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_SWEEP', 'GBRAIN_SYNC_NO_DELEGATE'];
let tmpParent: string, dbDir: string, repo: string, claimBarrier: string;
let serveProc: ReturnType<typeof Bun.spawn> | undefined;
let serveStderr = '';
const serveReaders: Promise<void>[] = [];
let capabilities: PersistenceIpcCapabilities;
let initialCommit: string, bulkCommit: string;
let interruptedRun: string;
let pendingRequestId: string | undefined;
let savedRequests: { request_id: string; slug: string; state: string }[] = [];
const resumeArgs = ['--no-pull', '--yes', '--no-embed', '--no-hard-deadline', '--json'];
const config = () => ({ engine: 'pglite' as const, database_path: dbDir });
const socket = () => persistenceSocketPathForConfig(config())!;

function childEnv(): Record<string, string> {
  return keylessBrainEnv(process.env, tmpParent, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_DIRECT_DATABASE_URL: undefined,
    GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: 'workspace', GBRAIN_SWEEP: '0',
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '300',
  });
}
async function read(stream: ReadableStream<Uint8Array>, append: (value: string) => void): Promise<void> {
  const decoder = new TextDecoder(), reader = stream.getReader();
  try { for (;;) { const { value, done } = await reader.read(); if (done) return; append(decoder.decode(value, { stream: true })); } }
  finally { reader.releaseLock(); }
}
async function runSyncChild(args: string[], timeoutMs = 180_000): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, 'src/cli.ts'), 'sync', ...args], {
    cwd: REPO_ROOT, env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  } finally { clearTimeout(timeout); }
}
function assertSuccess(result: { code: number; out: string; err: string }): void {
  if (result.code !== 0) throw new Error(`sync exited ${result.code}\nclient stderr:\n${result.err}\nstdout:\n${result.out}\nserve stderr:\n${serveStderr}`);
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    if (serveProc?.exitCode !== null && serveProc?.exitCode !== undefined) throw new Error(`serve exited while waiting for ${label}: ${serveStderr}`);
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}: ${serveStderr}`);
}
function gitCommitAll(message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', message], { cwd: repo });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}
function writeNotes(from: number, to: number): void {
  for (let i = from; i < to; i++) writeFileSync(join(repo, 'topics', `note-${String(i).padStart(4, '0')}.md`),
    `---\ntype: concept\ntitle: Note ${i} Example\n---\n\nBody for note ${i}.\n`);
}
async function administer(operation: PersistenceAdminOperation, params: Record<string, unknown>) {
  return requestPersistenceAdministration(socket(), { version: 1, kind: 'administration',
    brain_id: capabilities.brain_id, operation, params, registration: readPersistenceCliRegistration(capabilities.brain_id) });
}
async function operation(name: PersistenceIpcOperation, params: Record<string, unknown>): Promise<unknown> {
  return requestPersistenceOperation(socket(), { version: 1, kind: 'operation', brain_id: capabilities.brain_id,
    operation: name, params, registration: readPersistenceCliRegistration(capabilities.brain_id),
    routing: { source: 'workspace', cwd: repo } });
}

beforeAll(async () => {
  for (const key of ENV_KEYS) SAVED_ENV[key] = process.env[key];
  delete process.env.GBRAIN_DATABASE_URL; delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_HOOKS; delete process.env.GBRAIN_SYNC_NO_DELEGATE;
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-sds-'));
  claimBarrier = join(tmpParent, 'durable-sync-claim.json');
  mkdirSync(join(tmpParent, '.gbrain'));
  dbDir = join(tmpParent, 'db');
  process.env.GBRAIN_HOME = tmpParent;
  process.env.GBRAIN_SOURCE = 'workspace'; process.env.GBRAIN_BRAIN_ID = 'host';
  // Keep embedding enabled but remove every provider key: delegated imports
  // must bypass inline paid work and leave the existing owner drain pending.
  writeFileSync(join(tmpParent, '.gbrain/config.json'), JSON.stringify({ ...config(), embedding_dimensions: 1536 }));
  repo = mkdtempSync(join(tmpdir(), 'gb-sds-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'example@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Example'], { cwd: repo });
  mkdirSync(join(repo, 'topics'));
  writeNotes(0, 2); initialCommit = gitCommitAll('initial');
  const engine = await createEngine(config());
  try {
    await engine.connect(config()); await engine.initSchema();
    await addSource(engine, { id: 'workspace', localPath: repo, force: true });
  } finally { await engine.disconnect(); }
  // First exercise the unactivated compatibility route before opting into
  // managed ownership for the crash/recovery pins.
  serveProc = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(REPO_ROOT, 'test/fixtures/serve-sync-claim-barrier.ts'), join(REPO_ROOT, 'src/cli.ts'), 'serve'], {
    cwd: REPO_ROOT, env: { ...childEnv(), GBRAIN_TEST_SYNC_CLAIM_BARRIER: claimBarrier }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  serveReaders.push(read(serveProc.stdout as ReadableStream<Uint8Array>, () => {}),
    read(serveProc.stderr as ReadableStream<Uint8Array>, value => { serveStderr += value; }));
  await until(async () => {
    try { capabilities = await requestPersistenceCapabilities(socket(), 250); return true; } catch { return false; }
  }, 'authenticated persistence listener');
}, 240_000);

afterAll(async () => {
  if (serveProc?.exitCode === null) { serveProc.kill('SIGKILL'); await serveProc.exited; }
  await Promise.allSettled(serveReaders);
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key]; else process.env[key] = SAVED_ENV[key];
  }
  for (const dir of [tmpParent, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('serve-delegated sync (real serve + real sync subprocesses)', () => {
  test('Pin 1 — keyless unactivated sync delegates and defers paid embedding', async () => {
    const result = await runSyncChild(['--no-pull', '--yes', '--no-hard-deadline']);
    assertSuccess(result);
    expect(result.err).toContain('Delegating to the registered PGLite owner.');
    expect(result.err).toContain('embeds deferred');
    expect(await operation('get_page', { slug: 'topics/note-0000', source_id: 'workspace' }))
      .toMatchObject({ compiled_truth: expect.stringContaining('Body for note 0.') });
    expect(await operation('get_page', { slug: 'topics/note-0001', source_id: 'workspace' }))
      .toMatchObject({ compiled_truth: expect.stringContaining('Body for note 1.') });
    expect(serveStderr).not.toContain('requires VOYAGE_API_KEY');
    expect(inspectLockHolder(dbDir).pid).toBe(serveProc!.pid);
  }, 120_000);

  test('Pin 2 — runtime authority flags refuse by name without falling through', async () => {
    const result = await runSyncChild(['--force-break-lock', '--yes', '--no-hard-deadline']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Unsupported owner-delegated sync option: --force-break-lock.');
    expect(result.err).not.toContain('LockTimeout');
    expect(inspectLockHolder(dbDir).pid).toBe(serveProc!.pid);
  }, 60_000);

  test('Pin 3 — kill after a durable page receipt; acknowledgment is pending', async () => {
    const beforeClaim = await administer('writer_status', {}) as { admin_state: string };
    await administer('writer_claim', { source_id: 'workspace', path: repo, admin_intent: 'writer_claim', expected_state: beforeClaim.admin_state });
    const beforeActivation = await administer('writer_status', {}) as { admin_state: string };
    expect(await administer('writer_activate', { confirm_quiesced: true, admin_intent: 'writer_activate', expected_state: beforeActivation.admin_state })).toMatchObject({ enabled: true });
    writeNotes(2, 302); bulkCommit = gitCommitAll('bulk notes');
    let clientFinished = false;
    const client = runSyncChild(resumeArgs).finally(() => { clientFinished = true; });
    let observed: { request_id: string; state: string }[] = [];
    try {
      await until(async () => {
        if (clientFinished) {
          const result = await client;
          throw new Error(`sync stopped before a committed receipt: ${result.err}\n${result.out}\n${serveStderr}`);
        }
        if (!existsSync(claimBarrier)) return false;
        const result = await operation('list_write_requests', { source_id: 'workspace', limit: 25 }) as { requests: typeof observed };
        observed = result.requests;
        return observed.some(row => row.state === 'committed') && observed.some(row => row.state === 'running');
      }, 'committed and running sync page receipts');
    } finally { serveProc!.kill('SIGKILL'); await serveProc!.exited; }
    const result = await client;
    const paused = JSON.parse(readFileSync(claimBarrier, 'utf8')) as { requestId: string; runId: string };
    expect(observed.some(row => row.request_id === paused.requestId && row.state === 'running')).toBe(true);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Delegating to the registered PGLite owner.');
    expect(JSON.parse(result.out)).toMatchObject({ error: 'write_pending', suggestion: expect.stringContaining('same sync options') });
    expect(inspectLockHolder(dbDir).held).toBe(false);

    // Only open another engine after the actual owner has exited. No force
    // break, guessed timeout or PID-file deletion authorizes this handoff.
    const engine = await createEngine(config());
    try {
      await engine.connect(config());
      const [cursor] = await engine.executeRaw<{ value: { runId: string; index: number; done?: boolean; pending?: { requestId: string } } }>(
        "SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op='managed-sync'");
      expect(cursor.value.done).not.toBe(true);
      interruptedRun = cursor.value.runId;
      expect(interruptedRun).toBe(paused.runId);
      savedRequests = await engine.executeRaw("SELECT request_id,slug,state FROM persistence_requests WHERE intent->>'runId'=$1", [interruptedRun]);
      expect(savedRequests.length).toBeGreaterThan(0);
      expect(savedRequests.length).toBeLessThan(301);
      for (const receipt of observed) expect(savedRequests.some(row => row.request_id === receipt.request_id)).toBe(true);
      // The next ID may have been flushed just before its admission. Resume
      // must use that frozen ID too, whether or not its receipt exists yet.
      pendingRequestId = cursor.value.pending?.requestId;
      expect(pendingRequestId).toBe(paused.requestId);
      const [source] = await engine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='workspace'");
      expect(source.last_commit).toBe(initialCommit);
    } finally { await engine.disconnect(); }
  }, 200_000);

  test('Pin 4 — direct sync resumes the same run and IDs without a manual lock break', async () => {
    let result = await runSyncChild(resumeArgs, 240_000);
    if (result.code !== 0) {
      expect(result.code).toBe(1);
      if (!pendingRequestId) throw new Error('Pending recovery has no saved request ID.');
      const partial = JSON.parse(result.out);
      expect(partial).toMatchObject({ schema_version: 1, source_id: 'workspace', sync_status: 'partial',
        reason: 'writer_pending', run_id: interruptedRun });
      expect(partial.managed_write.write_request.request_id).toBe(pendingRequestId);
      const pendingEngine = await createEngine(config());
      let retryAfterMs: number;
      try {
        await pendingEngine.connect(config());
        const [request] = await pendingEngine.executeRaw<{ request_id: string; state: string; retry_after_ms: number | null }>(
          `SELECT request_id,state,GREATEST(0,extract(epoch FROM claim_expires_at-clock_timestamp())*1000)::float8 AS retry_after_ms
            FROM persistence_requests WHERE request_id=$1::uuid`, [pendingRequestId]);
        expect(request.request_id).toBe(pendingRequestId);
        expect(['queued', 'running']).toContain(request.state);
        retryAfterMs = Number(request.retry_after_ms ?? 0);
        expect(Number.isFinite(retryAfterMs)).toBe(true);
        expect(retryAfterMs).toBeGreaterThanOrEqual(0);
        expect(retryAfterMs).toBeLessThanOrEqual(30_000);
        const [source] = await pendingEngine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='workspace'");
        expect(source.last_commit).toBe(initialCommit);
      } finally { await pendingEngine.disconnect(); }
      await Bun.sleep(Math.ceil(retryAfterMs) + 1);
      result = await runSyncChild(resumeArgs, 240_000);
    }
    assertSuccess(result);
    expect(result.err).not.toContain('Delegating');
    expect(JSON.parse(result.out)).toMatchObject({ schema_version: 1, source_id: 'workspace', sync_status: 'synced', added: 300, embedded: 0 });
    const engine = await createEngine(config());
    try {
      await engine.connect(config());
      const [source] = await engine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='workspace'");
      expect(source.last_commit).toBe(bulkCommit);
      const [pages] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id='workspace' AND deleted_at IS NULL");
      expect(pages.n).toBe(302);
      const requests = await engine.executeRaw<{ request_id: string; slug: string; state: string }>(
        "SELECT request_id,slug,state FROM persistence_requests WHERE intent->>'runId'=$1", [interruptedRun]);
      expect(requests.length).toBe(301); // 300 pages and the final source checkpoint.
      expect(new Set(requests.map(row => row.slug)).size).toBe(301);
      expect(requests.every(row => row.state === 'committed')).toBe(true);
      for (const original of savedRequests) expect(requests.find(row => row.request_id === original.request_id))
        .toMatchObject({ slug: original.slug, state: 'committed' });
      if (pendingRequestId) expect(requests.find(row => row.request_id === pendingRequestId)?.state).toBe('committed');
      const [cursor] = await engine.executeRaw<{ value: { runId: string; done: boolean; index: number } }>(
        "SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op='managed-sync'");
      expect(cursor.value).toMatchObject({ runId: interruptedRun, done: true, index: 300 });
    } finally { await engine.disconnect(); }
  }, 270_000);
});
