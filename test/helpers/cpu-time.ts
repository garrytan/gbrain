/**
 * CPU time of a synchronous call on the calling thread, in milliseconds. A bound or scaling ratio over CPU time
 * measures the work rather than how long the scheduler made it wait, so load on a shared CI VM does not move it.
 * `process.threadCpuUsage` (as in test/entity-card-perf.slow.test.ts and src/core/progress.ts) leaves out the
 * engine's GC and JIT threads and any other concurrent work in the process. It does not see time spent waiting on
 * I/O, a subprocess, a timer or another thread: a test that bounds those keeps the wall clock.
 */
export function cpuMs(fn: () => unknown): number {
  const start = process.threadCpuUsage();
  fn();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}

/**
 * cpuMs for an async span: thread CPU from the call until it settles. It counts everything the thread runs in
 * between (PGLite's WASM engine runs on the calling thread) and nothing the span waits for (I/O on other threads,
 * timers, subprocesses). Use it only where nothing else runs in the process during the span and the span does
 * not wait on I/O, a timer or another process.
 */
export async function cpuMsAsync(fn: () => Promise<unknown>): Promise<number> {
  const start = process.threadCpuUsage();
  await fn();
  const used = process.threadCpuUsage(start);
  return (used.user + used.system) / 1000;
}
