/**
 * `shell` job handler.
 *
 * Runs an arbitrary shell command or argv vector as a child process under the
 * Minions worker. Purpose: move deterministic cron scripts (API fetch, token
 * refresh, scrape + write) off the LLM gateway so they don't consume an Opus
 * session each time.
 *
 * Security (both gates must pass):
 *   1. `MinionQueue.add()` rejects name='shell' unless the caller explicitly
 *      opts in via `trusted.allowProtectedSubmit`. CLI path and the `submit_job`
 *      operation (when `ctx.remote === false`) set the flag. MCP callers don't.
 *   2. This handler only registers when `process.env.GBRAIN_ALLOW_SHELL_JOBS === '1'`.
 *      Default: off. Without the flag the worker's `registeredNames` excludes
 *      shell and queued jobs stay in 'waiting'.
 *
 * Env model (honest): the child process receives a small allowlist (PATH, HOME,
 * USER, LANG, TZ, NODE_ENV) merged with caller-supplied `job.data.env`. This
 * prevents the accidental `$OPENAI_API_KEY` interpolation footgun. It does NOT
 * sandbox filesystem reads — a shell script can `cat ~/.env` or any file the
 * worker can read. The operator picks a safe `cwd`; that's the trust boundary.
 *
 * Shutdown: the handler listens to BOTH `ctx.signal` (timeout/cancel/lock-loss)
 * and `ctx.shutdownSignal` (worker process SIGTERM). Either triggers the same
 * kill sequence: SIGTERM → 5s grace → SIGKILL. Non-shell handlers ignore
 * `shutdownSignal` so deploy restarts don't interrupt them mid-flight.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';

/** Environment variables passed through to shell children by default. Callers
 *  that need additional keys (e.g. a specific API token for a cron) must name
 *  them explicitly in `job.data.env`. Named keys override this allowlist. */
const SHELL_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'NODE_ENV'] as const;

/** Max bytes retained from stdout/stderr. Output exceeding these caps is
 *  truncated with a `[truncated N bytes]` marker. UTF-8-safe via StringDecoder. */
const STDOUT_TAIL_MAX_BYTES = 64 * 1024;
const STDERR_TAIL_MAX_BYTES = 16 * 1024;

/** Grace period between SIGTERM and SIGKILL. Well-behaved scripts catch SIGTERM,
 *  flush state, exit cleanly; non-behaving scripts get reaped. */
const KILL_GRACE_MS = 5000;

export interface ShellJobParams {
  /** Shell command. Spawned via `/bin/sh -c cmd`. Exactly one of cmd or argv is required. */
  cmd?: string;
  /** Argv vector. Spawned directly without a shell. Exactly one of cmd or argv is required. */
  argv?: string[];
  /** Working directory. REQUIRED, must be an absolute path. The operator chooses
   *  this; it's the trust boundary for what files the script can read/write. */
  cwd: string;
  /** Additional env vars to pass to the child. Merged on top of SHELL_ENV_ALLOWLIST. */
  env?: Record<string, string>;
}

export interface ShellJobResult {
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
  duration_ms: number;
  pid: number;
}

/** Validate and narrow `job.data` to ShellJobParams. Throws UnrecoverableError
 *  for misshapen input — validation failures are not retry-worthy. */
function validateParams(data: Record<string, unknown>): ShellJobParams {
  const hasCmd = typeof data.cmd === 'string' && data.cmd.length > 0;
  const hasArgv = Array.isArray(data.argv) && data.argv.length > 0;

  if (hasCmd && hasArgv) {
    throw new UnrecoverableError(
      'shell: specify exactly one of cmd or argv (see: docs/guides/minions-shell-jobs.md#errors)',
    );
  }
  if (!hasCmd && !hasArgv) {
    throw new UnrecoverableError(
      'shell: specify exactly one of cmd or argv (see: docs/guides/minions-shell-jobs.md#errors)',
    );
  }
  if (hasArgv) {
    const argvOk = (data.argv as unknown[]).every((a) => typeof a === 'string');
    if (!argvOk) {
      throw new UnrecoverableError(
        'shell: argv must be an array of strings (see: docs/guides/minions-shell-jobs.md#errors)',
      );
    }
  }
  if (typeof data.cwd !== 'string' || data.cwd.length === 0) {
    throw new UnrecoverableError(
      'shell: cwd is required and must be an absolute path (see: docs/guides/minions-shell-jobs.md#errors)',
    );
  }
  if (!path.isAbsolute(data.cwd)) {
    throw new UnrecoverableError(
      'shell: cwd is required and must be an absolute path (see: docs/guides/minions-shell-jobs.md#errors)',
    );
  }
  if (data.env !== undefined) {
    if (typeof data.env !== 'object' || data.env === null || Array.isArray(data.env)) {
      throw new UnrecoverableError(
        'shell: env must be an object of string values (see: docs/guides/minions-shell-jobs.md#errors)',
      );
    }
    for (const v of Object.values(data.env as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new UnrecoverableError(
          'shell: env values must all be strings (see: docs/guides/minions-shell-jobs.md#errors)',
        );
      }
    }
  }

  return {
    cmd: hasCmd ? (data.cmd as string) : undefined,
    argv: hasArgv ? (data.argv as string[]) : undefined,
    cwd: data.cwd,
    env: (data.env as Record<string, string> | undefined),
  };
}

/** Build the child process env: SHELL_ENV_ALLOWLIST picked from process.env,
 *  overlaid with caller-supplied `job.data.env`. Prevents accidental leak of
 *  OPENAI_API_KEY / DATABASE_URL / etc. into user-authored scripts. */
function buildChildEnv(override: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SHELL_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === 'string') env[key] = v;
  }
  if (override) {
    for (const [k, v] of Object.entries(override)) env[k] = v;
  }
  return env;
}

/** Bounded-length UTF-8-safe tail buffer. Accumulates bytes via StringDecoder
 *  so the last `maxBytes` of output is character-safe (no split multibyte chars).
 *  On truncation, the emitted string is prefixed with `[truncated N bytes]`. */
class TailBuffer {
  private decoder = new StringDecoder('utf8');
  private body = '';
  private bodyBytes = 0;
  private truncatedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    const str = this.decoder.write(chunk);
    if (str.length === 0) return;
    this.body += str;
    this.bodyBytes = Buffer.byteLength(this.body, 'utf8');
    this.compactIfOver();
  }

  private compactIfOver(): void {
    if (this.bodyBytes <= this.maxBytes) return;
    // We need to keep only the trailing maxBytes. Byte-slicing mid-character is
    // unsafe; instead, find the highest character offset whose byte length from
    // that point is <= maxBytes. Linear-scan from the end over grapheme-safe
    // codepoints is good enough at 64KB scales.
    const targetByteSize = this.maxBytes;
    // Fast path: if body is all ASCII (1 byte per char), byteLength === length.
    if (this.body.length === this.bodyBytes) {
      const drop = this.bodyBytes - targetByteSize;
      this.truncatedBytes += drop;
      this.body = this.body.slice(drop);
      this.bodyBytes = targetByteSize;
      return;
    }
    // Slow path: find a character boundary that lands just under maxBytes.
    // Scan from the end; accumulate bytes per codepoint.
    let tailBytes = 0;
    let cut = this.body.length;
    for (let i = this.body.length - 1; i >= 0; i--) {
      const code = this.body.codePointAt(i);
      const cpBytes = code === undefined ? 0
        : code < 0x80 ? 1
        : code < 0x800 ? 2
        : code < 0x10000 ? 3
        : 4;
      if (tailBytes + cpBytes > targetByteSize) break;
      tailBytes += cpBytes;
      cut = i;
    }
    const droppedBytes = this.bodyBytes - tailBytes;
    this.truncatedBytes += droppedBytes;
    this.body = this.body.slice(cut);
    this.bodyBytes = tailBytes;
  }

  done(): string {
    const tail = this.decoder.end();
    if (tail.length > 0) {
      this.body += tail;
      this.bodyBytes = Buffer.byteLength(this.body, 'utf8');
      this.compactIfOver();
    }
    if (this.truncatedBytes === 0) return this.body;
    return `[truncated ${this.truncatedBytes} bytes]\n${this.body}`;
  }
}

/** The shell handler itself. */
export async function shellHandler(ctx: MinionJobContext): Promise<ShellJobResult> {
  const params = validateParams(ctx.data);
  const env = buildChildEnv(params.env);
  const startedAt = Date.now();

  let proc: ChildProcess;
  try {
    if (params.cmd) {
      // Absolute /bin/sh — not 'sh' — so a caller-supplied env with a poisoned
      // PATH can't redirect to a different shell binary.
      proc = spawn('/bin/sh', ['-c', params.cmd], {
        cwd: params.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      const argv = params.argv!;
      proc = spawn(argv[0], argv.slice(1), {
        cwd: params.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch (err) {
    // Spawn-phase failure (e.g. cwd doesn't exist when using '/bin/sh' directly).
    // Retryable.
    throw err instanceof Error ? err : new Error(String(err));
  }

  const pid = proc.pid ?? -1;
  const stdoutTail = new TailBuffer(STDOUT_TAIL_MAX_BYTES);
  const stderrTail = new TailBuffer(STDERR_TAIL_MAX_BYTES);

  proc.stdout?.on('data', (c: Buffer) => stdoutTail.append(c));
  proc.stderr?.on('data', (c: Buffer) => stderrTail.append(c));

  // Wire BOTH signals to the kill sequence. `ctx.signal` fires on timeout /
  // cancel / lock-loss; `ctx.shutdownSignal` fires only on worker SIGTERM/SIGINT.
  // Shell handler needs both — a deploy restart shouldn't leave children running
  // past the 30s worker cleanup race.
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let killReason = '';
  const onAbort = (label: string) => () => {
    if (killTimer !== null) return; // already started
    killReason = label;
    if (!proc.killed) {
      try { proc.kill('SIGTERM'); } catch { /* proc already exited */ }
    }
    killTimer = setTimeout(() => {
      if (!proc.killed) {
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
      }
    }, KILL_GRACE_MS);
  };
  const sigAbort = onAbort('signal');
  const shutdownAbort = onAbort('shutdown');
  ctx.signal.addEventListener('abort', sigAbort);
  ctx.shutdownSignal.addEventListener('abort', shutdownAbort);

  // Fire immediately if either already aborted before wiring
  if (ctx.signal.aborted) sigAbort();
  if (ctx.shutdownSignal.aborted) shutdownAbort();

  const exitCode: number = await new Promise<number>((resolve, reject) => {
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('exit', (code, signal) => {
      // Node maps signal-terminated exits to a 128+N code convention; we use
      // whichever is defined.
      if (code !== null) resolve(code);
      else if (signal === 'SIGTERM') resolve(143);
      else if (signal === 'SIGKILL') resolve(137);
      else resolve(-1);
    });
  }).finally(() => {
    if (killTimer !== null) clearTimeout(killTimer);
    ctx.signal.removeEventListener('abort', sigAbort);
    ctx.shutdownSignal.removeEventListener('abort', shutdownAbort);
  });

  const duration_ms = Date.now() - startedAt;
  const stdout_tail = stdoutTail.done();
  const stderr_tail = stderrTail.done();

  // If we sent SIGTERM/SIGKILL in response to an abort, surface that as the
  // error rather than the exit code — clearer for debugging. Worker catch
  // handles retry/dead classification.
  if (killReason === 'signal' || killReason === 'shutdown') {
    const err = new Error(
      `aborted: ${killReason === 'shutdown' ? 'shutdown' : (ctx.signal.reason as Error)?.message || 'signal'}`,
    );
    throw err;
  }

  if (exitCode !== 0) {
    throw new Error(
      `exit ${exitCode}: ${stderr_tail.slice(-500)}`,
    );
  }

  return { exit_code: exitCode, stdout_tail, stderr_tail, duration_ms, pid };
}
