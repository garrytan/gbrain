/**
 * #6712 PR 4b flake: the loop-lag bounds (test/sync-pass-shared-budget-6712.test.ts, test/sync-pass-loop-lag-6712.test.ts)
 * read wall time between timer runs, so a loaded CI VM that kept the thread off the CPU counted as code holding the loop:
 * a forced 60 ms stretch read 133 ms against the 100 ms bound on a 4-vCPU shard. Pinned to one core with three CPU hogs,
 * the shared-budget test read 156-257 ms; per-gap schedstat showed the excess as run-queue wait plus sleeps behind a
 * spawned Git that had not reached exec, with the thread's own CPU at 61-69 ms. `watchLoopLag` reads the thread's CPU.
 *
 * Forced probe (deterministic): the thread blocks 150 ms with a timer due, as it does behind a spawned Git that has not
 * reached exec. The wall clock reads it as 150 ms of lag; the thread's CPU clock, read on both sides of the block, does
 * not move. The CPU clock still sees a stretch of work, and two stretches in one turn, the regression the bounds exist to
 * catch.
 *
 * The block is Bun.sleepSync, a bare clock_nanosleep. Two earlier blocks charged their own work to the thread:
 * - A synchronous child runs the spawn's setup on the thread (1-4 ms, about 20 ms for a process's first spawn), and on a
 *   VM that charges host steal to the running thread those few ms read 30 ms once against the 25 ms bound (#7231).
 * - Atomics.wait runs the allocator's idle work on the waiting thread: JavaScriptCore's waitSyncImpl calls mimalloc's
 *   _mi_thread_idle_work, which purges freed page holes with madvise. A shard process carries the heap of every earlier
 *   test file, so the 150 ms wait read 37 and 186 ms of thread CPU on #7304's full-suite (shard 4/22) and 79-111 ms
 *   locally on that shard's first 47 files, where a symbolized strace showed 4,024 madvise calls from
 *   mi_page_purge_holes_now < _mi_thread_idle_work < waitSyncImpl < atomicsFuncWait.
 * With a 6M-object heap and 1.5M objects dropped before each of 40 blocks, Atomics.wait read up to 108 ms and
 * Bun.sleepSync at most 0.3 ms.
 * A collection the engine starts while the thread blocks charges its own pause to the reading: the collector stops the
 * thread when the block returns, and that pause grows with the heap. Bun.sleepSync read 31 ms on #7383 (Bun 1.4.4).
 * With a 4M-object heap, 50k objects dropped and an async collection requested before each of 12 blocks, one block per
 * process read 45-64 ms of thread CPU and 193-213 ms of wall time, on Bun 1.4.3 and 1.4.4 (8 of 8 processes, a full
 * collection's first pause); a full collection run before each block left at most 4 ms (8 of 8).
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { threadCpuNow } from './helpers/cpu-time.ts';

/** The bound the loop-lag tests hold. */
const MAX_LAG_MS = 100;
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 20));
/** Blocks the thread off the CPU for `ms`; returns the thread CPU the block cost. */
const offCpu = (ms: number) => {
  Bun.gc(true);
  const start = threadCpuNow();
  Bun.sleepSync(ms);
  return threadCpuNow() - start;
};

test('a thread kept off the CPU with a timer due is not lag; the wall clock reads it as lag', async () => {
  let last = performance.now(), wallLag = 0;
  const wall = setInterval(() => { const now = performance.now(); wallLag = Math.max(wallLag, now - last - 5); last = now; }, 5);
  await turn();
  const cpu = offCpu(150);
  await turn();
  clearInterval(wall);
  expect(Math.round(wallLag)).toBeGreaterThanOrEqual(MAX_LAG_MS + 40);
  // The 150 ms off the CPU cost none.
  expect(Math.round(cpu)).toBeLessThan(MAX_LAG_MS / 4);
});

test('a stretch of work is lag on the CPU clock, and two stretches in one turn add up', () => {
  // In a fresh process: the reading covers every task on the thread between two timer runs, and in a shared shard
  // process work an earlier test file left running lands there too (a 60 ms stretch read 106 ms on a GitHub shard).
  const helper = JSON.stringify(join(import.meta.dir, 'helpers', 'cpu-time.ts'));
  const probe = `import { spinCpuMs, watchLoopLag } from ${helper};
    const turn = () => new Promise(resolve => setTimeout(resolve, 20));
    const one = watchLoopLag();
    await turn(); spinCpuMs(60); await turn();
    const single = one.stop();
    const two = watchLoopLag();
    await turn(); spinCpuMs(60); spinCpuMs(60); await turn();
    console.log(JSON.stringify({ single, two: two.stop() }));`;
  const { single, two } = JSON.parse(execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim().split('\n').pop()!) as Record<'single' | 'two', { maxLag: number; ticks: number }>;
  expect(single.ticks).toBeGreaterThan(0);
  expect(Math.round(single.maxLag)).toBeGreaterThanOrEqual(60);
  expect(Math.round(single.maxLag)).toBeLessThan(MAX_LAG_MS);
  expect(Math.round(two.maxLag)).toBeGreaterThanOrEqual(120);
});
