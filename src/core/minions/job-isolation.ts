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
 * Handler-error semantics survive the boundary: the child encodes the
 * error classes executeJob branches on (UnrecoverableError → 'dead',
 * RateLeaseUnavailableError → lease release, no attempt burned) and
 * `reconstructHandlerError` rebuilds real instances parent-side so the
 * existing `instanceof` branches work verbatim. Everything else degrades to
 * a generic Error → the normal delayed/dead backoff path, same as inline.
 * Versioned local-configuration outcomes preserve the typed permanent fault.
 */

import { accessSync, constants, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from '../spawn.ts';
import { JobDeferredError, UnrecoverableError } from './types.ts';
import { RateLeaseUnavailableError } from './handlers/subagent.ts';
import { SpendGroupRefusedError, type SpendRefusalEnvelope } from './spend-authorization.ts';
import { LocalConfigurationError, isLocalConfigurationError } from './configuration-error.ts';
import { basename, delimiter, resolve } from 'node:path';

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

export const CHILD_OUTCOME_PROTOCOL_VERSION = 1;
export const CHILD_CONFIGURATION_REASONS = [
  'postgres_cancellation_unavailable', 'child_executable_invalid', 'child_protocol_incompatible',
] as const;

export function isChildConfigurationReason(value: unknown): value is typeof CHILD_CONFIGURATION_REASONS[number] {
  return CHILD_CONFIGURATION_REASONS.some((reason) => reason === value);
}

export function childConfigurationError(reason: typeof CHILD_CONFIGURATION_REASONS[number]): LocalConfigurationError {
  const messages = {
    postgres_cancellation_unavailable: 'The PostgreSQL driver lacks required cancellation support. Reinstall a known-good GBrain release or run bun install in the checkout to repair the shipped driver.',
    child_executable_invalid: 'The selected job child executable is missing or not executable. Fix GBRAIN_JOB_CHILD_CLI or repair the current GBrain executable path.',
    child_protocol_incompatible: 'The selected job child uses an incompatible readiness or outcome protocol. Reinstall the selected child with a compatible GBrain release.',
  };
  return new LocalConfigurationError(reason, `${messages[reason]} Verify worker and child readiness, then restart. See docs/guides/minions-fix.md#configuration-blocked.`);
}

export type ChildErrorKind = 'unrecoverable' | 'rate_lease' | 'deferred' | 'generic' | 'local_configuration';

export type ChildOutcome =
  | { outcome: 'success'; result: unknown }
  | {
      outcome: 'error';
      errorKind: ChildErrorKind;
      message: string;
      stack?: string;
      lease?: { key: string; active: number; max: number; retryInMs?: number };
      /** A group spend refusal's envelope (code, fix, group amounts). */
      spend?: SpendRefusalEnvelope;
      deferral?: { reason: string; retryInMs: number };
      protocolVersion?: number;
      reasonCode?: typeof CHILD_CONFIGURATION_REASONS[number];
    };

/** Child-side: classify a handler throw into the wire shape. */
export function encodeHandlerError(err: unknown): ChildOutcome {
  if (isLocalConfigurationError(err)) {
    return {
      outcome: 'error', errorKind: 'local_configuration',
      protocolVersion: CHILD_OUTCOME_PROTOCOL_VERSION,
      reasonCode: err.reasonCode,
      message: childConfigurationError(err.reasonCode).message,
    };
  }
  if (err instanceof RateLeaseUnavailableError) {
    return {
      outcome: 'error',
      errorKind: 'rate_lease',
      message: err.message,
      lease: { key: err.key, active: err.active, max: err.max, ...(err.retryInMs !== undefined ? { retryInMs: err.retryInMs } : {}) },
    };
  }
  if (err instanceof JobDeferredError) {
    return { outcome: 'error', errorKind: 'deferred', message: err.message, deferral: { reason: err.reason, retryInMs: err.retryInMs } };
  }
  if (err instanceof UnrecoverableError) {
    return {
      outcome: 'error',
      errorKind: 'unrecoverable',
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(err instanceof SpendGroupRefusedError ? { spend: err.envelope } : {}),
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
  if (o.errorKind === 'local_configuration' && o.protocolVersion === CHILD_OUTCOME_PROTOCOL_VERSION && isChildConfigurationReason(o.reasonCode)) {
    return childConfigurationError(o.reasonCode);
  }
  if (o.errorKind === 'rate_lease' && o.lease) {
    return new RateLeaseUnavailableError(o.lease.key, o.lease.active, o.lease.max, o.lease.retryInMs);
  }
  if (o.errorKind === 'unrecoverable') {
    return o.spend ? new SpendGroupRefusedError(o.spend) : new UnrecoverableError(o.message);
  }
  if (o.errorKind === 'deferred' && o.deferral && Number.isFinite(o.deferral.retryInMs)) {
    return new JobDeferredError(String(o.deferral.reason), o.message, o.deferral.retryInMs);
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
    if (kind === 'local_configuration' && o.protocolVersion === CHILD_OUTCOME_PROTOCOL_VERSION && isChildConfigurationReason(o.reasonCode)) {
      return encodeHandlerError(childConfigurationError(o.reasonCode));
    }
    const rawLease = (o as { lease?: unknown }).lease as
      | { key?: unknown; active?: unknown; max?: unknown; retryInMs?: unknown }
      | undefined;
    const rawSpend = (o as { spend?: unknown }).spend as { code?: unknown; message?: unknown; group?: unknown } | undefined;
    const spendValid = rawSpend != null && typeof rawSpend === 'object' && typeof rawSpend.code === 'string'
      && typeof rawSpend.message === 'string' && rawSpend.group != null && typeof rawSpend.group === 'object';
    const leaseValid =
      rawLease != null &&
      typeof rawLease.key === 'string' &&
      Number.isFinite(rawLease.active as number) &&
      Number.isFinite(rawLease.max as number);
    // rate_lease without a valid lease payload degrades to generic — same
    // policy as the errorKind whitelist.
    const rawDeferral = (o as { deferral?: unknown }).deferral as { reason?: unknown; retryInMs?: unknown } | undefined;
    const deferralValid = rawDeferral != null && typeof rawDeferral.reason === 'string' && Number.isFinite(rawDeferral.retryInMs as number);
    const errorKind =
      kind === 'unrecoverable' ? 'unrecoverable'
      : kind === 'rate_lease' && leaseValid ? 'rate_lease'
      : kind === 'deferred' && deferralValid ? 'deferred'
      : 'generic';
    return {
      outcome: 'error',
      errorKind,
      message: (o as { message: string }).message,
      ...((o as { stack?: unknown }).stack && typeof (o as { stack?: unknown }).stack === 'string'
        ? { stack: (o as { stack: string }).stack }
        : {}),
      ...(errorKind === 'rate_lease' && leaseValid
        ? { lease: { key: rawLease.key as string, active: rawLease.active as number, max: rawLease.max as number,
          ...(Number.isFinite(rawLease.retryInMs as number) && (rawLease.retryInMs as number) >= 0 ? { retryInMs: rawLease.retryInMs as number } : {}) } }
        : {}),
      ...(errorKind === 'unrecoverable' && spendValid ? { spend: rawSpend as SpendRefusalEnvelope } : {}),
      ...(errorKind === 'deferred' && deferralValid
        ? { deferral: { reason: rawDeferral.reason as string, retryInMs: rawDeferral.retryInMs as number } }
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

/**
 * argv for the child invocation (appended after the resolved CLI). The shell
 * opt-in travels as a FLAG as well as env: the child is a fresh gbrain process
 * that re-runs the startup cwd-.env quarantine (core/env-trust.ts) in the
 * worker's cwd and would drop GBRAIN_ALLOW_SHELL_JOBS again whenever a .env
 * there assigns it; `jobs run-child` re-asserts the env var from the flag.
 */
export function buildChildArgs(jobId: number, env: Record<string, string | undefined> = process.env): string[] {
  const args = ['jobs', 'run-child', '--job-id', String(jobId)];
  if (env.GBRAIN_ALLOW_SHELL_JOBS === '1') args.push('--allow-shell-jobs');
  return args;
}

export interface ChildCliInvocation {
  cmd: string;
  /** Args that come BEFORE buildChildArgs() output (e.g. the cli.ts path in bun-dev). */
  argsPrefix: string[];
}

export function validateChildExecutable(cmd: string, env: Record<string, string | undefined>): string {
  const candidates = cmd.includes('/') || (process.platform === 'win32' && cmd.includes('\\'))
    ? [resolve(cmd)]
    : (env.PATH ?? '/usr/bin:/bin').split(delimiter).map(directory => resolve(directory || '.', cmd));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error('Selected job child executable accessibility could not be checked.');
      }
    }
  }
  throw childConfigurationError('child_executable_invalid');
}

interface ProcessSnapshotEntry {
  pid: number;
  parent: number;
  group: number;
  start: string;
  state: string;
}

export interface ChildCleanupSnapshot {
  groups: Set<number>;
  observed: ProcessSnapshotEntry[];
  supported: boolean;
}

function readProcessSnapshot(): ProcessSnapshotEntry[] | null {
  if (process.platform !== 'linux') return null;
  const deadline = performance.now() + 200;
  try {
    const names = readdirSync('/proc').filter(name => /^\d+$/.test(name));
    if (names.length > 8192) return null;
    const entries: ProcessSnapshotEntry[] = [];
    for (const name of names) {
      if (performance.now() > deadline) return null;
      try {
        const raw = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        if (fields.length < 20) return null;
        entries.push({ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), start: fields[19], state: fields[0] });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') return null;
      }
    }
    return entries.some(entry => entry.pid === process.pid) ? entries : null;
  } catch { return null; }
}

export function captureChildCleanup(pid: number, groups: Set<number>): ChildCleanupSnapshot {
  const entries = readProcessSnapshot();
  if (!entries) return { groups: new Set(groups), observed: [], supported: false };
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parent) ?? [];
    siblings.push(entry.pid);
    children.set(entry.parent, siblings);
  }
  const owned = new Set([pid, ...entries.filter(entry => groups.has(entry.group)).map(entry => entry.pid)]);
  const pending = [...owned];
  for (let index = 0; index < pending.length; index++) {
    for (const child of children.get(pending[index]) ?? []) {
      if (!owned.has(child)) { owned.add(child); pending.push(child); }
    }
  }
  const observed = entries.filter(entry => owned.has(entry.pid));
  return {
    groups: new Set(groups), observed,
    supported: groups.size > 0 && observed.every(entry => groups.has(entry.group)),
  };
}

export function confirmChildCleanup(snapshot: ChildCleanupSnapshot): boolean {
  if (!snapshot.supported) return false;
  const entries = readProcessSnapshot();
  if (!entries) return false;
  const observed = new Map(snapshot.observed.map(entry => [entry.pid, entry.start]));
  return !entries.some(entry => entry.state !== 'Z' && entry.state !== 'X' && (
    snapshot.groups.has(entry.group) || observed.get(entry.pid) === entry.start
  ));
}

/**
 * Resolve how to invoke the gbrain CLI for a child process. Pure — all
 * inputs injected:
 *
 *   1. GBRAIN_JOB_CHILD_CLI env override (ops/test escape hatch)
 *   2. Current compiled executable or source CLI entrypoint
 *   3. resolveBinary() — PATH fallback when the current entrypoint is not a CLI
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
  if (execPath && !['bun', 'bun.exe', 'node', 'node.exe'].includes(basename(execPath))) {
    return { cmd: execPath, argsPrefix: [] };
  }
  if (argv1 && (argv1.endsWith('/cli.ts') || argv1.endsWith('\\cli.ts') || argv1 === 'cli.ts')) {
    return { cmd: execPath, argsPrefix: [argv1] };
  }
  try {
    const bin = resolveBinary();
    if (bin) return { cmd: bin, argsPrefix: [] };
  } catch {}
  return null;
}

/**
 * Signal an entire process GROUP.
 *
 * Children are spawned `detached: true`. Tini creates another group for its
 * child, so callers must also signal that observed group. Neither group
 * signalling nor subreaping contains descendants that create a new session.
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

export function observeTiniChildProcessGroups(pid: number, groups: Set<number>): void {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return;
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/);
    for (const value of children) {
      const childPid = Number(value);
      if (!Number.isInteger(childPid) || childPid <= 1) continue;
      const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[1]) === pid && Number(fields[2]) === childPid) groups.add(childPid);
    }
  } catch {}
}
