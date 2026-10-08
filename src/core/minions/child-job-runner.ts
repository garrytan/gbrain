/**
 * Parent-side child-process runner for per-job isolation (issue #5).
 *
 * `runJobInChild` is the one-line seam executeJob swaps in for
 * `handler(context)` when isolation is on. The parent keeps claim, lock
 * renewal and ALL result recording; this module owns spawn → signal → reap →
 * decode:
 *
 *   spawn    — detached, tracking tini's separate child group on Linux;
 *              escaped descendants remain outside the cleanup guarantee,
 *              stdio ['ignore','inherit','inherit'] so handler logs stream
 *              to the operator; results travel by outcome file, never stdout.
 *   signal   — per-job abort (timeout / cancel / lock-lost /
 *              lock-renewal-failed) → group SIGTERM now, group SIGKILL at
 *              +CHILD_KILL_GRACE_MS (25s — inside the worker's 30s
 *              force-evict window, which stays as an untouched backstop).
 *              After the direct child exits, termination settles as soon
 *              as supported Linux proof confirms the owned groups gone;
 *              without that proof the group is SIGKILLed at once and the
 *              stop stays unconfirmed. Survivors keep the grace SIGKILL.
 *              Worker shutdown → same SIGTERM (the child's own handler fires
 *              ctx.shutdownSignal, giving handlers the drain window to
 *              finish AND write their outcome) with the SIGKILL backstop.
 *   classify — outcome file presence rules (job-isolation.ts). No file:
 *              per-job abort → generic throw (executeJob's catch reads
 *              abort.signal.reason, so infra aborts still burn no attempt);
 *              worker shutdown → ChildWorkerShutdownError (released, NO
 *              attempt burned — a routine deploy must not burn attempts;
 *              codex-2 #7); otherwise a crash (attempt burned, correct).
 *              Pre-exec spawn failure → ChildSpawnInfraError (released, no
 *              attempt burned: one bad CLI path must not dead-letter a
 *              queue; the CLI layer also fail-fast validates at startup).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnInvocation } from './spawn-helpers.ts';
import { SpendEnforcementUnavailableError, childSpendEnforcementReady } from './spend-authorization.ts';
import { LocalConfigurationError, isLocalConfigurationError } from './configuration-error.ts';
import {
  UnrecoverableError,
  ABORT_REASON_TIMEOUT,
  ABORT_REASON_LOCK_LOST,
  ABORT_REASON_LOCK_RENEWAL_FAILED,
} from './types.ts';
import {
  JOB_CHILD_EXIT_USAGE,
  JOB_CHILD_EXIT_NOT_CLAIMED,
} from './worker-exit-codes.ts';
import {
  CHILD_ENV,
  CHILD_KILL_GRACE_MS,
  CHILD_READ_POOL_MAX,
  childConfigurationError,
  buildChildArgs,
  decodeChildOutcomeFileAsync,
  killProcessGroup,
  observeTiniChildProcessGroups,
  captureChildCleanup,
  confirmChildCleanup,
  validateChildExecutable,
  type ChildCleanupSnapshot,
  reconstructHandlerError,
  type ChildCliInvocation,
} from './job-isolation.ts';

/** Pre-exec spawn failure — infrastructure, not a job defect. executeJob
 *  releases the job with no attempt burned (stall sweeper requeues). */
export class ChildSpawnInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildSpawnInfraError';
  }
}

/** Shutdown before a report; execution stop requires independent evidence. */
export class ChildWorkerShutdownError extends Error {
  constructor(message: string, readonly executionStopped = false) {
    super(message);
    this.name = 'ChildWorkerShutdownError';
  }
}

/** Child found the job reclaimed/cancelled (exit 14) — provably owned
 *  elsewhere. The worker releases without failJob (the fenced failJob would
 *  no-op anyway); definitely not an attempt against THIS claim. */
export class ChildNotClaimedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildNotClaimedError';
  }
}

/** Per-job abort reasons that mean THE JOB was targeted (timeout / lock
 *  loss) rather than the worker winding down. gracefulShutdown('watchdog')
 *  aborts BOTH the shutdown signal and every per-job signal — the shutdown
 *  classification must win for those (adversarial-review P3: the watchdog
 *  drain otherwise burns an attempt on innocent isolated jobs). Built from
 *  the shared literals in types.ts so a rename at an abort site cannot
 *  silently flip child classification (maintainability review — the
 *  never-produced 'cancel'/'cancelled' entries were dropped: cancellation
 *  surfaces as lock-lost via the fenced renewLock). */
const PER_JOB_ABORT_REASONS = new Set<string>([
  ABORT_REASON_TIMEOUT,
  ABORT_REASON_LOCK_LOST,
  ABORT_REASON_LOCK_RENEWAL_FAILED,
]);

export interface RunJobInChildOpts {
  jobId: number;
  /** The row carries a spend authorization: only a child with `spend-enforcement-v1` may run it. */
  spendAuthorized?: boolean;
  jobName: string;
  lockToken: string;
  /** Per-job abort (timeout / cancel / lock-lost / lock-renewal-failed). */
  abortSignal: AbortSignal;
  /** Worker-process SIGTERM/SIGINT. */
  shutdownSignal: AbortSignal;
  /** Resolved once at worker startup (fail-fast); how to invoke the CLI. */
  invocation: ChildCliInvocation;
  /** tini path ('' when absent — direct spawn, same degradation as the supervisor). */
  tiniPath: string;
  /** Injectable for tests. Default CHILD_KILL_GRACE_MS. */
  killGraceMs?: number;
  /** Injectable base env for tests. Default process.env. */
  env?: Record<string, string | undefined>;
  signalProcessGroup?: typeof killProcessGroup;
  onConfigurationError?: (error: LocalConfigurationError) => void;
  onExecutionStopped?: () => void;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnErr?: Error;
}

/**
 * Run one claimed job in a child process. Resolves with the handler result
 * (parent then runs the normal completeJob path); throws reconstructed
 * handler errors / classification errors (parent's existing catch handles
 * them verbatim).
 */
export async function runJobInChild(opts: RunJobInChildOpts): Promise<unknown> {
  if (opts.spendAuthorized && !childSpendEnforcementReady()) throw new SpendEnforcementUnavailableError();
  let executionStopped = false;
  let configurationError: LocalConfigurationError | undefined;
  try {
    return await runJobChildProcess({
      ...opts,
      onConfigurationError: error => {
        configurationError = error;
        opts.onConfigurationError?.(error);
      },
      onExecutionStopped: () => {
        executionStopped = true;
        opts.onExecutionStopped?.();
      },
    });
  } catch (error) {
    if (configurationError) throw configurationError;
    if (isLocalConfigurationError(error)) throw error;
    const abortReason = opts.abortSignal.reason instanceof Error ? opts.abortSignal.reason.message : String(opts.abortSignal.reason ?? '');
    // An UnrecoverableError from a child whose stop is confirmed dead-letters
    // (W9F Decision 7); an unconfirmed stop keeps the claim off the queue.
    if (opts.shutdownSignal.aborted && !(error instanceof UnrecoverableError && executionStopped)
      && (isLocalConfigurationError(opts.shutdownSignal.reason) || !PER_JOB_ABORT_REASONS.has(abortReason))) {
      throw new ChildWorkerShutdownError('Job child stopped reporting during worker shutdown; cleanup evidence determines whether its claim can be released.', executionStopped);
    }
    throw error;
  }
}

async function runJobChildProcess(opts: RunJobInChildOpts): Promise<unknown> {
  const base = opts.env ?? process.env;
  let executable: string;
  try { executable = validateChildExecutable(opts.invocation.cmd, base); }
  catch (error) {
    if (isLocalConfigurationError(error)) opts.onExecutionStopped?.();
    throw error;
  }
  const dir = mkdtempSync(join(tmpdir(), `gbrain-job-${opts.jobId}-`));
  const resultPath = join(dir, 'outcome.json');
  const graceMs = opts.killGraceMs ?? CHILD_KILL_GRACE_MS;
  const signalGroup = opts.signalProcessGroup ?? killProcessGroup;

  // Bound the child's pools: sockets die with the process (the isolation
  // win), but per-child footprint must stay small — read pool <= 3, direct
  // pool 1 (a child runs no claim/renewal heartbeats; codex-2 #6). An
  // operator's own GBRAIN_POOL_SIZE is respected when STRICTER than the
  // default (their pooler MaxClients tuning must not be silently raised);
  // GBRAIN_JOB_CHILD_POOL_SIZE, when valid, is the explicit per-child knob
  // and wins outright. Invalid values fall through to the default.
  const parsePoolSize = (v: string | undefined): number | null => {
    if (v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const childOverride = parsePoolSize(base[CHILD_ENV.childPoolSize]);
  const userPool = parsePoolSize(base.GBRAIN_POOL_SIZE);
  const childPoolSize = childOverride ?? Math.min(userPool ?? CHILD_READ_POOL_MAX, CHILD_READ_POOL_MAX);

  const childEnv: Record<string, string | undefined> = {
    ...base,
    [CHILD_ENV.lockToken]: opts.lockToken,
    [CHILD_ENV.resultPath]: resultPath,
    [CHILD_ENV.isChild]: '1',
    [CHILD_ENV.parentPid]: String(process.pid),
    GBRAIN_POOL_SIZE: String(childPoolSize),
    GBRAIN_DIRECT_POOL_SIZE: '1',
  };

  const inv = buildSpawnInvocation(opts.tiniPath, executable, [
    ...opts.invocation.argsPrefix,
    ...buildChildArgs(opts.jobId, base),
  ]);

  let child: ChildProcess;
  try {
    child = spawn(inv.cmd, inv.args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: childEnv as NodeJS.ProcessEnv,
      detached: true,
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    if (['ENOENT', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) {
      opts.onExecutionStopped?.();
      throw childConfigurationError('child_executable_invalid');
    }
    throw new ChildSpawnInfraError('Job child could not be spawned.');
  }

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let directExited = false;
  let stopPublished = false;
  let naturalCleanupConfirmed = false;
  const publishExecutionStopped = (): void => {
    if (stopPublished) return;
    stopPublished = true;
    opts.onExecutionStopped?.();
  };
  const directExit = new Promise<ChildExit>((resolve) => {
    child.once('error', error => {
      if (child.pid == null && ['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) publishExecutionStopped();
      resolve({ code: null, signal: null, spawnErr: error });
    });
    child.once('exit', (code, signal) => { directExited = true; resolve({ code, signal }); });
  });
  const processGroups = new Set<number>(child.pid ? [child.pid] : []);
  const observeTiniChildGroup = (): void => {
    if (opts.tiniPath && child.pid) observeTiniChildProcessGroups(child.pid, processGroups);
  };
  const groupObserver = opts.tiniPath ? setInterval(() => {
    observeTiniChildGroup();
    if (processGroups.size > 1 && groupObserver != null) clearInterval(groupObserver);
  }, 25) : null;
  groupObserver?.unref();
  let finishTermination!: () => void;
  const terminationDone = new Promise<void>((resolve) => { finishTermination = resolve; });
  let cleanupSnapshot: ChildCleanupSnapshot | undefined;
  let signallingFailed = false;
  let termed = false;
  let terminationSettled = false;
  let graceExpired = false;
  let cleanupPoll: ReturnType<typeof setTimeout> | null = null;
  const settleTermination = (executionStopped: boolean): void => {
    if (terminationSettled) return;
    terminationSettled = true;
    if (killTimer != null) clearTimeout(killTimer);
    if (cleanupPoll != null) clearTimeout(cleanupPoll);
    if (executionStopped) publishExecutionStopped();
    else {
      console.error(`[isolation] job ${opts.jobId} (${opts.jobName}): execution stop is unconfirmed ` +
        `(pid=${child.pid ?? 'unknown'}, platform=${process.platform}); lease expiry and duplicate-side-effect risk remain.`);
    }
    finishTermination();
  };
  const killGroups = (): void => {
    try { for (const group of processGroups) signalGroup(group, 'SIGKILL'); }
    catch { signallingFailed = true; }
  };
  const pollCleanup = (delayMs: number): void => {
    cleanupPoll = setTimeout(() => {
      cleanupPoll = null;
      if (terminationSettled || graceExpired) return;
      if (cleanupSnapshot && confirmChildCleanup(cleanupSnapshot)) settleTermination(true);
      else pollCleanup(Math.min(delayMs * 2, 500));
    }, delayMs);
  };
  const terminate = (): void => {
    if (termed) return;
    termed = true;
    observeTiniChildGroup();
    if (groupObserver != null) clearInterval(groupObserver);
    if (child.pid != null) {
      cleanupSnapshot = captureChildCleanup(child.pid, processGroups);
      if (opts.tiniPath && processGroups.size < 2) cleanupSnapshot.supported = false;
      for (const group of processGroups) {
        const delivered = signalGroup(group, 'SIGTERM');
        if (!delivered && cleanupSnapshot.observed.some(entry => entry.group === group && entry.state !== 'Z' && entry.state !== 'X')) signallingFailed = true;
      }
      void directExit.then(() => {
        if (!directExited || terminationSettled || graceExpired) return;
        if (!signallingFailed && cleanupSnapshot?.supported) {
          pollCleanup(25);
          return;
        }
        killGroups();
        settleTermination(false);
      });
      killTimer = setTimeout(async () => {
        graceExpired = true;
        if (cleanupPoll != null) clearTimeout(cleanupPoll);
        let executionStopped = false;
        try {
          killGroups();
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 250);
            void directExit.then(() => { clearTimeout(timer); resolve(); });
          });
          if (directExited && !signallingFailed && cleanupSnapshot?.supported) {
            await new Promise(resolve => setTimeout(resolve, 10));
            executionStopped = confirmChildCleanup(cleanupSnapshot);
          }
        } catch {
          signallingFailed = true;
        } finally {
          settleTermination(executionStopped);
        }
      }, graceMs);
    } else {
      finishTermination();
    }
  };
  const onAbort = (): void => terminate();
  const onShutdown = (): void => terminate();
  if (opts.abortSignal.aborted) onAbort();
  else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
  if (opts.shutdownSignal.aborted) onShutdown();
  else opts.shutdownSignal.addEventListener('abort', onShutdown, { once: true });

  console.log(
    `[isolation] job ${opts.jobId} (${opts.jobName}) child pid ${child.pid ?? '?'} spawned`,
  );

  try {
    const exit = await Promise.race([directExit, terminationDone.then(() => ({ code: child.exitCode, signal: child.signalCode }))]);

    if (termed) await terminationDone;
    if (!termed && directExited && child.pid != null) {
      observeTiniChildGroup();
      const snapshot = captureChildCleanup(child.pid, processGroups);
      naturalCleanupConfirmed = (!opts.tiniPath || processGroups.size > 1) && confirmChildCleanup(snapshot);
    }

    if ('spawnErr' in exit && exit.spawnErr && child.pid == null) {
      if (['ENOENT', 'EACCES'].includes((exit.spawnErr as NodeJS.ErrnoException).code ?? '')) {
        throw childConfigurationError('child_executable_invalid');
      }
      throw new ChildSpawnInfraError(
        'Job child could not be spawned.',
      );
    }

    console.log(
      `[isolation] job ${opts.jobId} (${opts.jobName}) child pid ${child.pid ?? '?'} ` +
      `settled code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}`,
    );

    const abortReason = opts.abortSignal.aborted
      ? (opts.abortSignal.reason instanceof Error
          ? opts.abortSignal.reason.message
          : String(opts.abortSignal.reason ?? 'aborted'))
      : null;
    // Shutdown classification wins UNLESS the per-job abort names a
    // job-targeted reason. gracefulShutdown('watchdog') aborts BOTH signals —
    // checking abortSignal first would shadow the no-burn shutdown release
    // and dead-letter innocent isolated jobs (adversarial-review P3).
    const isShutdownClass =
      opts.shutdownSignal.aborted &&
      (abortReason === null || !PER_JOB_ABORT_REASONS.has(abortReason));

    let outcome: Awaited<ReturnType<typeof decodeChildOutcomeFileAsync>>;
    try {
      // Async decode: a large-but-allowed outcome must not block the worker
      // event loop that runs lock-renewal ticks (performance review).
      outcome = await decodeChildOutcomeFileAsync(resultPath);
    } catch (decodeErr) {
      if (exit.code === 126 || exit.code === 127) {
        try { validateChildExecutable(executable, base); }
        catch (error) {
          if (isLocalConfigurationError(error)) {
            opts.onConfigurationError?.(error);
            terminate();
            await terminationDone;
          }
          throw error;
        }
      }
      // No usable outcome. Classify by WHY the child died.
      if (decodeErr instanceof UnrecoverableError) throw decodeErr; // oversize cap — dead on attempt 1
      if (isShutdownClass) {
        throw new ChildWorkerShutdownError(
          `job child terminated by worker shutdown before reporting (exit code=${exit.code} signal=${exit.signal})`,
        );
      }
      if (opts.abortSignal.aborted) {
        // executeJob's catch reads abort.signal.reason first, so infra
        // reasons (lock-renewal-failed / lock-lost) still burn no attempt
        // and timeout/cancel keep their existing semantics.
        throw new Error(
          `job child terminated after abort without an outcome (exit code=${exit.code} signal=${exit.signal})`,
        );
      }
      // Bootstrap failures carry reserved exit codes and are NOT handler
      // defects: 13 = usage/config (ops misconfiguration — release like a
      // spawn failure), 14 = job reclaimed before the handler ran (owned
      // elsewhere — release; the fenced failJob would no-op regardless).
      if (exit.code === JOB_CHILD_EXIT_USAGE) {
        throw new ChildSpawnInfraError(
          `job child bootstrap failed (exit ${exit.code}) — check the worker's child CLI/engine configuration`,
        );
      }
      if (exit.code === JOB_CHILD_EXIT_NOT_CLAIMED) {
        throw new ChildNotClaimedError(
          `job child found the claim gone (exit ${exit.code}) — reclaimed or cancelled before the handler ran`,
        );
      }
      throw new Error(
        `${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)} ` +
        `(exit code=${exit.code} signal=${exit.signal})`,
      );
    }

    if (outcome.outcome === 'success') return outcome.result;
    const handlerError = reconstructHandlerError(outcome);
    if (isLocalConfigurationError(handlerError)) {
      opts.onConfigurationError?.(handlerError);
      terminate();
      await terminationDone;
      throw handlerError;
    }
    // A handler-error outcome DURING worker shutdown is presumed
    // shutdown-induced (cooperative handlers that honor shutdownSignal bail
    // and report an error): release with no attempt burned rather than
    // punishing exactly the well-behaved handlers on every deploy
    // (adversarial-review P2). Worst case a genuinely-failing job that
    // coincided with a deploy gets one free retry — bounded and benign. An
    // UnrecoverableError is deterministic, so it dead-letters as usual.
    if (isShutdownClass && !(handlerError instanceof UnrecoverableError)) {
      throw new ChildWorkerShutdownError(
        'Job child reported an error during worker shutdown; execution stop is unconfirmed, so lease expiry remains the fallback.',
      );
    }
    throw handlerError;
  } finally {
    if (termed) await terminationDone;
    if (naturalCleanupConfirmed) publishExecutionStopped();
    if (killTimer != null) clearTimeout(killTimer);
    if (groupObserver != null) clearInterval(groupObserver);
    opts.abortSignal.removeEventListener('abort', onAbort);
    opts.shutdownSignal.removeEventListener('abort', onShutdown);
    rmSync(dir, { recursive: true, force: true });
  }
}
