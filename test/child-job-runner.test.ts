/**
 * issue #5 — `runJobInChild` against REAL child processes (.mjs harnesses run
 * by process.execPath — the child-worker-supervisor.test.ts pattern).
 *
 * Paths pinned:
 *   - success outcome file → resolves with the handler result
 *   - error outcome file → throws the reconstructed error class (exit 0!)
 *   - exit 1 with no file → generic throw naming the exit (attempt burned)
 *   - SIGTERM-ignoring child + aborted signal → group SIGKILL at the injected
 *     grace; "terminated after abort" classification
 *   - pre-aborted signal → child killed promptly
 *   - spawn ENOENT → ChildSpawnInfraError (release, no attempt burned)
 *   - worker-shutdown: child finishes + reports during the drain window →
 *     normal success; child that can't report → ChildWorkerShutdownError
 *   - child env contract (result path, lock token, parent pid, pool bounds)
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runJobInChild,
  ChildSpawnInfraError,
  ChildWorkerShutdownError,
  ChildNotClaimedError,
} from '../src/core/minions/child-job-runner.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/handlers/subagent.ts';

const TEST_TIMEOUT_MS = 30_000;

let harnessDir: string;

function makeHarness(name: string, body: string): string {
  const path = join(harnessDir, `${name}.mjs`);
  writeFileSync(
    path,
    `import { writeFileSync, renameSync } from 'node:fs';\n` +
    `const RESULT = process.env.GBRAIN_JOB_RESULT_PATH;\n` +
    `const writeOutcome = (o) => { writeFileSync(RESULT + '.tmp', JSON.stringify(o)); renameSync(RESULT + '.tmp', RESULT); };\n` +
    body +
    // Readiness handshake LAST (after the body installed its signal
    // handlers): fixed sleeps raced child startup on loaded CI runners —
    // a SIGTERM landing before process.on('SIGTERM') installs takes the
    // default disposition and flips shutdown-semantics assertions
    // (testing specialist). The runner's outcome dir is internal, so the
    // ready path comes from a TEST-provided env var.
    `\nif (process.env.HARNESS_READY_PATH) writeFileSync(process.env.HARNESS_READY_PATH, '1');\n`,
    'utf8',
  );
  return path;
}

/** Make a per-test ready path + the env to hand runJobInChild. */
function readiness(name: string): { env: Record<string, string | undefined>; wait: () => Promise<void> } {
  const readyPath = join(harnessDir, `${name}.ready`);
  return {
    env: { ...process.env, HARNESS_READY_PATH: readyPath },
    wait: async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(readyPath)) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('harness never signalled readiness');
    },
  };
}

beforeAll(() => {
  harnessDir = mkdtempSync(join(tmpdir(), 'gbrain-cjr-harness-'));
});

afterAll(() => {
  rmSync(harnessDir, { recursive: true, force: true });
});

function baseOpts(harnessPath: string) {
  return {
    jobId: 77,
    jobName: 'subagent',
    lockToken: 'tok-cjr',
    abortSignal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    invocation: { cmd: process.execPath, argsPrefix: [harnessPath] },
    tiniPath: '', // direct spawn in tests; group signaling covers both shapes
  };
}

describe('runJobInChild (real children)', () => {
  test('success outcome resolves with the result; env contract honored', async () => {
    const harness = makeHarness(
      'success',
      `writeOutcome({ outcome: 'success', result: {
         echoedToken: process.env.GBRAIN_JOB_LOCK_TOKEN,
         isChild: process.env.GBRAIN_JOB_CHILD,
         parentPid: process.env.GBRAIN_JOB_PARENT_PID,
         poolSize: process.env.GBRAIN_POOL_SIZE,
         directPoolSize: process.env.GBRAIN_DIRECT_POOL_SIZE,
         argv: process.argv.slice(2),
       }});\n` +
      `process.exit(0);\n`,
    );
    const result = (await runJobInChild(baseOpts(harness))) as Record<string, unknown>;
    expect(result.echoedToken).toBe('tok-cjr');
    expect(result.isChild).toBe('1');
    expect(result.parentPid).toBe(String(process.pid));
    expect(result.poolSize).toBe('3');
    expect(result.directPoolSize).toBe('1'); // codex-2 #6: child direct pool bounded
    expect(result.argv).toEqual(['jobs', 'run-child', '--job-id', '77']);
  }, TEST_TIMEOUT_MS);

  test('error outcome (exit 0) throws the reconstructed class', async () => {
    const harness = makeHarness(
      'error-unrecoverable',
      `writeOutcome({ outcome: 'error', errorKind: 'unrecoverable', message: 'bad schema, never retry' });\n` +
      `process.exit(0);\n`,
    );
    await expect(runJobInChild(baseOpts(harness))).rejects.toBeInstanceOf(UnrecoverableError);
  }, TEST_TIMEOUT_MS);

  test('rate-lease outcome rebuilds RateLeaseUnavailableError with fields', async () => {
    const harness = makeHarness(
      'error-lease',
      `writeOutcome({ outcome: 'error', errorKind: 'rate_lease', message: 'lease full', lease: { key: 'anthropic', active: 4, max: 4 } });\n` +
      `process.exit(0);\n`,
    );
    try {
      await runJobInChild(baseOpts(harness));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RateLeaseUnavailableError);
      expect((e as RateLeaseUnavailableError).key).toBe('anthropic');
    }
  }, TEST_TIMEOUT_MS);

  test('exit 1 with no outcome file → generic throw naming the exit code', async () => {
    const harness = makeHarness('crash', `process.exit(1);\n`);
    await expect(runJobInChild(baseOpts(harness))).rejects.toThrow(/exit code=1/);
  }, TEST_TIMEOUT_MS);

  test('SIGTERM-ignoring child: abort → group SIGKILL at the injected grace', async () => {
    const harness = makeHarness(
      'stubborn',
      `process.on('SIGTERM', () => {});\n` +
      `setInterval(() => {}, 1000);\n`, // never exits voluntarily
    );
    const abort = new AbortController();
    const ready = readiness('stubborn');
    const opts = { ...baseOpts(harness), abortSignal: abort.signal, killGraceMs: 400, env: ready.env };
    const p = runJobInChild(opts);
    await ready.wait();
    abort.abort(new Error('timeout'));
    const started = Date.now();
    await expect(p).rejects.toThrow(/terminated after abort/);
    // Died via the SIGKILL escalation, not the 30s force-evict scale.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, TEST_TIMEOUT_MS);

  test('pre-aborted signal: child is terminated promptly', async () => {
    const harness = makeHarness(
      'prekilled',
      `setInterval(() => {}, 1000);\n`,
    );
    const abort = new AbortController();
    abort.abort(new Error('cancel'));
    const opts = { ...baseOpts(harness), abortSignal: abort.signal, killGraceMs: 400 };
    await expect(runJobInChild(opts)).rejects.toThrow(/terminated after abort/);
  }, TEST_TIMEOUT_MS);

  test('spawn ENOENT → ChildSpawnInfraError (infra release, not a job defect)', async () => {
    const opts = {
      ...baseOpts('/nonexistent'),
      invocation: { cmd: '/nonexistent/gbrain-binary', argsPrefix: [] },
    };
    await expect(runJobInChild(opts)).rejects.toBeInstanceOf(ChildSpawnInfraError);
  }, TEST_TIMEOUT_MS);

  test('worker shutdown: child finishes + reports during the drain window → normal success', async () => {
    const harness = makeHarness(
      'graceful-drain',
      `let done = false;\n` +
      `process.on('SIGTERM', () => {\n` +
      `  writeOutcome({ outcome: 'success', result: { finishedDuringDrain: true } });\n` +
      `  done = true; process.exit(0);\n` +
      `});\n` +
      `setInterval(() => {}, 1000);\n`,
    );
    const shutdown = new AbortController();
    const ready = readiness('graceful-drain');
    const opts = { ...baseOpts(harness), shutdownSignal: shutdown.signal, killGraceMs: 5_000, env: ready.env };
    const p = runJobInChild(opts);
    await ready.wait();
    shutdown.abort(new Error('worker-shutdown'));
    const result = (await p) as Record<string, unknown>;
    expect(result.finishedDuringDrain).toBe(true);
  }, TEST_TIMEOUT_MS);

  test('worker shutdown: child that cannot report → ChildWorkerShutdownError (no attempt burned)', async () => {
    const harness = makeHarness(
      'shutdown-stubborn',
      `process.on('SIGTERM', () => {});\n` +
      `setInterval(() => {}, 1000);\n`,
    );
    const shutdown = new AbortController();
    const ready = readiness('shutdown-stubborn');
    const opts = { ...baseOpts(harness), shutdownSignal: shutdown.signal, killGraceMs: 400, env: ready.env };
    const p = runJobInChild(opts);
    await ready.wait();
    shutdown.abort(new Error('worker-shutdown'));
    await expect(p).rejects.toBeInstanceOf(ChildWorkerShutdownError);
  }, TEST_TIMEOUT_MS);

  test('ERROR outcome during worker shutdown → ChildWorkerShutdownError, not a burned attempt (adversarial P2)', async () => {
    // A cooperative handler that bails on shutdown and reports an error must
    // be RELEASED — punishing exactly the well-behaved handlers on every
    // deploy inverts the no-burn guarantee.
    const harness = makeHarness(
      'shutdown-error-report',
      `process.on('SIGTERM', () => {\n` +
      `  writeOutcome({ outcome: 'error', errorKind: 'generic', message: 'aborted: shutdown' });\n` +
      `  process.exit(0);\n` +
      `});\n` +
      `setInterval(() => {}, 1000);\n`,
    );
    const shutdown = new AbortController();
    const ready = readiness('shutdown-error-report');
    const opts = { ...baseOpts(harness), shutdownSignal: shutdown.signal, killGraceMs: 5_000, env: ready.env };
    const p = runJobInChild(opts);
    await ready.wait();
    shutdown.abort(new Error('worker-shutdown'));
    await expect(p).rejects.toBeInstanceOf(ChildWorkerShutdownError);
  }, TEST_TIMEOUT_MS);

  test('watchdog drain (BOTH signals aborted, non-per-job reason) → shutdown class, not a burned attempt (adversarial P3)', async () => {
    const harness = makeHarness(
      'watchdog-stubborn',
      `process.on('SIGTERM', () => {});\n` +
      `setInterval(() => {}, 1000);\n`,
    );
    const abort = new AbortController();
    const shutdown = new AbortController();
    const ready = readiness('watchdog-stubborn');
    const opts = {
      ...baseOpts(harness),
      abortSignal: abort.signal,
      shutdownSignal: shutdown.signal,
      killGraceMs: 400,
      env: ready.env,
    };
    const p = runJobInChild(opts);
    await ready.wait();
    // gracefulShutdown('watchdog') aborts BOTH — shutdown classification must win.
    shutdown.abort(new Error('watchdog'));
    abort.abort(new Error('watchdog'));
    await expect(p).rejects.toBeInstanceOf(ChildWorkerShutdownError);
  }, TEST_TIMEOUT_MS);

  test('per-job reason (timeout) wins over a concurrent shutdown — attempt semantics preserved', async () => {
    const harness = makeHarness(
      'timeout-during-shutdown',
      `process.on('SIGTERM', () => {});\n` +
      `setInterval(() => {}, 1000);\n`,
    );
    const abort = new AbortController();
    const shutdown = new AbortController();
    const ready = readiness('timeout-during-shutdown');
    const opts = {
      ...baseOpts(harness),
      abortSignal: abort.signal,
      shutdownSignal: shutdown.signal,
      killGraceMs: 400,
      env: ready.env,
    };
    const p = runJobInChild(opts);
    await ready.wait();
    shutdown.abort(new Error('worker-shutdown'));
    abort.abort(new Error('timeout')); // the JOB was targeted — not shutdown class
    await expect(p).rejects.toThrow(/terminated after abort/);
  }, TEST_TIMEOUT_MS);

  test('bootstrap exit codes: 13 → ChildSpawnInfraError, 14 → ChildNotClaimedError (no burned attempts)', async () => {
    const usage = makeHarness('exit13', `process.exit(13);\n`);
    await expect(runJobInChild(baseOpts(usage))).rejects.toBeInstanceOf(ChildSpawnInfraError);

    const notClaimed = makeHarness('exit14', `process.exit(14);\n`);
    await expect(runJobInChild(baseOpts(notClaimed))).rejects.toBeInstanceOf(ChildNotClaimedError);
  }, TEST_TIMEOUT_MS);

  test('child pool-size env: a STRICTER user GBRAIN_POOL_SIZE is respected; explicit child override wins; invalid falls back', async () => {
    const harness = makeHarness(
      'pool-echo',
      `writeOutcome({ outcome: 'success', result: { poolSize: process.env.GBRAIN_POOL_SIZE } });\n` +
      `process.exit(0);\n`,
    );
    const run = (env: Record<string, string | undefined>) =>
      runJobInChild({ ...baseOpts(harness), env: { ...process.env, ...env } }) as Promise<{ poolSize: string }>;

    expect((await run({ GBRAIN_POOL_SIZE: '2' })).poolSize).toBe('2'); // stricter user tuning respected
    expect((await run({ GBRAIN_POOL_SIZE: '10' })).poolSize).toBe('3'); // never raised above the child default
    expect((await run({ GBRAIN_POOL_SIZE: '2', GBRAIN_JOB_CHILD_POOL_SIZE: '5' })).poolSize).toBe('5'); // explicit knob wins
    expect((await run({ GBRAIN_JOB_CHILD_POOL_SIZE: 'abc' })).poolSize).toBe('3'); // invalid → default
  }, TEST_TIMEOUT_MS);
});
