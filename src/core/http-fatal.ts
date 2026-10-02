/**
 * Hosted HTTP fatal exit.
 *
 * `gbrain serve --http` must not stay up as a zombie after an unhandled
 * rejection. The process-wide cleanup handler logs `[unhandledRejection]`
 * and only then calls `process.exit` from an async cleanup pass. If that
 * pass waits on the same saturated pool that produced the rejection, the
 * log line is the last thing the platform sees and the process stays
 * online. This handler exits synchronously so the host (Railway, Fly, a
 * supervisor) can restart.
 *
 * Caught failures never reach it. Search arms that fail open on a
 * statement timeout, and any other `try/catch` around a 57014, do not
 * emit `unhandledRejection`. Do not call `process.exit` from those paths.
 *
 * An unhandled user-request cancel (also SQLSTATE 57014) still exits,
 * but it is not labeled a statement timeout. Intentional cancels that
 * are caught stay caught.
 */
import { getMessage, isStatementTimeoutError } from './retry-matcher.ts';

export function isUserRequestCancel(reason: unknown): boolean {
  return /canceling statement due to user request/i.test(getMessage(reason));
}

/** Unhandled statement_timeout, not a user-request cancel. */
export function isFatalStatementTimeout(reason: unknown): boolean {
  if (isUserRequestCancel(reason)) return false;
  return isStatementTimeoutError(reason);
}

export function formatHostedHttpFatal(kind: 'unhandledRejection' | 'uncaughtException', reason: unknown): string {
  if (isFatalStatementTimeout(reason)) {
    return '[hosted-http] fatal statement timeout (57014); exiting so the host can restart\n';
  }
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  return `[hosted-http] ${kind}; exiting so the host can restart: ${detail}\n`;
}

export interface FatalHandlerTarget {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
  off(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
}

export interface InstallFatalHandlersOpts {
  target?: FatalHandlerTarget;
  exit?: (code: number) => void;
  log?: (line: string) => void;
}

/** Returns an unsubscribe. The first fatal event exits; later events are ignored. */
export function installHostedHttpFatalHandlers(opts: InstallFatalHandlersOpts = {}): () => void {
  const target = opts.target ?? process;
  const exit = opts.exit ?? ((code: number) => { process.exit(code); });
  const log = opts.log ?? ((line: string) => {
    try { process.stderr.write(line); } catch { /* stderr may already be broken */ }
  });
  let exited = false;
  const fire = (kind: 'unhandledRejection' | 'uncaughtException', reason: unknown) => {
    if (exited) return;
    exited = true;
    log(formatHostedHttpFatal(kind, reason));
    exit(1);
  };
  const onRejection = (reason: unknown) => { fire('unhandledRejection', reason); };
  const onException = (error: unknown) => { fire('uncaughtException', error); };
  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);
  return () => {
    target.off('unhandledRejection', onRejection);
    target.off('uncaughtException', onException);
  };
}
