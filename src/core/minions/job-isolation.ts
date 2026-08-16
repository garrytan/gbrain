/**
 * Per-job process isolation protocol (issue #5).
 *
 * The worker (parent) keeps claim / lock-renewal / completeJob / failJob;
 * `gbrain jobs run-child` (child) owns handler execution with its own small
 * engine pool. This module is the protocol between them:
 *
 *   payload in   — job id via argv (`jobs run-child --job-id N`, ps-visible
 *                  for ops); lock token via GBRAIN_JOB_LOCK_TOKEN env (off
 *                  argv — not a secret, it's a fencing token, but no reason
 *                  to put it in `ps` output); result path via
 *                  GBRAIN_JOB_RESULT_PATH.
 *   result out   — ONE JSON file, written atomically (tmp + rename), decoded
 *                  by the parent. stdout/stderr stay inherited for handler
 *                  logs (handlers print freely — no sentinel parsing), and
 *                  node-IPC is deliberately avoided (zero precedent in this
 *                  codebase; fd inheritance through a tini wrapper is
 *                  unproven here).
 *   termination  — killProcessGroup(): children are spawned detached (own
 *                  process group) because SIGKILL on the tini pid alone kills
 *                  tini, NOT the handler grandchild (tini cannot forward
 *                  SIGKILL). Bun rejects negative pids in process.kill()
 *                  (oven-sh/bun#15791) and gbrain ships as a Bun-compiled
 *                  binary, so the group signal falls back to POSIX
 *                  /bin/kill when needed.
 *
 * Handler-error semantics survive the boundary: the child encodes the two
 * error classes executeJob branches on (UnrecoverableError → 'dead',
 * RateLeaseUnavailableError → lease release, no attempt burned) and
 * `reconstructHandlerError` rebuilds real instances parent-side so the
 * existing `instanceof` branches work verbatim. Everything else degrades to
 * a generic Error → the normal delayed/dead backoff path, same as inline.
 */

import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { UnrecoverableError } from './types.ts';
import { RateLeaseUnavailableError } from './handlers/subagent.ts';

/** Grace between group-SIGTERM and group-SIGKILL on abort. Deliberately
 *  inside the worker's 30s force-evict window so the evict path stays a
 *  nearly-unreachable backstop. */
export const CHILD_KILL_GRACE_MS = 25_000;

/** Decode cap for the child's outcome file. Results already round-trip
 *  through the completeJob JSONB column in inline mode, so anything near
 *  this cap is pathological; oversize throws UnrecoverableError (loud dead
 *  on attempt 1 — deterministic failure, retries would fail identically). */
export const CHILD_OUTCOME_MAX_BYTES = 32 * 1024 * 1024;

/** Default read-pool cap for isolation children. Referenced by the
 *  --job-isolation help copy ("~4 pooler client connections" = this + the
 *  direct pool of 1) and the minions-deployment.md budget math. */
export const CHILD_READ_POOL_MAX = 3;

/** Bun-compat timer unref (plain cast copy-pasted thrice before this helper). */
export function unrefTimer(t: unknown): void {
  (t as { unref?: () => void }).unref?.();
}

/** Env vars of the parent↔child contract. Spelled once here. */
export const CHILD_ENV = {
  lockToken: 'GBRAIN_JOB_LOCK_TOKEN',
  resultPath: 'GBRAIN_JOB_RESULT_PATH',
  isChild: 'GBRAIN_JOB_CHILD',
  parentPid: 'GBRAIN_JOB_PARENT_PID',
  childCliOverride: 'GBRAIN_JOB_CHILD_CLI',
  childPoolSize: 'GBRAIN_JOB_CHILD_POOL_SIZE',
} as const;

export type ChildErrorKind = 'unrecoverable' | 'rate_lease' | 'generic';

export type ChildOutcome =
  | { outcome: 'success'; result: unknown }
  | {
      outcome: 'error';
      errorKind: ChildErrorKind;
      message: string;
      stack?: string;
      lease?: { key: string; active: number; max: number };
    };

/** Child-side: classify a handler throw into the wire shape. */
export function encodeHandlerError(err: unknown): ChildOutcome {
  if (err instanceof RateLeaseUnavailableError) {
    return {
      outcome: 'error',
      errorKind: 'rate_lease',
      message: err.message,
      lease: { key: err.key, active: err.active, max: err.max },
    };
  }
  if (err instanceof UnrecoverableError) {
    return {
      outcome: 'error',
      errorKind: 'unrecoverable',
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  return { outcome: 'error', errorKind: 'generic', message, ...(stack ? { stack } : {}) };
}

/**
 * Parent-side: rebuild a real error instance so executeJob's existing
 * `instanceof` branches (dead / lease-release / delayed+backoff) work
 * verbatim. Unknown errorKind values degrade to generic (whitelist — the
 * file is same-user-written but a malformed kind must not crash the worker).
 */
export function reconstructHandlerError(o: Extract<ChildOutcome, { outcome: 'error' }>): Error {
  if (o.errorKind === 'rate_lease' && o.lease) {
    return new RateLeaseUnavailableError(o.lease.key, o.lease.active, o.lease.max);
  }
  if (o.errorKind === 'unrecoverable') {
    return new UnrecoverableError(o.message);
  }
  const err = new Error(o.message);
  if (o.stack) {
    (err as Error & { childStack?: string }).childStack = o.stack;
  }
  return err;
}

/** Child-side: atomic outcome write (tmp + rename on the same filesystem). */
export function writeChildOutcomeFile(path: string, outcome: ChildOutcome): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(outcome), 'utf8');
  renameSync(tmp, path);
}

/**
 * Pure outcome parser (shared by the sync and async decode paths). Throws:
 *   - UnrecoverableError when the file exceeds `maxBytes` (deterministic —
 *     dead on attempt 1, no silent truncation);
 *   - generic Error for malformed/unrecognized content (byte count only in
 *     the message, NEVER file content — handler output may carry secrets).
 * The `lease` payload is shape-validated (security review): a corrupt file
 * must degrade to 'generic', not inject undefined fields into the parent's
 * lease-release accounting.
 */
export function parseChildOutcome(raw: string, size: number, maxBytes = CHILD_OUTCOME_MAX_BYTES): ChildOutcome {
  if (size > maxBytes) {
    throw new UnrecoverableError(
      `job child result exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MiB outcome cap (${size} bytes); ` +
      `retries would fail identically — return a smaller result or persist large artifacts elsewhere`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`job child outcome file is not valid JSON (${size} bytes)`);
  }
  const o = parsed as Partial<ChildOutcome> | null;
  if (o && o.outcome === 'success') return { outcome: 'success', result: (o as { result?: unknown }).result };
  if (o && o.outcome === 'error' && typeof (o as { message?: unknown }).message === 'string') {
    const kind = (o as { errorKind?: unknown }).errorKind;
    const rawLease = (o as { lease?: unknown }).lease as
      | { key?: unknown; active?: unknown; max?: unknown }
      | undefined;
    const leaseValid =
      rawLease != null &&
      typeof rawLease.key === 'string' &&
      Number.isFinite(rawLease.active as number) &&
      Number.isFinite(rawLease.max as number);
    // rate_lease without a valid lease payload degrades to generic — same
    // policy as the errorKind whitelist.
    const errorKind =
      kind === 'unrecoverable' ? 'unrecoverable'
      : kind === 'rate_lease' && leaseValid ? 'rate_lease'
      : 'generic';
    return {
      outcome: 'error',
      errorKind,
      message: (o as { message: string }).message,
      ...((o as { stack?: unknown }).stack && typeof (o as { stack?: unknown }).stack === 'string'
        ? { stack: (o as { stack: string }).stack }
        : {}),
      ...(errorKind === 'rate_lease' && leaseValid
        ? { lease: { key: rawLease.key as string, active: rawLease.active as number, max: rawLease.max as number } }
        : {}),
    };
  }
  throw new Error(`job child outcome file has an unrecognized shape (${size} bytes)`);
}

const MISSING_OUTCOME_MESSAGE =
  'job child exited without writing its outcome file (crash, OOM, or kill before completion)';

/** Sync decode (tests + non-hot-path callers). */
export function decodeChildOutcomeFile(path: string, maxBytes = CHILD_OUTCOME_MAX_BYTES): ChildOutcome {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(MISSING_OUTCOME_MESSAGE);
  }
  if (size > maxBytes) return parseChildOutcome('', size, maxBytes); // throws the cap error
  return parseChildOutcome(readFileSync(path, 'utf8'), size, maxBytes);
}

/**
 * Async decode for the WORKER's per-job path: a large-but-allowed outcome
 * (up to 32MiB) must not block the event loop that runs lock-renewal ticks
 * and the health-probe chain (performance review).
 */
export async function decodeChildOutcomeFileAsync(
  path: string,
  maxBytes = CHILD_OUTCOME_MAX_BYTES,
): Promise<ChildOutcome> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error(MISSING_OUTCOME_MESSAGE);
  }
  if (size > maxBytes) return parseChildOutcome('', size, maxBytes); // throws the cap error
  return parseChildOutcome(await readFile(path, 'utf8'), size, maxBytes);
}

/** argv for the child invocation (appended after the resolved CLI). */
export function buildChildArgs(jobId: number): string[] {
  return ['jobs', 'run-child', '--job-id', String(jobId)];
}

export interface ChildCliInvocation {
  cmd: string;
  /** Args that come BEFORE buildChildArgs() output (e.g. the cli.ts path in bun-dev). */
  argsPrefix: string[];
}

/**
 * Resolve how to invoke the gbrain CLI for a child process. Pure — all
 * inputs injected:
 *
 *   1. GBRAIN_JOB_CHILD_CLI env override (ops/test escape hatch)
 *   2. resolveBinary() — the compiled-binary resolver
 *      (resolveGbrainCliPath; never returns a .ts path)
 *   3. bun-dev fallback: running from `bun src/cli.ts` → invoke
 *      `<execPath> <argv1>` so dev and tests work without a compiled binary
 *
 * Returns null when nothing resolves — the caller must fail fast at worker
 * startup (one bad path must not dead-letter a queue job-by-job).
 */
export function resolveChildCliInvocation(
  env: Record<string, string | undefined>,
  execPath: string,
  argv1: string | undefined,
  resolveBinary: () => string | null,
): ChildCliInvocation | null {
  const override = env[CHILD_ENV.childCliOverride];
  if (override && override.trim() !== '') {
    return { cmd: override, argsPrefix: [] };
  }
  try {
    const bin = resolveBinary();
    if (bin) return { cmd: bin, argsPrefix: [] };
  } catch {
    // fall through to the dev fallback
  }
  if (argv1 && (argv1.endsWith('/cli.ts') || argv1.endsWith('\\cli.ts') || argv1 === 'cli.ts')) {
    return { cmd: execPath, argsPrefix: [argv1] };
  }
  return null;
}

/**
 * Signal an entire process GROUP.
 *
 * Children are spawned `detached: true` (own group) so this reaches the
 * handler grandchildren even under a tini wrapper — SIGKILL on the tini pid
 * alone kills tini and ORPHANS the still-running handler (tini cannot
 * forward SIGKILL; that failure mode would silently void issue #5's
 * headline guarantee exactly in container deployments).
 *
 * Bun's process.kill() rejects negative pids (oven-sh/bun#15791), so on any
 * throw other than ESRCH we fall back to POSIX /bin/kill, which
 * group-signals fine on darwin + linux. Returns true when the signal was
 * delivered to a live group; false when the group is already gone (ESRCH —
 * success for our purposes) or delivery failed.
 */
export function killProcessGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // group already gone
    // RangeError on Bun (negative pid unsupported) or EPERM etc. — fall back
    // to /bin/kill by ABSOLUTE path (a PATH-resolved binary in a kill path is
    // an unnecessary indirection; security review). This is the NORMAL path
    // in Bun-compiled production binaries; the sync exec is ~1-3ms and only
    // runs on abort/shutdown, never in the claim/renewal hot loop.
    try {
      const sigName = signal.replace(/^SIG/, '');
      const res = spawnSync('/bin/kill', ['-s', sigName, '--', `-${pid}`], { stdio: 'ignore' });
      return res.status === 0;
    } catch {
      return false;
    }
  }
}
