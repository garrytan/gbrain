/**
 * GBRA-133: --max-rss bounds a job child too. With process isolation on, handler memory lives in `jobs run-child`, and the
 * worker's watchdog read only the worker's own /proc entry, so a child that grew without bound (a managed sync pass
 * importing a whole large tree) ran until the container's memory limit restarted every process. The worker now measures
 * the child's process tree (RssAnon + RssShmem) and stops it past the same cap; the attempt counts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildRssLimitError, runJobInChild } from '../src/core/minions/child-job-runner.ts';
import { childTreeRss } from '../src/core/minions/job-isolation.ts';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-child-rss-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A child that holds `mb` of anonymous memory, then reports success after `ms` (or never, with ms < 0). */
function harness(name: string, mb: number, ms: number): string {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, `import { writeFileSync, renameSync } from 'node:fs';
const RESULT = process.env.GBRAIN_JOB_RESULT_PATH;
const held = []; for (let i = 0; i < ${mb}; i++) held.push(Buffer.alloc(1024 * 1024, 1));
globalThis.held = held;
if (${ms} >= 0) setTimeout(() => { writeFileSync(RESULT + '.tmp', JSON.stringify({ outcome: 'success', result: { ok: true } })); renameSync(RESULT + '.tmp', RESULT); process.exit(0); }, ${ms});
else setInterval(() => {}, 1000);
`);
  return path;
}

const opts = (path: string) => ({ jobId: 4242, jobName: 'sync', lockToken: 'tok-rss', abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
  invocation: { cmd: process.execPath, argsPrefix: [path] }, tiniPath: '', killGraceMs: 2_000, rssCheckIntervalMs: 100 });

test.skipIf(process.platform !== 'linux')('a job child past --max-rss is stopped and the attempt fails with ChildRssLimitError', async () => {
  const started = Date.now();
  const error = await runJobInChild({ ...opts(harness('grows', 400, 8_000)), maxRssMb: 200 }).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ChildRssLimitError);
  expect((error as ChildRssLimitError).maxRssMb).toBe(200);
  expect((error as ChildRssLimitError).rssMb).toBeGreaterThan(200);
  // Stopped by the cap, not after the child's own 8 s.
  expect(Date.now() - started).toBeLessThan(7_000);
}, 30_000);

test.skipIf(process.platform !== 'linux')('a child that ignores SIGTERM past the cap is SIGKILLed at the grace', async () => {
  const path = join(dir, 'stubborn.mjs');
  writeFileSync(path, "process.on('SIGTERM', () => {}); const held = []; for (let i = 0; i < 300; i++) held.push(Buffer.alloc(1024 * 1024, 1)); globalThis.held = held; setInterval(() => {}, 1000);\n");
  const started = Date.now();
  await expect(runJobInChild({ ...opts(path), maxRssMb: 150 })).rejects.toBeInstanceOf(ChildRssLimitError);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 30_000);

test.skipIf(process.platform !== 'linux')('a child under the cap, and a worker without one, run to their result', async () => {
  expect(await runJobInChild({ ...opts(harness('small', 20, 500)), maxRssMb: 1024 })).toEqual({ ok: true });
  expect(await runJobInChild({ ...opts(harness('uncapped', 300, 500)) })).toEqual({ ok: true });
}, 30_000);

test.skipIf(process.platform !== 'linux')('childTreeRss sums RssAnon+RssShmem over the tree and is null for a process table without it', () => {
  const own = childTreeRss(process.pid, new Set([process.pid]), pid => pid === process.pid ? 7 * 1024 * 1024 : 0);
  expect(own).toBe(7 * 1024 * 1024);
  expect(childTreeRss(2 ** 22 + 12345, new Set([2 ** 22 + 12345]), () => 1)).toBeNull();
});
