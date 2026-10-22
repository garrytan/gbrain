/**
 * Status-only serve entry (agent operator contract v1, F4): cli.ts hands over
 * a `gbrain serve` (stdio or `--http`) whose brain cannot be opened (lock held
 * by a live holder, no brain, a missing or repair-failed brain, unreadable
 * config). `runStatusModeServe` is the one entry point for both transports and
 * `reprobe` (src/mcp/status-mode.ts) the one re-probe: stdio answers the MCP
 * handshake with one `gbrain_status` tool and re-probes inside tool calls
 * through the gated lazy engine; `--http` serves the status listener
 * (serve-http-status.ts) and re-probes on a 5 s background tick.
 *
 * Skipped under `--fail-fast` / GBRAIN_SERVE_FAIL_FAST=1 so supervisors keep
 * a non-zero exit (C10).
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { initialStatusState, markStatusModeEngine, probeStatus, reprobe, statusHeadline, statusReconnect, type StatusModeState, type StatusReason, type StatusTransport } from '../mcp/status-mode.ts';

export function serveFailFast(args: readonly string[]): boolean {
  return args.includes('--fail-fast') || process.env.GBRAIN_SERVE_FAIL_FAST === '1';
}

/** Whether this `serve` invocation takes the status-only path on a startup failure. */
export function statusModeEligible(args: readonly string[], hostBrain: boolean): boolean {
  return hostBrain && !serveFailFast(args);
}

/**
 * Before any connect (file reads only): no config, a configured PGLite brain
 * whose data dir is missing (never created empty here), or a brain whose
 * automatic repair failed. Lock contention is left to the connect error.
 */
export function preConnectStatusReason(): StatusReason | null {
  if (!loadConfig()) return 'no_brain';
  const probed = probeStatus();
  return probed && (probed.reason === 'missing_brain' || probed.reason === 'repair_failed' || probed.reason === 'engine_graduated') ? probed.reason : null;
}

/** Map a connect failure to a status reason; null when status mode does not apply. */
export function statusReasonForError(e: unknown): StatusReason | null {
  if ((e as { code?: unknown } | null)?.code === 'pglite_busy') return 'lock_held';
  // The brain's sibling writer-lock file cannot be opened (missing parent, read-only drive, permissions).
  if (/Cannot open the stable writer lock file/.test(String((e as Error | null)?.message ?? ''))) return 'brain_unopenable';
  return null;
}

/** One structured stderr line per status-mode transition (host-local: the detailed reason is safe here). */
export function logStatusTransition(event: 'serve_status_mode_enter' | 'serve_status_mode_recovered', state: StatusModeState, transport: StatusTransport, enteredAt: number): void {
  try { process.stderr.write(`${JSON.stringify({ event, reason: state.reason, transport, elapsed_ms: Date.now() - enteredAt })}\n`); } catch { /* stderr gone */ }
}

/**
 * Serve in status-only mode until the brain opens; resolves when serve's
 * lifecycle does. `connect` is throw-only (src/core/engine-connect.ts).
 */
export async function runStatusModeServe(
  reason: StatusReason, initialError: unknown, args: string[], connect: () => Promise<BrainEngine>,
): Promise<void> {
  (await import('../core/serve-log.ts')).installServeLogSink({ http: args.includes('--http') });
  const state = initialStatusState(reason);
  const transport: StatusTransport = args.includes('--http') ? 'http' : 'stdio';
  const enteredAt = Date.now();
  logStatusTransition('serve_status_mode_enter', state, transport, enteredAt);
  // Engine graduation (§6.4): re-resolve config on each re-probe and exit for relaunch on an engine change.
  const { engineIdentity, exitOnEngineIdentityChange } = await import('../core/persistence/graduation-serve-guard.ts');
  const startIdentity = engineIdentity();
  // The one re-probe both transports run; a check that must run on every re-probe hooks here.
  const probeAgain = async (): Promise<BrainEngine | null> => {
    exitOnEngineIdentityChange(startIdentity, { startedGraduated: state.reason === 'engine_graduated' });
    const engine = await reprobe(state, connect);
    if (engine) logStatusTransition('serve_status_mode_recovered', state, transport, enteredAt);
    return engine;
  };
  if (transport === 'http') {
    const { runHttpStatusServe } = await import('./serve-http-status.ts');
    return runHttpStatusServe(state, args, probeAgain);
  }
  const { createDegradedEngine } = await import('../core/degraded-engine.ts');
  const kind = loadConfig()?.engine === 'postgres' ? 'postgres' : 'pglite';
  const engine = markStatusModeEngine(createDegradedEngine({
    initialError: initialError ?? new Error(statusHeadline(state)),
    reconnect: () => statusReconnect(state, probeAgain),
    // A PGLite open + pending migrations can take longer than the degraded default.
    callerWaitMs: 20_000,
    kind,
  }), state);
  const { runServe } = await import('./serve.ts');
  await runServe(engine, args);
}
