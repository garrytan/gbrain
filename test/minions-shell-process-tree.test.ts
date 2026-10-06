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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function waitForFiles(paths: string[], ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!paths.every(existsSync)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${paths.join(', ')}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

const pid = (path: string) => Number(readFileSync(path, 'utf8').trim());
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
      await waitForFiles([`${d}/leader.pid`, `${d}/grandchild.pid`]);
      const tree = [pid(`${d}/leader.pid`), pid(`${d}/grandchild.pid`)];
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
      await waitForFiles([`${d}/leader.pid`, `${d}/grandchild.pid`]);
      const grandchild = pid(`${d}/grandchild.pid`);
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
});
