import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileBounded, isDurabilityHardenedAsync } from '../src/core/brain-repo-durability.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-bounded-exec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Hardened two ways, so losing either probe's output reads as "not hardened": one hook sits in
// core.hooksPath, the other in a separate git directory that `<checkout>/.git/hooks` does not reach.
const hooksPathRepo = join(dir, 'hooks-path'), separateGitDirRepo = join(dir, 'separate-git-dir');
const hook = '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n';
execFileSync('git', ['init', '-q', hooksPathRepo]);
execFileSync('git', ['-C', hooksPathRepo, 'config', 'core.hooksPath', 'custom-hooks']);
mkdirSync(join(hooksPathRepo, 'custom-hooks'));
writeFileSync(join(hooksPathRepo, 'custom-hooks', 'post-commit'), hook, { mode: 0o755 });
execFileSync('git', ['init', '-q', `--separate-git-dir=${join(dir, 'separate.git')}`, separateGitDirRepo]);
mkdirSync(join(dir, 'separate.git', 'hooks'), { recursive: true });
writeFileSync(join(dir, 'separate.git', 'hooks', 'post-commit'), hook, { mode: 0o755 });

/**
 * Starts short-lived children whose first exit callback re-enters the event
 * loop the way bun:test `expect().resolves/.rejects` does. Bun drops the other
 * pipe events of the same poll batch (still on 1.4.2) and, before 1.3.14, the
 * exit events too (oven-sh/bun#30301), which is how managed-maintenance, persistence-reconcile
 * and google-attachments hung behind a persistence consumer's git probe.
 * It returns only after its nested tick has returned and every one of its
 * children has exited, so the nested tick cannot land in a later test and
 * drop that test's pipe events. Awaiting the exits alone is not enough: the
 * nested tick runs this function's continuation from inside itself.
 */
async function nestedTickDuring<T>(work: () => Promise<T>[]): Promise<T[]> {
  const nestedTick = Promise.withResolvers<void>();
  let nested = false;
  const children = Array.from({ length: 20 }, () => Bun.spawn(['true'], { stdio: ['ignore', 'ignore', 'ignore'], onExit() {
    if (nested) return;
    nested = true;
    void expect(Bun.sleep(1)).resolves.toBeUndefined();
    nestedTick.resolve();
  } }));
  try {
    return await Promise.all(work());
  } finally {
    await Promise.all([nestedTick.promise, ...children.map(child => child.exited)]);
  }
}

function within<T>(ms: number, promise: Promise<T>): Promise<T | 'unsettled'> {
  return Promise.race([promise, Bun.sleep(ms).then(() => 'unsettled' as const)]);
}

test('bounded execution settles by its deadline when the runtime drops child events', async () => {
  const outcomes = await within(5000, nestedTickDuring(() => Array.from({ length: 20 },
    () => execFileBounded('git', ['-C', dir, 'rev-parse', '--git-path', 'hooks'], { timeout: 1500 }))));
  expect(outcomes).not.toBe('unsettled');
  for (const { error } of outcomes as Awaited<ReturnType<typeof execFileBounded>>[]) {
    if (error?.killed) expect(error.code).toBe('ETIMEDOUT');
  }
});

test('the persistence durability probe settles when the runtime drops child events', async () => {
  const probes = await within(20_000, nestedTickDuring(() => Array.from({ length: 20 }, () => isDurabilityHardenedAsync(dir))));
  expect(probes).toEqual(Array(20).fill(false));
  const repos = Array.from({ length: 20 }, (_, i) => i % 2 ? separateGitDirRepo : hooksPathRepo);
  expect(await Promise.all([hooksPathRepo, separateGitDirRepo].map(repo => isDurabilityHardenedAsync(repo)))).toEqual([true, true]);
  const outcomes = await within(20_000, nestedTickDuring(() => repos.map(repo => isDurabilityHardenedAsync(repo).catch((error: Error) => error))));
  expect(outcomes).not.toBe('unsettled');
  for (const outcome of outcomes as Array<boolean | Error>) {
    if (outcome instanceof Error) expect(outcome).toMatchObject({ code: 'git_unavailable', suggestion: expect.stringContaining('(ETIMEDOUT)') });
    else expect(outcome).toBe(true);
  }
}, 30_000);

test('bounded execution keeps execFile exit codes and stdout', async () => {
  const { error, stdout, stderr } = await execFileBounded('sh', ['-c', 'printf example; printf refusal >&2; exit 3'], { timeout: 10_000 });
  expect(stdout).toBe('example');
  expect(stderr).toBe('refusal');
  expect(error?.code).toBe(3);
  expect(error?.killed).toBeFalsy();
  expect(await execFileBounded('sh', ['-c', 'printf ok'], { timeout: 10_000 })).toEqual({ error: null, stdout: 'ok', stderr: '' });
});

test('a dropped-event simulation ends before the next child starts', async () => {
  for (let i = 0; i < 100; i++) {
    await nestedTickDuring(() => []);
    expect(await execFileBounded('sh', ['-c', 'printf example; printf refusal >&2; exit 3'], { timeout: 10_000 }))
      .toMatchObject({ stdout: 'example', stderr: 'refusal', error: { code: 3 } });
  }
});

test('bounded execution stops a running child on abort and at its deadline', async () => {
  const abort = new AbortController();
  const started = performance.now();
  const aborted = execFileBounded('sleep', ['30'], { timeout: 60_000, signal: abort.signal });
  setTimeout(() => abort.abort(), 50);
  expect((await aborted).error).toMatchObject({ code: 'ABORT_ERR', killed: true });
  expect((await execFileBounded('sleep', ['30'], { timeout: 100 })).error).toMatchObject({ code: 'ETIMEDOUT', killed: true });
  expect(performance.now() - started).toBeLessThan(5000);
  const preAborted = new AbortController();
  preAborted.abort();
  expect((await execFileBounded('sleep', ['30'], { timeout: 60_000, signal: preAborted.signal })).error).toMatchObject({ code: 'ABORT_ERR' });
});

test('a stopped child gets SIGTERM first so it can remove its lockfile, then SIGKILL after the grace period', async () => {
  const lock = join(dir, 'index.lock');
  const script = `trap "rm -f '${lock}'; exit 143" TERM; touch '${lock}'; while :; do sleep 0.05; done`;
  const abort = new AbortController();
  const running = execFileBounded('sh', ['-c', script], { timeout: 60_000, signal: abort.signal });
  // The lock appears once the child's trap is installed; on a loaded runner that can take longer than any fixed sleep.
  for (const deadline = performance.now() + 10_000; !(await Bun.file(lock).exists()) && performance.now() < deadline;) await Bun.sleep(20);
  expect(await Bun.file(lock).exists()).toBe(true);
  abort.abort();
  expect((await running).error).toMatchObject({ code: 'ABORT_ERR', killed: true });
  expect(await Bun.file(lock).exists()).toBe(false);
  const started = performance.now();
  const stubborn = await execFileBounded('sh', ['-c', 'trap "" TERM; while :; do sleep 0.05; done'], { timeout: 100 });
  expect(stubborn.error).toMatchObject({ code: 'ETIMEDOUT', killed: true });
  expect(performance.now() - started).toBeLessThan(5000);
});
