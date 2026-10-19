/**
 * #5062 (fix wave 9) — the shell handler terminates the job's whole process
 * tree, with real processes.
 *
 * Pre-fix the handler signalled only its direct child and gated the SIGKILL
 * escalation on `proc.killed`, which flips true as soon as SIGTERM is SENT:
 * a child that ignored SIGTERM was never killed (the job hung until its
 * leader exited), and a grandchild outlived the job, orphaned to PID 1.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { shellHandler } from '../src/core/minions/handlers/shell.ts';
import { withEnv } from './helpers/with-env.ts';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function makeCtx(data: Record<string, unknown>, signal: AbortSignal): MinionJobContext {
  return {
    id: 1,
    name: 'shell',
    data,
    attempts_made: 0,
    signal,
    deadlineAtMs: null,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// `echo $$ > f` creates f before it writes the pid, so an existing file can still be empty. An empty read is pid 0,
// which alive() reports live (kill(0, 0) signals the process group) and the cleanup's SIGKILL would send to this
// test's own process group. Wait for every file to hold a pid.
async function waitForPids(paths: string[], ms = 10_000): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const pids = paths.map(path => existsSync(path) ? Number(readFileSync(path, 'utf8').trim()) : NaN);
    if (pids.every(n => Number.isInteger(n) && n > 0)) return pids;
    if (Date.now() > deadline) throw new Error(`timed out waiting for a pid in ${paths.join(', ')}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

const pid = (path: string) => {
  const n = Number(readFileSync(path, 'utf8').trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${path} holds no pid`);
  return n;
};
const dirs: string[] = [];
const leftovers: number[] = [];
afterEach(() => {
  for (const p of leftovers.splice(0)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'shell-tree-'));
  dirs.push(d);
  return d;
}

describePosix('#5062 shell handler process tree', () => {
  test('a pid file that exists before its pid is written is waited for, never read as pid 0', async () => {
    const d = scratch();
    const path = join(d, 'late.pid');
    writeFileSync(path, '');
    setTimeout(() => writeFileSync(path, `${process.pid}\n`), 200);
    expect(await waitForPids([path])).toEqual([process.pid]);
  });

  test('abort kills a leader and grandchild that both ignore SIGTERM (escalates by liveness)', async () => {
    const d = scratch();
    const cmd = [
      `sh -c 'trap "" TERM; echo $$ > ${d}/grandchild.pid; exec sleep 20' &`,
      `echo $$ > ${d}/leader.pid`,
      'trap "" TERM',
      'sleep 21',
    ].join('\n');
    await withEnv({ GBRAIN_ALLOW_SHELL_JOBS: '1' }, async () => {
      const ac = new AbortController();
      const run = shellHandler(makeCtx({ cmd, cwd: d }, ac.signal));
      const tree = await waitForPids([`${d}/leader.pid`, `${d}/grandchild.pid`]);
      leftovers.push(...tree);
      ac.abort(new Error('cancel'));
      await expect(run).rejects.toThrow(/aborted/);
      expect(tree.filter(alive)).toEqual([]);
    });
  }, 15_000);

  test('abort kills a grandchild that ignores SIGTERM even when the leader dies at once', async () => {
    const d = scratch();
    const cmd = [
      `sh -c 'trap "" TERM; echo $$ > ${d}/grandchild.pid; exec sleep 20' &`,
      `echo $$ > ${d}/leader.pid`,
      'sleep 21',
    ].join('\n');
    await withEnv({ GBRAIN_ALLOW_SHELL_JOBS: '1' }, async () => {
      const ac = new AbortController();
      const run = shellHandler(makeCtx({ cmd, cwd: d }, ac.signal));
      const [, grandchild] = await waitForPids([`${d}/leader.pid`, `${d}/grandchild.pid`]);
      leftovers.push(grandchild);
      ac.abort(new Error('cancel'));
      await expect(run).rejects.toThrow(/aborted/);
      expect(alive(grandchild)).toBe(false);
    });
  }, 15_000);

  test('a leader that exits before its descendant: the job settles only after the descendant is gone', async () => {
    const d = scratch();
    const cmd = `sleep 20 &\necho $! > ${d}/bg.pid\necho done`;
    await withEnv({ GBRAIN_ALLOW_SHELL_JOBS: '1' }, async () => {
      const result = await shellHandler(makeCtx({ cmd, cwd: d }, new AbortController().signal)) as { exit_code: number; stdout_tail: string };
      const bg = pid(`${d}/bg.pid`);
      leftovers.push(bg);
      expect(result.exit_code).toBe(0);
      expect(result.stdout_tail).toBe('done\n');
      expect(alive(bg)).toBe(false);
    });
  }, 15_000);

  test('output that reaches the pipe after the leader exits is still in stdout_tail', async () => {
    if (!Bun.which('setsid')) return;
    const d = scratch();
    // The writer leaves the job's process group first (so the reap cannot take it), then writes after the leader exits.
    const cmd = `setsid sh -c 'touch ${d}/left; sleep 0.3; echo late' &\nwhile [ ! -f ${d}/left ]; do sleep 0.01; done\necho early`;
    await withEnv({ GBRAIN_ALLOW_SHELL_JOBS: '1' }, async () => {
      const result = await shellHandler(makeCtx({ cmd, cwd: d }, new AbortController().signal)) as { exit_code: number; stdout_tail: string };
      expect(result.exit_code).toBe(0);
      expect(result.stdout_tail).toBe('early\nlate\n');
    });
  }, 15_000);
});
