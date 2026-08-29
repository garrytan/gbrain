/**
 * Serve-delegated sync — end-to-end pins (the whole arc, real processes).
 *
 * A REAL `gbrain serve` subprocess owns a temp PGLite brain's single-writer
 * lock while REAL `gbrain sync` subprocesses run against the same brain:
 *
 *   Pin 1 — delegation happy path: `gbrain sync --no-pull --yes` under the
 *           live serve exits 0 via the delegation banner, and the job's
 *           sync_status (queried over the real socket with the on-disk
 *           secret) reports done with the seeded pages imported.
 *   Pin 2 — default-deny refusal: `gbrain sync --repo <dir>` under the live
 *           serve exits 1 with the named-flag remediation, no stack trace.
 *   Pin 3 — chaos: SIGKILL the serve mid-delegated-sync → the client exits 1
 *           with the checkpoint-resume hint (and the 60s lock-grace note).
 *   Pin 4 — resume: `sync --force-break-lock` clears the dead holder's row,
 *           then a DIRECT `gbrain sync` (dead PGLite lock reaped by
 *           acquireLock — the ladder's rung-2 regression) completes from the
 *           checkpoint and the pages are really in the brain.
 *
 * Serial + e2e: spawns subprocesses, cold PGLite init, one brain shared
 * across ordered pins. The serve child is SIGKILLed in afterAll no matter
 * what. PGLite-only — this file must run WITHOUT DATABASE_URL (the env strip
 * below also guards against a CI-injected one).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ipcSecretPath, readIpcSecret, requestSyncStatus, resolveSocketPath } from '../../src/core/context/resolve-ipc.ts';
import type { SyncStatusResponse } from '../../src/core/context/sync-ipc.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_SWEEP', 'GBRAIN_SYNC_NO_DELEGATE',
];

// Short prefix — the IPC unix socket lives under database_path and socket
// paths cap out around 104 bytes on macOS.
let tmpParent: string;
let home: string;
let dbDir: string;
let repo: string;
let serveProc: ReturnType<typeof Bun.spawn> | null = null;
const serveStderr: string[] = [];

function childEnv(): Record<string, string> {
  return {
    ...process.env,
    GBRAIN_HOME: tmpParent,
    HOME: tmpParent,
    GBRAIN_SOURCE: 'workspace',
    GBRAIN_SWEEP: '0',
  } as Record<string, string>;
}

async function runSyncChild(
  args: string[],
  opts: { onStderrLine?: (line: string, kill: () => void) => void; timeoutMs?: number } = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', 'run', join(REPO_ROOT, 'src', 'cli.ts'), 'sync', ...args], {
    cwd: REPO_ROOT,
    env: childEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const decoder = new TextDecoder();
  let out = '';
  let err = '';
  const kill = () => { try { serveProc?.kill('SIGKILL'); } catch { /* dead */ } };
  const outDone = (async () => {
    const r = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) { const { value, done } = await r.read(); if (done) break; out += decoder.decode(value, { stream: true }); }
  })();
  const errDone = (async () => {
    const r = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      err += chunk;
      if (opts.onStderrLine) for (const line of chunk.split('\n')) opts.onStderrLine(line, kill);
    }
  })();
  const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* dead */ } }, opts.timeoutMs ?? 120_000);
  const code = await proc.exited;
  clearTimeout(timeout);
  await Promise.all([outDone, errDone]);
  return { code, out, err };
}

function gitCommitAll(msg: string): void {
  execSync(`git add -A && git commit -m "${msg}"`, { cwd: repo, stdio: 'pipe', shell: '/bin/bash' as never });
}

function writeNotes(from: number, to: number): void {
  for (let i = from; i < to; i++) {
    writeFileSync(
      join(repo, 'topics', `note-${String(i).padStart(4, '0')}.md`),
      `---\ntype: concept\ntitle: Note ${i} Example\n---\n\nBody for note ${i}.\n`,
    );
  }
}

async function pollFor(pred: () => boolean, deadlineMs: number, label: string): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    if (serveProc && serveProc.exitCode !== null) {
      throw new Error(`serve exited early (code ${serveProc.exitCode}) while waiting for ${label}\nstderr:\n${serveStderr.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}\nserve stderr:\n${serveStderr.join('')}`);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // A dev/CI DATABASE_URL must not flip the sandboxed brain to Postgres.
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_BRAIN_ID;
  delete process.env.GBRAIN_HOOKS;
  delete process.env.GBRAIN_SYNC_NO_DELEGATE;

  tmpParent = mkdtempSync(join(tmpdir(), 'gb-sds-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  dbDir = join(tmpParent, 'db');
  process.env.GBRAIN_HOME = tmpParent;
  process.env.GBRAIN_SOURCE = 'workspace';

  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbDir, embedding_dimensions: 1536 }, null, 2),
  );

  // Real git repo the source syncs from.
  repo = mkdtempSync(join(tmpdir(), 'gb-sds-repo-'));
  execSync('git init && git config user.email t@t.co && git config user.name T', {
    cwd: repo, stdio: 'pipe', shell: '/bin/bash' as never,
  });
  mkdirSync(join(repo, 'topics'), { recursive: true });
  writeNotes(0, 2);
  gitCommitAll('initial');

  // Pre-init the brain in-process (schema + source) so the serve boots fast.
  const engineConfig = { engine: 'pglite' as const, database_path: dbDir };
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  await engine.initSchema();
  await addSource(engine, { id: 'workspace', localPath: repo, force: true });
  await engine.disconnect();

  serveProc = Bun.spawn(['bun', 'run', join(REPO_ROOT, 'src', 'cli.ts'), 'serve'], {
    cwd: REPO_ROOT,
    env: {
      ...childEnv(),
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
      GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '300',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void (async () => {
    const reader = (serveProc!.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; serveStderr.push(decoder.decode(value, { stream: true })); }
    } catch { /* child gone */ }
  })();

  await pollFor(
    () => existsSync(resolveSocketPath(dbDir)) && existsSync(ipcSecretPath(dbDir)),
    120_000,
    'IPC socket + secret',
  );
}, 240_000);

afterAll(async () => {
  if (serveProc && serveProc.exitCode === null) {
    try { serveProc.kill('SIGKILL'); await serveProc.exited; } catch { /* dead */ }
  }
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  for (const dir of [tmpParent, repo]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('serve-delegated sync (real serve + real sync subprocesses)', () => {
  test('Pin 1 — sync under a live serve delegates and completes', async () => {
    const r = await runSyncChild(['--no-pull', '--yes']);
    expect(r.err).toContain('delegating the sync through it (job ');
    expect(r.code).toBe(0);

    // The job's result is queryable over the real socket with the real secret.
    const jobId = /\(job ([0-9a-f-]+)/.exec(r.err)?.[1];
    expect(jobId).toBeTruthy();
    const secret = readIpcSecret(dbDir)!;
    const s = await requestSyncStatus(resolveSocketPath(dbDir), { secret, jobId: jobId! });
    const status = s as SyncStatusResponse;
    expect(status.ok).toBe(true);
    expect(status.state).toBe('done');
    expect(status.result!.added).toBe(2);
    // Embeds are deferred, never claimed.
    expect(status.result!.embedded).toBe(0);
    expect(r.err).toContain('embeds deferred');
    // Serve survived the whole thing.
    expect(serveProc!.exitCode).toBeNull();
  }, 120_000);

  test('Pin 2 — unsupported flag refuses by name with remediation, exit 1, no stack', async () => {
    const r = await runSyncChild(['--repo', repo]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('`--repo` isn\'t supported through serve-delegated sync');
    expect(r.err).toContain('--no-delegate');
    expect(r.err).not.toContain('LiveServeLockError');
    expect(serveProc!.exitCode).toBeNull();
  }, 60_000);

  test('Pin 3 — SIGKILL the serve mid-delegated-sync → resume hint, exit 1', async () => {
    // Enough new files that the job is still importing when the kill lands.
    writeNotes(2, 302);
    gitCommitAll('bulk notes');
    let killed = false;
    const r = await runSyncChild(['--no-pull', '--yes'], {
      timeoutMs: 180_000,
      onStderrLine: (line, kill) => {
        if (!killed && line.includes('delegating the sync through it')) {
          killed = true;
          kill();
        }
      },
    });
    expect(killed).toBe(true);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/died mid-sync|stopped answering|restarted mid-sync/);
    expect(r.err).toContain('progress is checkpointed');
    expect(r.err).toContain('--break-lock');
  }, 200_000);

  test('Pin 4 — dead serve: row lock force-broken, DIRECT sync resumes from checkpoint', async () => {
    // The dead serve's PGLite data-dir lock is reaped by acquireLock (dead
    // PID), so the delegation ladder returns false and sync runs directly —
    // the rung-2 regression pin. The gbrain-sync ROW lock is dead-held for
    // the 60s takeover grace, so break it explicitly first.
    const br = await runSyncChild(['--force-break-lock', '--yes'], { timeoutMs: 120_000 });
    if (br.code !== 0) {
      throw new Error(`--force-break-lock exited ${br.code}\nstderr:\n${br.err}\nstdout:\n${br.out}`);
    }

    // #4492: settle between the break-lock child and the direct run. CI run
    // 32556210838 flaked here — the direct sync exited 1 and the bare
    // `expect(r.code).toBe(0)` dropped the stderr that would have pinned the
    // race (residual PGLite data-dir lock release vs the next spawn, or a
    // not-yet-cleared gbrain-sync row). Open the brain in-process (connect
    // reaps dead data-dir lock holders) and poll the sync row-lock free,
    // then release BEFORE spawning the direct child.
    const engineConfig = { engine: 'pglite' as const, database_path: dbDir };
    {
      const settleDeadline = Date.now() + 60_000;
      let settleEngine = null as Awaited<ReturnType<typeof createEngine>> | null;
      for (;;) {
        try {
          settleEngine = await createEngine(engineConfig);
          await settleEngine.connect(engineConfig);
          break;
        } catch (e) {
          settleEngine = null;
          if (Date.now() > settleDeadline) {
            throw new Error(`settle: brain not openable after force-break: ${(e as Error).message}`);
          }
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      try {
        for (;;) {
          const held = await settleEngine!.executeRaw<{ n: number }>(
            `SELECT count(*)::int AS n FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-sync:%'`,
          );
          if (held[0]!.n === 0) break;
          if (Date.now() > settleDeadline) {
            throw new Error(`settle: gbrain-sync lock row still held after force-break (${held[0]!.n} row(s))`);
          }
          await new Promise((res) => setTimeout(res, 500));
        }
      } finally {
        await settleEngine!.disconnect();
      }
    }

    // Retry-once: a first direct attempt can still lose a residual startup
    // race with the just-released data-dir lock; a second attempt (with the
    // first failure's stderr surfaced) separates a flaky settle from a real
    // regression.
    let r = await runSyncChild(['--no-pull', '--yes', '--no-embed'], { timeoutMs: 180_000 });
    if (r.code !== 0) {
      process.stderr.write(
        `[pin4] first direct sync attempt exited ${r.code}; retrying once.\n` +
        `[pin4] first-attempt stderr:\n${r.err}\n`,
      );
      r = await runSyncChild(['--no-pull', '--yes', '--no-embed'], { timeoutMs: 180_000 });
    }
    expect(r.err).not.toContain('delegating the sync');
    if (r.code !== 0) {
      throw new Error(`direct sync exited ${r.code}\nstderr:\n${r.err}\nstdout:\n${r.out}`);
    }

    // The pages are really in the brain (direct engine open works now).
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = 'workspace' AND deleted_at IS NULL`,
    );
    await engine.disconnect();
    expect(rows[0].n).toBeGreaterThanOrEqual(302);
  }, 240_000);
});
