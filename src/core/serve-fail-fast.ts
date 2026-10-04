/**
 * `gbrain serve --fail-fast` / `GBRAIN_SERVE_FAIL_FAST=1` (agent operator
 * wave C10): for process supervisors. When serve cannot start (the brain is
 * missing, its lock is held by another serve, the database is unreachable),
 * it exits non-zero with the classified error envelope on stderr instead of
 * staying up in status-only (F4) or degraded mode, so the supervisor's
 * restart policy sees the failure.
 */
import { renderCliError } from './agent-output.ts';

const truthy = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

export function serveFailFastRequested(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const end = args.indexOf('--');
  return (end >= 0 ? args.slice(0, end) : args).includes('--fail-fast') || truthy(env.GBRAIN_SERVE_FAIL_FAST);
}

/** Write the classified envelope (JSON, one document) to stderr; returns the exit code (never 0). */
export function writeServeFailFastEnvelope(e: unknown, write: (s: string) => void = s => { process.stderr.write(s); }): number {
  const out = renderCliError(e, { json: true, command: 'serve', tty: false });
  write(out.stdout ?? '');
  return out.exitCode === 0 ? 1 : out.exitCode;
}
