/**
 * `gbrain init --json` result writer (agent contract v1 D2). init has several
 * branches (PGLite, Postgres, thin client, migrate-only, the
 * `--prefer-postgres` ladder) and the ladder wraps an inner init, so the
 * success document is accumulated here and written ONCE through
 * writeStdoutFinal when runInit returns. Error documents keep their legacy
 * one-line keys (`status`, `reason`, …) and gain the v1 envelope through
 * writeCliError. Under the `--json` guard every other stdout write goes to
 * stderr.
 */
import { writeStdoutFinal } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';
import type { RegistryCode } from '../core/error-registry.ts';
import { writeCliError } from '../cli/cli-error.ts';

let pending: Record<string, unknown> | null = null;

/**
 * Record (merge into) the success document. `replace` starts it over (the
 * ladder's envelope) keeping only the first-run `notices` / `contract_version`.
 */
export function setInitJsonResult(doc: Record<string, unknown>, opts: { replace?: boolean } = {}): void {
  if (!opts.replace) { pending = { ...(pending ?? {}), ...doc }; return; }
  const keep = Object.fromEntries(Object.entries(pending ?? {}).filter(([k]) => k === 'notices' || k === 'contract_version'));
  pending = { ...doc, ...keep };
  deferred = null;
}

/** Write the accumulated success document (one line, as before) and clear it. */
export async function flushInitJsonResult(): Promise<void> {
  if (!pending) return;
  const doc = pending;
  pending = null;
  await writeStdoutFinal(`${JSON.stringify(doc)}\n`);
}

/** An init failure under --json: legacy keys + the v1 envelope on stdout, human lines on stderr. Returns the exit code. */
export function initJsonError(legacy: Record<string, unknown>, code: RegistryCode, message: string, suggestion: string): number {
  pending = null;
  return writeCliError(opError(code, message, suggestion), 'init', { legacy, json: true });
}

let deferred: { legacy: Record<string, unknown>; code: RegistryCode; message: string; suggestion: string } | null = null;

/**
 * A Postgres-core failure: the `--prefer-postgres` ladder treats it as a rung
 * failure and moves on, so it is held until the direct `--url`/`--supabase`
 * wrapper writes it (writeDeferredInitJsonError) or the ladder replaces it.
 */
export function deferInitJsonError(legacy: Record<string, unknown>, code: RegistryCode, message: string, suggestion: string): void {
  deferred = { legacy, code, message, suggestion };
}

/** Write the held failure; returns its exit code, or null when none is held. */
export function writeDeferredInitJsonError(): number | null {
  if (!deferred) return null;
  const d = deferred;
  deferred = null;
  return initJsonError(d.legacy, d.code, d.message, d.suggestion);
}
