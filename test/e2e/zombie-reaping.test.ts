/**
 * E2E test for SIGCHLD handler reaping zombie shell-job children.
 *
 * Background: zombie children spawned by the worker (shell jobs, embed
 * batches, sub-agents) accumulate in the PID table when the parent never
 * calls waitpid(). The fix in src/cli.ts is to install a SIGCHLD listener;
 * Bun (like Node) only auto-reaps when at least one listener is registered.
 *
 * This test is the load-bearing real-binary verification: spawn the
 * compiled-or-interpreted gbrain CLI as `jobs work --concurrency 1` against
 * a real Postgres, submit a shell job from the CLI side (`remote: false`,
 * no v0.26.9 RCE-gate), capture the PID of the worker's shell child from
 * the job result, then `ps -o stat= -p $PID` after ~300ms to verify the
 * worker reaped it (no Z state).
 *
 * Why not gbrain serve --http: that path doesn't start a worker, and
 * `submit_job` over MCP carries `remote: true` which rejects shell at the
 * v0.26.9 gate (operations.ts:1391). The CLI submit + jobs work path is
 * the only architecture that exercises the SIGCHLD handler in a real boot.
 *
 * Negative control (manual, not CI):
 *   1. Comment out `installSigchldHandler()` in src/cli.ts
 *   2. Re-run this test
 *   3. Expect: ps reports stat=Z for the captured PID
 *   4. Re-enable, re-run, expect: stat is empty (process gone, reaped)
 *
 * Skip rules:
 *   - DATABASE_URL must be set (matches existing E2E pattern)
 *   - Linux + macOS only (POSIX-only; tini/SIGCHLD don't exist on Windows)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const skipReason: string | null = !hasDatabase()
  ? 'DATABASE_URL not set'
  : process.platform === 'win32'
    ? 'POSIX-only (tini/SIGCHLD)'
    : null;

const describeE2E = skipReason ? describe.skip : describe;
if (skipReason) console.log(`Skipping E2E zombie-reaping tests (${skipReason})`);

describeE2E('SIGCHLD handler reaps shell-job children (real binary)', () => {
  let workerProc: ChildProcess | null = null;
  let workerStderr = '';
  let submittedJobIds: number[] = [];

  beforeAll(async () => {
    // Init schema + run migrations + truncate. setupDB seeds schema_version=1
    // but doesn't run the full migration chain (the OAuth E2E doesn't need it
    // because it doesn't touch minion_jobs). We call engine.initSchema()
    // explicitly to run migrations through the latest version, then disconnect
    // so the spawned worker subprocess gets a fresh DB connection.
    const engine = await setupDB();
    await engine.initSchema();
    await teardownDB();

    // Start the worker via the same `bun run src/cli.ts` path the OAuth E2E
    // uses. This boots through cli.ts so the SIGCHLD handler is installed,
    // then runs the jobs work daemon. GBRAIN_ALLOW_SHELL_JOBS=1 is required
    // for the shell handler to register.
    workerProc = spawn(
      'bun',
      ['run', 'src/cli.ts', 'jobs', 'work', '--concurrency', '1'],
      {
        cwd: process.cwd(),
        env: { ...process.env, GBRAIN_ALLOW_SHELL_JOBS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    workerProc.stderr?.on('data', (d: Buffer) => { workerStderr += d.toString(); });
    let workerStdout = '';
    workerProc.stdout?.on('data', (d: Buffer) => { workerStdout += d.toString(); });

    // Wait for "Minion worker started" or similar readiness signal.
    let ready = false;
    for (let i = 0; i < 60; i++) {
      const combined = workerStdout + workerStderr;
      if (/worker.*(started|polling|registered)/i.test(combined)
          || /handlers/i.test(combined)
          || combined.length > 500) { // worker has logged enough that it's clearly running
        // Probe by submitting a no-op job; if that succeeds the worker is up.
        // Heuristic: any output beyond startup banner indicates ready.
        ready = true;
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    // Even if we don't see a clear "started" line, give the worker 1 more second
    // for the queue claim loop to spin up before the first test runs.
    await new Promise(r => setTimeout(r, 1000));
    if (!ready) {
      // Don't throw — proceed and let the test's actual assertion catch issues.
      // eslint-disable-next-line no-console
      console.warn('[zombie-reaping E2E] worker readiness not detected; continuing anyway. stderr tail:\n', workerStderr.slice(-500));
    }
  }, 30_000);

  afterAll(async () => {
    if (workerProc && !workerProc.killed) {
      workerProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!workerProc.killed) workerProc.kill('SIGKILL');
    }
    // Best-effort cleanup of any submitted jobs to keep the queue clean
    // for subsequent test runs.
    for (const id of submittedJobIds) {
      try {
        execSync(`bun run src/cli.ts jobs delete ${id}`,
          { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env }, stdio: 'pipe' });
      } catch { /* best effort */ }
    }
  });

  test('shell-job child does NOT linger as a zombie (Z state) after exit', async () => {
    // Submit a shell job that sleeps briefly then exits 0. Worker spawns
    // /bin/sh as a child; without the SIGCHLD handler the sh process would
    // sit in the PID table as a zombie until the worker process itself dies.
    const params = JSON.stringify({ cmd: 'sleep 0.2', cwd: '/tmp' });
    let submitOut = '';
    try {
      submitOut = execSync(
        `bun run src/cli.ts jobs submit shell --params '${params}'`,
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          // GBRAIN_ALLOW_SHELL_JOBS=1 also gates the CLI submit path, not
          // just the worker that executes the job.
          env: { ...process.env, GBRAIN_ALLOW_SHELL_JOBS: '1' },
        },
      );
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `jobs submit failed:\n${err.stderr?.toString() ?? ''}\n${err.stdout?.toString() ?? ''}`,
      );
    }
    // Without --follow, `jobs submit` prints the full job as JSON on stdout.
    let jobId: number;
    try {
      const job = JSON.parse(submitOut) as { id: number };
      jobId = job.id;
    } catch {
      throw new Error(`Could not parse jobs submit output as JSON:\n${submitOut.slice(0, 500)}`);
    }
    expect(typeof jobId).toBe('number');
    submittedJobIds.push(jobId);

    // Poll `jobs get` until status COMPLETED (≤ 10s) and parse the Result
    // line which the shell handler returns as JSON containing `pid`.
    let resultObj: { pid?: number; exit_code?: number } | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const out = execSync(
        `bun run src/cli.ts jobs get ${jobId}`,
        { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
      );
      if (/COMPLETED/i.test(out)) {
        const m = out.match(/Result:\s+({.*})/);
        if (m) {
          try { resultObj = JSON.parse(m[1]); } catch { /* try again */ }
        }
        if (resultObj) break;
      }
      await new Promise(r => setTimeout(r, 250));
    }

    if (!resultObj) {
      throw new Error(
        `Job ${jobId} did not complete within 10s. Worker stderr tail:\n${workerStderr.slice(-1000)}`,
      );
    }

    expect(resultObj.exit_code).toBe(0);
    expect(typeof resultObj.pid).toBe('number');
    const childPid = resultObj.pid as number;

    // Give SIGCHLD a chance to fire and the worker to reap. The shell
    // process exited at submit + ~200ms; we poll the next ~500ms.
    await new Promise(r => setTimeout(r, 300));

    // ps -o stat= -p PID prints the stat column with no header. Empty
    // output means the process is gone (reaped or never existed). 'Z'
    // means it's lingering as a zombie — this would prove the SIGCHLD
    // handler regressed.
    let psOut = '';
    try {
      psOut = execSync(`ps -o stat= -p ${childPid}`, { encoding: 'utf8' }).trim();
    } catch {
      // ps exits non-zero when no matching process. That's the GOOD case
      // (process reaped, no PID entry). Treat as empty.
      psOut = '';
    }

    expect(psOut).not.toMatch(/^Z/);
    // Either gone (reaped) or in a non-zombie state. Both are acceptable;
    // a future SIGCHLD regression would surface as `Z` here.
  }, 30_000);
});
