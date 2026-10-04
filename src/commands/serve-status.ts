/**
 * Status-only stdio serve entry (agent operator contract v1, F4): cli.ts
 * hands over a `gbrain serve` whose brain cannot be opened (lock held by a
 * live holder, no brain, unreadable config). The server completes the MCP
 * handshake with one `gbrain_status` tool instead of exiting; a later tool
 * call recovers in place through the gated lazy engine (src/mcp/status-mode.ts).
 *
 * Not for `--http` (an HTTP serve is a supervised daemon; its contention is
 * the bind/lock error), and skipped under `--fail-fast` /
 * GBRAIN_SERVE_FAIL_FAST=1 so supervisors keep a non-zero exit (C10).
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { gatedReconnect, initialStatusState, markStatusModeEngine, probeStatus, statusHeadline, type StatusReason } from '../mcp/status-mode.ts';

export function serveFailFast(args: readonly string[]): boolean {
  return args.includes('--fail-fast') || process.env.GBRAIN_SERVE_FAIL_FAST === '1';
}

/** Whether this `serve` invocation takes the status-only path on a startup failure. */
export function statusModeEligible(args: readonly string[], hostBrain: boolean): boolean {
  return hostBrain && !args.includes('--http') && !serveFailFast(args);
}

/**
 * Before any connect (file reads only): no config, a configured PGLite brain
 * whose data dir is missing (never created empty here), or a brain whose
 * automatic repair failed. Lock contention is left to the connect error.
 */
export function preConnectStatusReason(): StatusReason | null {
  if (!loadConfig()) return 'no_brain';
  const probed = probeStatus();
  return probed && (probed.reason === 'missing_brain' || probed.reason === 'repair_failed') ? probed.reason : null;
}

/** Map a connect failure to a status reason; null when status mode does not apply. */
export function statusReasonForError(e: unknown): StatusReason | null {
  if ((e as { code?: unknown } | null)?.code === 'pglite_busy') return 'lock_held';
  // The brain's sibling writer-lock file cannot be opened (missing parent, read-only drive, permissions).
  if (/Cannot open the stable writer lock file/.test(String((e as Error | null)?.message ?? ''))) return 'brain_unopenable';
  return null;
}

/** Run the stdio server over a gated lazy engine; resolves when serve's lifecycle does. */
export async function runStatusModeServe(
  reason: StatusReason, initialError: unknown, args: string[], connect: () => Promise<BrainEngine>,
): Promise<void> {
  const state = initialStatusState(reason);
  const { createDegradedEngine } = await import('../core/degraded-engine.ts');
  const kind = loadConfig()?.engine === 'postgres' ? 'postgres' : 'pglite';
  const engine = markStatusModeEngine(createDegradedEngine({
    initialError: initialError ?? new Error(statusHeadline(state)),
    reconnect: () => gatedReconnect(state, connect),
    // A PGLite open + pending migrations can take longer than the degraded default.
    callerWaitMs: 20_000,
    kind,
  }), state);
  const { runServe } = await import('./serve.ts');
  await runServe(engine, args);
}
