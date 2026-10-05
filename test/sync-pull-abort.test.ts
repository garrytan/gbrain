/**
 * A sync whose `git pull` reaches a remote that never answers must stop when
 * the sync is told to stop, and report partial `pull_timeout` with the anchor
 * unchanged. Two stop routes reach the pull: the sync signal (the operator's
 * --timeout, SIGINT, a job's timeout or cancel, lock loss) and the
 * SIGTERM/SIGHUP cleanup pass (the --timeout hard-deadline watchdog, a service
 * stop). The pull used to run synchronously under a fixed 300s timeout, so
 * neither could interrupt it and the event loop stalled for the whole wait.
 *
 * The stalled remote is an ssh:// origin whose transport (GIT_SSH_COMMAND) is
 * a script that accepts the connection and never answers. It records its pid
 * so each case can unwind the `git fetch` that `git pull` leaves behind.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { _resetForTests as resetProcessCleanup, triggerCleanupAndExit } from '../src/core/process-cleanup.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-sync-pull-abort-'));
const repo = join(root, 'brain');
const stalledPids = join(root, 'stalled.pids');
const stalledTransport = join(root, 'stalled-ssh');
// Longer than the 15s bound below, so a pull that is not stopped cannot pass.
const STALL_SECONDS = 30;
const SYNC_OPTS = { repoPath: repo, sourceId: 'default', noEmbed: true, noExtract: true } as const;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  mkdirSync(join(repo, 'people'), { recursive: true });
  const fixture = await makeGitFixture(repo);
  writeFileSync(join(repo, 'people', 'alice-example.md'), '---\ntype: person\ntitle: Alice Example\n---\n\nAlice is a person.\n');
  fixture.commitAll('add a page');
  const branch = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'ssh://stalled.invalid/brain.git']);
  execFileSync('git', ['-C', repo, 'config', `branch.${branch}.remote`, 'origin']);
  execFileSync('git', ['-C', repo, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`]);

  // `-G` is git's OpenSSH-variant probe; answer it the way OpenSSH does.
  writeFileSync(stalledTransport, `#!/bin/sh\n[ "$1" = "-G" ] && exit 0\necho $$ >> '${stalledPids}'\nexec sleep ${STALL_SECONDS}\n`);
  chmodSync(stalledTransport, 0o755);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  rmSync(stalledPids, { force: true });
});

afterEach(() => {
  if (!existsSync(stalledPids)) return;
  for (const pid of readFileSync(stalledPids, 'utf8').split('\n').filter(Boolean)) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already exited */ }
  }
});

async function anchor(): Promise<string | null> {
  const [row] = await engine.executeRaw<{ last_commit: string | null }>(`SELECT last_commit FROM sources WHERE id = 'default'`);
  return row?.last_commit ?? null;
}

/** Resolves once the pull has connected to the stalled remote. */
async function pullReachedRemote(): Promise<void> {
  const deadline = Date.now() + STALL_SECONDS * 1000;
  while (!existsSync(stalledPids)) {
    if (Date.now() > deadline) throw new Error('git pull never reached the stalled remote');
    await Bun.sleep(25);
  }
}

describe('sync stops a git pull whose remote never answers', () => {
  test('aborting the sync signal stops the pull: partial pull_timeout, anchor unchanged', async () => {
    await withEnv({ GIT_SSH_COMMAND: stalledTransport }, async () => {
      await performSync(engine, { ...SYNC_OPTS, noPull: true });
      const before = await anchor();
      expect(before).not.toBeNull();

      const controller = new AbortController();
      const started = performance.now();
      const sync = performSync(engine, { ...SYNC_OPTS, signal: controller.signal });
      await pullReachedRemote();
      controller.abort();
      const result = await sync;

      expect(result.status).toBe('partial');
      expect(result.reason).toBe('pull_timeout');
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(await anchor()).toBe(before);
    });
  }, 60_000);

  test('the SIGTERM/SIGHUP cleanup pass stops the pull before the process exits', async () => {
    await withEnv({ GIT_SSH_COMMAND: stalledTransport }, async () => {
      await performSync(engine, { ...SYNC_OPTS, noPull: true });

      const started = performance.now();
      const sync = performSync(engine, SYNC_OPTS);
      await pullReachedRemote();
      const exit = process.exit;
      const exitCodes: Array<number | undefined> = [];
      process.exit = ((code?: number) => { exitCodes.push(code); }) as typeof process.exit;
      try {
        await triggerCleanupAndExit(143);
      } finally {
        process.exit = exit;
        resetProcessCleanup();
      }
      const result = await sync;

      expect(exitCodes).toEqual([143]);
      expect(result.status).toBe('partial');
      expect(result.reason).toBe('pull_timeout');
      expect(performance.now() - started).toBeLessThan(15_000);
    });
  }, 60_000);
});
