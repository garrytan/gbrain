import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileBounded, isDurabilityHardenedAsync } from '../src/core/brain-repo-durability.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-bounded-exec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Starts short-lived children whose first exit callback re-enters the event
 * loop the way bun:test `expect().resolves/.rejects` does. Bun drops the other
 * pipe events of the same poll batch (still on 1.4.2) and, before 1.3.14, the
 * exit events too (oven-sh/bun#30301), which is how managed-maintenance, persistence-reconcile
 * and google-attachments hung behind a persistence consumer's git probe.
 */
function nestedTickDuring<T>(work: () => Promise<T>[]): Promise<T[]> {
  let nested = false;
  for (let i = 0; i < 20; i++) {
    Bun.spawn(['true'], { stdio: ['ignore', 'ignore', 'ignore'], onExit() {
      if (nested) return;
      nested = true;
      void expect(Bun.sleep(1)).resolves.toBeUndefined();
    } });
  }
  return Promise.all(work());
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
}, 30_000);

test('bounded execution keeps execFile exit codes and stdout', async () => {
  const { error, stdout, stderr } = await execFileBounded('sh', ['-c', 'printf example; printf refusal >&2; exit 3'], { timeout: 10_000 });
  expect(stdout).toBe('example');
  expect(stderr).toBe('refusal');
  expect(error?.code).toBe(3);
  expect(error?.killed).toBeFalsy();
  expect(await execFileBounded('sh', ['-c', 'printf ok'], { timeout: 10_000 })).toEqual({ error: null, stdout: 'ok', stderr: '' });
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
  const script = `touch '${lock}'; trap "rm -f '${lock}'; exit 143" TERM; while :; do sleep 0.05; done`;
  const abort = new AbortController();
  const running = execFileBounded('sh', ['-c', script], { timeout: 60_000, signal: abort.signal });
  await Bun.sleep(200);
  expect(await Bun.file(lock).exists()).toBe(true);
  abort.abort();
  expect((await running).error).toMatchObject({ code: 'ABORT_ERR', killed: true });
  expect(await Bun.file(lock).exists()).toBe(false);
  const started = performance.now();
  const stubborn = await execFileBounded('sh', ['-c', 'trap "" TERM; while :; do sleep 0.05; done'], { timeout: 100 });
  expect(stubborn.error).toMatchObject({ code: 'ETIMEDOUT', killed: true });
  expect(performance.now() - started).toBeLessThan(5000);
});
