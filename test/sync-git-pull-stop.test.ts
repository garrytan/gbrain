/**
 * Stopping a sync must stop its `git pull` (#6101).
 *
 * Protects: while `git pull` waits on a remote that never replies, the
 * process keeps running its event loop, and each stop route (the sync signal,
 * the process cleanup pass, a signal-owned worker shutdown) ends the pull
 * promptly with partial `pull_timeout` and the sync anchor untouched.
 * Regression it catches: a synchronous pull (execFileSync) freezes timers and
 * signal handling for the pull's whole 300s deadline, so none of the routes
 * fire; dropping the cleanup-pass registration or the signal threading
 * silences one route. Negative controls: a remote that refuses at once is an
 * ordinary pull failure (the existing `pull_failed` result, never
 * `pull_timeout`), and an error without a stop marker is not read as stopped.
 *
 * The remote is `ssh://fixture.invalid/...` with `core.sshCommand` pointing at
 * a local script (`ssh.variant=simple`, so git sends no `-G` probe). The
 * "silent" script records its pid and sleeps far longer than any bound below;
 * the "refusing" script prints a fatal line and exits 128.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import * as gitRemote from '../src/core/git-remote.ts';
import {
  _registeredCleanupCountForTests,
  _resetForTests as resetCleanupRegistry,
  installSignalHandlers,
  registerSignalOwner,
  triggerCleanupAndExit,
} from '../src/core/process-cleanup.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// Longer than PROMPT_STOP_MS, so a pull nobody stopped cannot pass; short
// enough that a blocking pull only stalls the run for this long.
const SILENT_REMOTE_SECONDS = 25;
const PROMPT_STOP_MS = 12_000;

const workdir = mkdtempSync(join(tmpdir(), 'gbrain-pull-stop-'));
const brain = join(workdir, 'brain');
const silentPidFile = join(workdir, 'silent-remote.pid');
const silentRemote = join(workdir, 'silent-remote.sh');
const refusingRemote = join(workdir, 'refusing-remote.sh');
const syncOpts = { repoPath: brain, sourceId: 'default', noEmbed: true, noExtract: true } as const;

let engine: PGLiteEngine;
let schemaVersion: string | null;

function gitIn(args: string[]): string {
  return execFileSync('git', ['-C', brain, ...args], { encoding: 'utf8' }).trim();
}

function useRemote(script: string): void {
  gitIn(['config', 'core.sshCommand', script]);
}

async function untilRemoteAnswersCall(): Promise<void> {
  const giveUp = Date.now() + 30_000;
  while (!existsSync(silentPidFile)) {
    if (Date.now() > giveUp) throw new Error('git pull never dialled the silent remote');
    await Bun.sleep(20);
  }
}

async function syncAnchor(): Promise<string | null> {
  const rows = await engine.executeRaw<{ last_commit: string | null }>(`SELECT last_commit FROM sources WHERE id = 'default'`);
  return rows[0]?.last_commit ?? null;
}

function captureExit(): { codes: Array<number | undefined>; restore: () => void } {
  const codes: Array<number | undefined> = [];
  const real = process.exit;
  process.exit = ((code?: number) => { codes.push(code); }) as typeof process.exit;
  return { codes, restore: () => { process.exit = real; } };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = await engine.getConfig('version');

  mkdirSync(join(brain, 'notes'), { recursive: true });
  const repo = await makeGitFixture(brain);
  writeFileSync(join(brain, 'notes', 'pull-stop.md'), '---\ntitle: Pull stop fixture\n---\n\nA note for the pull-stop tests.\n');
  repo.commitAll('seed note');
  const branch = gitIn(['rev-parse', '--abbrev-ref', 'HEAD']);
  gitIn(['remote', 'add', 'origin', 'ssh://fixture.invalid/brain.git']);
  gitIn(['config', `branch.${branch}.remote`, 'origin']);
  gitIn(['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
  gitIn(['config', 'ssh.variant', 'simple']);

  writeFileSync(silentRemote, `#!/bin/sh\necho $$ > '${silentPidFile}'\nexec sleep ${SILENT_REMOTE_SECONDS}\n`);
  writeFileSync(refusingRemote, `#!/bin/sh\necho 'fatal: fixture remote refused the connection' >&2\nexit 128\n`);
  chmodSync(silentRemote, 0o755);
  chmodSync(refusingRemote, 0o755);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  rmSync(silentPidFile, { force: true });
  useRemote(silentRemote);
});

afterEach(() => {
  resetCleanupRegistry();
  if (!existsSync(silentPidFile)) return;
  const pid = Number(readFileSync(silentPidFile, 'utf8').trim());
  try { process.kill(pid, 'SIGKILL'); } catch { /* the transport already exited */ }
});

describe('pullRepo against a silent remote', () => {
  test('the event loop keeps ticking while git waits on the remote', async () => {
    const controller = new AbortController();
    const settled = gitRemote.pullRepo(brain, { signal: controller.signal }).catch(() => undefined);
    await untilRemoteAnswersCall();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    await Bun.sleep(300);
    clearInterval(timer);
    controller.abort();
    await settled;
    expect(ticks).toBeGreaterThanOrEqual(10);
  }, 60_000);

  test('an abort stops the pull and the rejection reads as stopped', async () => {
    const controller = new AbortController();
    const outcome = gitRemote.pullRepo(brain, { signal: controller.signal }).then(() => 'resolved', (e: unknown) => e);
    await untilRemoteAnswersCall();
    const abortedAt = performance.now();
    controller.abort();
    const err = await outcome;
    expect(performance.now() - abortedAt).toBeLessThan(PROMPT_STOP_MS);
    expect(err).toBeInstanceOf(gitRemote.GitOperationError);
    expect((err as gitRemote.GitOperationError).op).toBe('pull');
    expect(gitRemote.isStoppedGitPull(err)).toBe(true);
  }, 60_000);

  test('the timeoutMs deadline stops the pull and reads as stopped', async () => {
    const started = performance.now();
    const err = await gitRemote.pullRepo(brain, { timeoutMs: 1_500 }).then(() => 'resolved', (e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(PROMPT_STOP_MS);
    expect(err).toBeInstanceOf(gitRemote.GitOperationError);
    expect(gitRemote.isStoppedGitPull(err)).toBe(true);
  }, 60_000);

  test('negative control: a refusing remote is a real failure, reported stderr-first', async () => {
    useRemote(refusingRemote);
    const err = await gitRemote.pullRepo(brain).then(() => 'resolved', (e: unknown) => e);
    expect(err).toBeInstanceOf(gitRemote.GitOperationError);
    expect(gitRemote.isStoppedGitPull(err)).toBe(false);
    expect((err as Error).message).toStartWith(`git pull failed in ${brain}: fatal: fixture remote refused the connection`);
  }, 60_000);
});

describe('isStoppedGitPull', () => {
  test('recognizes only the stop markers on the cause', () => {
    const wrap = (cause: unknown) => new gitRemote.GitOperationError('pull', 'git pull failed', cause);
    expect(gitRemote.isStoppedGitPull(wrap({ code: 'ETIMEDOUT' }))).toBe(true);
    expect(gitRemote.isStoppedGitPull(wrap({ code: 'ABORT_ERR' }))).toBe(true);
    expect(gitRemote.isStoppedGitPull(wrap({ signal: 'SIGTERM' }))).toBe(true);
    expect(gitRemote.isStoppedGitPull(wrap({ code: 1, signal: null }))).toBe(false);
    expect(gitRemote.isStoppedGitPull(wrap(undefined))).toBe(false);
    expect(gitRemote.isStoppedGitPull(new Error('git pull failed'))).toBe(false);
    expect(gitRemote.isStoppedGitPull('ABORT_ERR')).toBe(false);
  });
});

describe('performSync stop routes during the pull', () => {
  test('aborting the sync signal returns partial pull_timeout and keeps the anchor', async () => {
    await performSync(engine, { ...syncOpts, noPull: true });
    const anchorBefore = await syncAnchor();
    expect(anchorBefore).toBe(gitIn(['rev-parse', 'HEAD']));

    const controller = new AbortController();
    const running = performSync(engine, { ...syncOpts, signal: controller.signal });
    await untilRemoteAnswersCall();
    const abortedAt = performance.now();
    controller.abort();
    const result = await running;

    expect(performance.now() - abortedAt).toBeLessThan(PROMPT_STOP_MS);
    expect(result.status).toBe('partial');
    expect(result.reason).toBe('pull_timeout');
    expect(await syncAnchor()).toBe(anchorBefore);
  }, 60_000);

  test('the process cleanup pass stops the pull, and a finished pull leaves no cleanup entry behind', async () => {
    await performSync(engine, { ...syncOpts, noPull: true });
    const entriesBefore = _registeredCleanupCountForTests();

    const running = performSync(engine, syncOpts);
    await untilRemoteAnswersCall();
    const exit = captureExit();
    const cleanupAt = performance.now();
    try {
      await triggerCleanupAndExit(129);
    } finally {
      exit.restore();
    }
    const result = await running;

    expect(exit.codes).toEqual([129]);
    expect(performance.now() - cleanupAt).toBeLessThan(PROMPT_STOP_MS);
    expect(result.status).toBe('partial');
    expect(result.reason).toBe('pull_timeout');
    expect(_registeredCleanupCountForTests()).toBe(entriesBefore);
  }, 60_000);

  test('negative control: a refusing remote is the ordinary pull_failed path, not pull_timeout', async () => {
    await performSync(engine, { ...syncOpts, noPull: true });
    useRemote(refusingRemote);
    const entriesBefore = _registeredCleanupCountForTests();

    const result = await performSync(engine, syncOpts);

    expect(result.reason).toBe('pull_failed');
    expect(_registeredCleanupCountForTests()).toBe(entriesBefore);
  }, 60_000);

  test('a signal-owned worker shutdown hands the sync job back without an attempt and frees the sync lock', async () => {
    await performSync(engine, { ...syncOpts, noPull: true });
    const anchorBefore = await syncAnchor();
    // The worker refuses to claim without a schema version; resetPgliteState clears config.
    await engine.setConfig('version', schemaVersion!);
    const queue = new MinionQueue(engine);
    const job = await queue.add('sync', { repoPath: brain, sourceId: 'default', pull: true, auto_embed_backfill: false });
    const worker = new MinionWorker(engine, { pollInterval: 20, healthCheckInterval: 0, stalledInterval: 600_000 });
    worker.register('sync', makeSyncHandler(engine));
    // `gbrain jobs work` owns SIGTERM, so the cleanup pass never runs and only
    // the worker's shutdown signal can reach the pull.
    const dropOwner = registerSignalOwner('pull-stop-worker', () => worker.requestShutdown());
    const workerDone = worker.start();
    let drainMs = Number.POSITIVE_INFINITY;
    try {
      await untilRemoteAnswersCall();
      installSignalHandlers();
      const signalledAt = performance.now();
      process.emit('SIGTERM');
      await workerDone;
      drainMs = performance.now() - signalledAt;
    } finally {
      dropOwner();
    }

    expect(drainMs).toBeLessThan(PROMPT_STOP_MS);
    const [row] = await engine.executeRaw<{ status: string; attempts_made: number }>(
      'SELECT status, attempts_made FROM minion_jobs WHERE id = $1', [job.id],
    );
    expect(row).toEqual({ status: 'waiting', attempts_made: 0 });
    expect(await syncAnchor()).toBe(anchorBefore);
    expect((await performSync(engine, { ...syncOpts, noPull: true })).status).toBe('up_to_date');
  }, 60_000);
});
