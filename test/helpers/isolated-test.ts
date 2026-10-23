import { expect, test } from 'bun:test';

/**
 * A test whose body runs in a fresh `bun test` process of its own file, for bounds on the thread's CPU between timer
 * runs (`watchLoopLag`). In a unit shard one process runs a few hundred files in turn, and that reading covers every
 * task on the thread: a timer an earlier file left running, or a collection pause that grows with the heap the earlier
 * files left. With a 60 ms timer left running every 100 ms, sync-pass-patched-domain-yield read 112-113 ms in its own
 * process and 47 ms in a fresh one (2 of 2 each); a collection's pause on a 4M-object heap read 45-64 ms
 * (test/loop-lag-cpu-clock.test.ts). The parent waits for the child, so the shard runs nothing else on that thread.
 *
 * The child finds its test by `GBRAIN_TEST_ISOLATED_NAME` (under `GBRAIN_TEST_`, so the operator-env scrub keeps it).
 */
export function isolatedTest(file: string, name: string, body: () => unknown, timeoutMs: number): void {
  const isolated = process.env.GBRAIN_TEST_ISOLATED_NAME;
  if (isolated !== undefined) {
    if (isolated === name) test(name, body as () => Promise<void>, timeoutMs);
    return;
  }
  test(name, async () => {
    const child = Bun.spawn([process.execPath, 'test', `--timeout=${timeoutMs}`, file, '-t', name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], {
      env: { ...process.env, GBRAIN_TEST_ISOLATED_NAME: name }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = out + err;
    if (child.exitCode !== 0 || !/^ 1 pass$/m.test(output) || !/^ 0 fail$/m.test(output)) {
      throw new Error(`the isolated run of "${name}" did not pass exactly one test (exit ${child.exitCode}):\n${output.slice(-6000)}`);
    }
    expect(child.exitCode).toBe(0);
  }, timeoutMs + 30_000);
}
