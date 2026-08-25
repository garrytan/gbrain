/**
 * #4418 — durable stderr sink + spawn helper for `gbrain jobs supervisor
 * start --detach`.
 *
 * The detach path used to re-exec the supervisor with
 * `stdio: ['ignore','ignore','inherit']`: the detached supervisor inherited
 * the INVOKER's stderr, and its worker (ChildWorkerSupervisor spawns with
 * `stdio: 'inherit'`) inherited that same descriptor. When a short-lived
 * automation runner closed its capture pipe after the start payload
 * returned, the worker exited 141 (SIGPIPE) on its next stderr write, and
 * the supervisor — writing its crash/backoff event to the same closed
 * stream — could die too, leaving active jobs and DB locks stale while
 * producers kept enqueueing.
 *
 * Fix: give the detached supervisor a durable sink — an append-mode log in
 * the audit dir (`${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/supervisor-stderr.log`,
 * next to the JSONL lifecycle audit), falling back to the null device, then
 * to 'ignore'. The worker inherits the supervisor's fd, so ONE durable
 * descriptor covers both processes — not a per-call EPIPE swallow.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAuditDir } from '../audit/audit-writer.ts';

export interface DetachedStderrSink {
  /** fd to pass as the child's stdio[2]; 'ignore' when nothing could be opened. */
  fd: number | 'ignore';
  /** Human-readable location for the start payload; null when 'ignore'. */
  path: string | null;
}

const NULL_DEVICE = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';

/**
 * Open the durable sink: audit-dir log (append) → null device → 'ignore'.
 * Never throws — a sink failure must not block the supervisor start.
 */
export function openDetachedStderrSink(logName = 'supervisor-stderr.log'): DetachedStderrSink {
  try {
    const dir = resolveAuditDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, logName);
    return { fd: openSync(path, 'a'), path };
  } catch {
    /* fall through to the null device */
  }
  try {
    return { fd: openSync(NULL_DEVICE, 'w'), path: NULL_DEVICE };
  } catch {
    return { fd: 'ignore', path: null };
  }
}

/** Close the parent's copy of the sink fd after spawn (the child holds its own dup). */
export function closeDetachedStderrSink(sink: DetachedStderrSink): void {
  if (typeof sink.fd === 'number') {
    try {
      closeSync(sink.fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Re-exec the CLI as a fully detached supervisor: stdin/stdout ignored,
 * stderr on the durable sink (NEVER 'inherit' — the #4418 regression).
 */
export function spawnDetachedSupervisor(
  execPath: string,
  cliScript: string,
  childArgs: string[],
): { pid: number | undefined; stderrPath: string | null } {
  const sink = openDetachedStderrSink();
  const child = spawn(execPath, [cliScript, ...childArgs], {
    detached: true,
    stdio: ['ignore', 'ignore', sink.fd],
    env: process.env,
  });
  child.unref();
  closeDetachedStderrSink(sink);
  return { pid: child.pid, stderrPath: sink.path };
}
