import { spawn } from '../spawn.ts';
import type { BrainEngine } from '../engine.ts';
import { VERSION } from '../../version.ts';
import { isLocalConfigurationError } from './configuration-error.ts';
import {
  childConfigurationError, isChildConfigurationReason, killProcessGroup,
  observeTiniChildProcessGroups,
  validateChildExecutable,
  type ChildCliInvocation,
} from './job-isolation.ts';
import { buildSpawnInvocation } from './spawn-helpers.ts';
import { WORKER_EXIT_CONFIGURATION } from './worker-exit-codes.ts';

export const CHILD_READINESS_PROTOCOL_VERSION = 1;
export const CHILD_READINESS_TIMEOUT_MS = 20_000;
export const CHILD_READINESS_MAX_BYTES = 64 * 1024;
export const CHILD_READINESS_FEATURES = ['local-configuration-outcome-v1', 'postgres-cancellation-v1', 'spend-enforcement-v1'] as const;
/** Every child must advertise these; `spend-enforcement-v1` only gates spend-authorized rows (child-job-runner.ts). */
const REQUIRED_CHILD_FEATURES = ['local-configuration-outcome-v1', 'postgres-cancellation-v1'] as const;

/**
 * #7245: the readiness handshake runs once, when the worker starts, but every
 * job spawns a fresh `jobs run-child` from the install on disk, so a checkout
 * that moves under a running worker hands later jobs to another build. The
 * worker passes its build and the features this job needs in this env var
 * (JSON), and the child compares them before it runs the handler.
 */
export const CHILD_PARENT_BUILD_ENV = 'GBRAIN_JOB_PARENT_BUILD';

/** The worker's build for one job child: every job needs the required features, a spend-authorized row also `spend-enforcement-v1`. */
export function parentBuildEnvValue(spendAuthorized: boolean): string {
  const features: string[] = [...REQUIRED_CHILD_FEATURES];
  if (spendAuthorized) features.push('spend-enforcement-v1');
  return JSON.stringify({ version: VERSION, protocol_version: CHILD_READINESS_PROTOCOL_VERSION, features });
}

/** The history entry prefix a job child writes when its build differs from its worker's (doctor `runtime_build_skew` reads it). */
export const JOB_BUILD_SKEW_PREFIX = 'job_build_skew:';

export interface JobChildBuildVerdict {
  worker_version: string;
  /** The worker needs a protocol or feature this child lacks: the child runs nothing. */
  refused: boolean;
  /** The one-line history entry and warning naming both builds and the decision. */
  note: string;
}

/**
 * Compares this job child's build with the spawning worker's. Null when the
 * builds match, or the worker sent none (a worker older than #7245) or an
 * unreadable value: nothing to report. A differing version alone runs the job
 * (the compatible protocol is what both sides read); a protocol mismatch or a
 * missing required feature refuses it, like the startup handshake does.
 */
export function jobChildBuildVerdict(raw: string | undefined, workerPid: number): JobChildBuildVerdict | null {
  if (!raw) return null;
  let parent: { version?: unknown; protocol_version?: unknown; features?: unknown };
  try { parent = JSON.parse(raw); } catch { return null; }
  if (!parent || typeof parent.version !== 'string' || !/^\d+(?:\.\d+){2,3}$/.test(parent.version)) return null;
  const features = Array.isArray(parent.features) ? parent.features.filter((f): f is string => typeof f === 'string') : [];
  const missing = features.filter(feature => !(CHILD_READINESS_FEATURES as readonly string[]).includes(feature));
  const protocolMismatch = parent.protocol_version !== CHILD_READINESS_PROTOCOL_VERSION;
  if (parent.version === VERSION && !protocolMismatch && !missing.length) return null;
  const builds = `job child v${VERSION} ${protocolMismatch || missing.length ? 'refused to run' : 'ran'} under worker pid ${workerPid} v${parent.version}`;
  if (!protocolMismatch && !missing.length) {
    return { worker_version: parent.version, refused: false,
      note: `${JOB_BUILD_SKEW_PREFIX} ${builds}; the readiness protocol and every feature the worker needs match, so the job ran on the child's build. Restart the worker to run one build (foresights doctor --only runtime_build_skew).` };
  }
  const why = protocolMismatch ? `the worker speaks readiness protocol ${String(parent.protocol_version)} and this child ${CHILD_READINESS_PROTOCOL_VERSION}` : `this child lacks ${missing.join(', ')}`;
  return { worker_version: parent.version, refused: true,
    note: `${JOB_BUILD_SKEW_PREFIX} ${builds}: ${why}. The job is released without counting an attempt and the worker stops on a configuration block until it restarts on one build (foresights doctor --only runtime_build_skew).` };
}

export interface ChildReadinessOptions {
  invocation: ChildCliInvocation;
  tiniPath: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function parseChildReadiness(raw: string): { version: string; versionSkew: boolean; features: string[] } {
  let response: unknown;
  try { response = JSON.parse(raw); } catch {
    throw childConfigurationError('child_protocol_incompatible');
  }
  if (!response || typeof response !== 'object') throw childConfigurationError('child_protocol_incompatible');
  const r = response as Record<string, unknown>;
  if (r.protocolVersion !== CHILD_READINESS_PROTOCOL_VERSION ||
      typeof r.version !== 'string' || !/^\d+(?:\.\d+){2,3}$/.test(r.version) || r.version.length > 80 ||
      !Array.isArray(r.features) || !r.features.every((feature) => typeof feature === 'string') ||
      !REQUIRED_CHILD_FEATURES.every((feature) => (r.features as unknown[]).includes(feature))) {
    throw childConfigurationError('child_protocol_incompatible');
  }
  if (r.status === 'configuration_error' && isChildConfigurationReason(r.reasonCode)) {
    throw childConfigurationError(r.reasonCode);
  }
  if (r.status === 'transient_error') throw new Error('Selected job child readiness failed transiently; no jobs were admitted.');
  if (r.status !== 'ready') throw childConfigurationError('child_protocol_incompatible');
  return { version: r.version, versionSkew: r.version !== VERSION, features: r.features as string[] };
}

/**
 * Runs the selected child's readiness handshake under a deadline.
 *
 * Timeout contract: at `timeoutMs - min(250, timeoutMs / 10)` the selected
 * process is SIGKILLed. Beneath tini that means every process group tini
 * started (the selected grandchild), and tini then reaps the grandchild and
 * exits. The confirmed failure ("timed out; no jobs were admitted") settles
 * only from the wrapper's `close`, so the selected process has already exited
 * and been reaped (or is a zombie awaiting its new parent). If `close` does not
 * arrive by `timeoutMs`, the call settles with "cleanup unconfirmed" and makes
 * no claim about the process.
 */
export async function checkChildReadiness(options: ChildReadinessOptions): Promise<{ version: string; versionSkew: boolean; features: string[] }> {
  const timeoutMs = options.timeoutMs ?? CHILD_READINESS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid child readiness deadline.');
  if (options.signal?.aborted) throw new Error('Selected job child readiness was interrupted.');
  const executable = validateChildExecutable(options.invocation.cmd, options.env ?? process.env);
  const invocation = buildSpawnInvocation(options.tiniPath, executable, [
    ...options.invocation.argsPrefix, 'jobs', 'child-readiness', '--json',
  ]);
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingFailure: Error | undefined;
    let groupObserver: ReturnType<typeof setInterval> | undefined;
    const processGroups = new Set<number>();
    let child: ReturnType<typeof spawn>;
    const finish = (error?: unknown, result?: { version: string; versionSkew: boolean; features: string[] }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      if (groupObserver) clearInterval(groupObserver);
      options.signal?.removeEventListener('abort', interrupt);
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (forceWrapper = false): void => {
      if (child?.pid) {
        if (options.tiniPath) observeTiniChildProcessGroups(child.pid, processGroups);
        for (const group of processGroups) killProcessGroup(group, 'SIGKILL');
        if (options.tiniPath && processGroups.size > 0 && !forceWrapper) return;
        killProcessGroup(child.pid, 'SIGKILL');
      }
      try { child?.kill('SIGKILL'); } catch {}
    };
    const interrupt = (): void => {
      pendingFailure = new Error('Selected job child readiness was interrupted; no jobs were admitted.');
      stop();
    };
    const spawnError = (error: unknown): void => {
      const code = (error as NodeJS.ErrnoException)?.code;
      finish(code === 'ENOENT' || code === 'EACCES'
        ? childConfigurationError('child_executable_invalid')
        : new Error('Selected job child readiness transport failed; no jobs were admitted.'));
    };
    try {
      child = spawn(invocation.cmd, invocation.args, {
        env: options.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { spawnError(error); return; }
    if (options.tiniPath) groupObserver = setInterval(() => {
      if (child.pid) observeTiniChildProcessGroups(child.pid, processGroups);
      if (processGroups.size > 0 && groupObserver) clearInterval(groupObserver);
    }, 25);
    const capture = (chunk: Buffer, stdout: boolean): void => {
      if (settled || pendingFailure) return;
      bytes += chunk.length;
      if (bytes > CHILD_READINESS_MAX_BYTES) {
        pendingFailure = new Error('Selected job child readiness exceeded its combined output limit; the unfinished handshake is transient.');
        stop();
        return;
      }
      if (stdout) chunks.push(chunk);
    };
    child.stdout!.on('data', (chunk: Buffer) => capture(chunk, true));
    child.stderr!.on('data', (chunk: Buffer) => capture(chunk, false));
    child.once('error', spawnError);
    child.once('close', (code, signal) => {
      if (settled) return;
      if (pendingFailure) { finish(pendingFailure); return; }
      if (signal || code === null || (code >= 128 && code <= 192)) {
        finish(new Error('Selected job child readiness ended before completion.'));
        return;
      }
      try {
        if (code === 126 || code === 127) validateChildExecutable(executable, options.env ?? process.env);
        const result = parseChildReadiness(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0) { finish(new Error('Selected job child readiness did not complete successfully.')); return; }
        finish(undefined, result);
      } catch (error) { finish(error); }
    });
    options.signal?.addEventListener('abort', interrupt, { once: true });
    stopTimer = setTimeout(() => {
      pendingFailure ??= new Error('Selected job child readiness timed out; no jobs were admitted.');
      stop();
    }, Math.max(1, timeoutMs - Math.min(250, timeoutMs / 10)));
    timer = setTimeout(() => {
      stop(true);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(new Error('Selected job child readiness timed out with subprocess cleanup unconfirmed; no jobs were admitted.'));
    }, timeoutMs);
    if (options.signal?.aborted) interrupt();
  });
}

export function writeChildReadinessFailure(error: unknown): number {
  const permanent = isLocalConfigurationError(error);
  process.stdout.write(JSON.stringify({
    protocolVersion: CHILD_READINESS_PROTOCOL_VERSION, version: VERSION,
    features: CHILD_READINESS_FEATURES,
    status: permanent ? 'configuration_error' : 'transient_error',
    ...(permanent ? { reasonCode: error.reasonCode } : {}),
  }) + '\n');
  return permanent ? WORKER_EXIT_CONFIGURATION : 1;
}

export async function runChildReadinessEntry(
  engine: BrainEngine,
  check: (engine: BrainEngine) => Promise<void>,
): Promise<number> {
  try {
    await check(engine);
    process.stdout.write(JSON.stringify({
      protocolVersion: CHILD_READINESS_PROTOCOL_VERSION, version: VERSION,
      features: CHILD_READINESS_FEATURES, status: 'ready',
    }) + '\n');
    return 0;
  } catch (error) { return writeChildReadinessFailure(error); }
}
