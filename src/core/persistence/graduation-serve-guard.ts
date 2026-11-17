/**
 * Engine graduation and long-lived servers (plan §6.4). File reads only:
 * the intent marker and tombstone through `inspectGraduationPath`, and the
 * durable config. Never a lock attempt, never a write.
 *
 * - `serveGraduationStartRefusal`: a `foresights serve` (re)launched while a
 *   graduation run owns the brain exits with `graduation_in_progress`
 *   (exit 75) instead of entering status-only mode and later reconnecting to
 *   the abandoned path.
 * - `graduationStatusReason`: a serve whose config still names a graduated
 *   PGLite path (stale MCP config) stays in status-only mode and answers
 *   with `engine_graduated` and its one-step fix.
 * - `exitOnEngineIdentityChange`: a status-only or degraded serve re-resolves
 *   config on each reconnect attempt and exits for relaunch when the engine
 *   identity changed, a tombstone appeared, or a run started (a serve that
 *   started without any config keeps recovering in place).
 * - `graduationHandoffRequested`: a resident PGLite serve sees a live run's
 *   marker and hands the brain over (it shuts down and exits 75).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderCliError } from '../agent-output.ts';
import { gbrainPath, loadConfig, type GBrainConfig } from '../config.ts';
import type { OperationError } from '../ops/contract.ts';
import { engineGraduatedFor, inspectGraduationPath } from './graduation-custody.ts';
import { inProgressError } from './graduation-errors.ts';
import type { GraduationManifest, GraduationPathState, ManifestState } from './engine-graduation.types.ts';

export const GRADUATION_SERVE_EXIT = 75;

/** The host brain's PGLite data dir, or null (Postgres, thin client, no config). */
export function hostPgliteDataDir(cfg: GBrainConfig | null = loadConfig()): string | null {
  if (!cfg || cfg.database_url || (cfg.engine ?? 'pglite') !== 'pglite' || cfg.remote_mcp) return null;
  return cfg.database_path ?? gbrainPath('brain.pglite');
}

function pathState(cfg: GBrainConfig | null): GraduationPathState | null {
  const dataDir = hostPgliteDataDir(cfg);
  return dataDir ? inspectGraduationPath(dataDir) : null;
}

/** `graduation_in_progress` when another process is graduating the host brain; null otherwise. */
export function serveGraduationStartRefusal(cfg: GBrainConfig | null = loadConfig()): OperationError | null {
  const st = pathState(cfg);
  if (st?.state !== 'in_progress' || st.marker?.pid === process.pid) return null;
  return inProgressError({ runId: st.marker?.runId, state: st.marker?.state, pid: st.marker?.pid, dataDir: st.dataDir });
}

/** The status-only reason for a graduated (tombstoned) host path, with its refusal. */
export function graduationStatusReason(cfg: GBrainConfig | null = loadConfig()): { reason: 'engine_graduated'; error: OperationError; dataDir: string } | null {
  const st = pathState(cfg);
  if (st?.state !== 'graduated') return null;
  return { reason: 'engine_graduated', dataDir: st.dataDir, error: engineGraduatedFor(st, 'stdio') };
}

export { engineGraduatedFor };

/** The engine a config routes to, hashed (the URL may carry a password; only its hash is kept); null without a config. */
export function engineIdentity(cfg: GBrainConfig | null = loadConfig()): string | null {
  if (!cfg) return null;
  const route = [cfg.engine ?? 'pglite', cfg.database_url ?? '', cfg.database_url ? '' : (cfg.database_path ?? gbrainPath('brain.pglite'))];
  return createHash('sha256').update(JSON.stringify(route)).digest('hex');
}

/** Write the classified envelope (one JSON document) to stderr and return the exit code. */
export function writeServeGraduationEnvelope(e: OperationError, write: (s: string) => void = s => { process.stderr.write(s); }): number {
  write(renderCliError(e, { json: true, command: 'serve', tty: false }).stdout ?? '');
  return GRADUATION_SERVE_EXIT;
}

/**
 * Reconnect gate for a status-only or degraded serve: when the engine
 * identity it started with no longer holds (config flipped by a graduation or
 * a rollback), a tombstone appeared, or a run now owns the brain, it exits for
 * relaunch so the next process opens the right engine. Otherwise returns.
 */
export function exitOnEngineIdentityChange(startIdentity: string | null, opts: { exit?: (code: number) => void; log?: (s: string) => void; startedGraduated?: boolean } = {}): void {
  const exit = opts.exit ?? ((code: number) => { process.exit(code); });
  const log = opts.log ?? ((s: string) => { process.stderr.write(s); });
  const cfg = loadConfig();
  const running = serveGraduationStartRefusal(cfg);
  if (running) { exit(writeServeGraduationEnvelope(running, log)); return; }
  // No config at start (status-only no_brain) or now: F4 recovers in place; only a config that names another engine relaunches.
  if (startIdentity === null || cfg === null) return;
  if (engineIdentity(cfg) !== startIdentity) {
    log('foresights serve: the brain\'s engine changed (an engine graduation or rollback flipped the config); exiting so the server is relaunched on the new engine. Restart the MCP client if it does not relaunch servers.\n');
    exit(GRADUATION_SERVE_EXIT);
    return;
  }
  if (!opts.startedGraduated && pathState(cfg)?.state === 'graduated') {
    log('foresights serve: this PGLite brain was moved to Postgres; exiting so the server is relaunched on the new engine. Restart the MCP client if it does not relaunch servers.\n');
    exit(GRADUATION_SERVE_EXIT);
  }
}

/** `foresights serve` startup: exit 75 with the envelope on stderr when another live run owns the host brain. */
export function exitIfGraduationRunning(exit: (code: number) => void = (code) => { process.exit(code); }): void {
  const running = serveGraduationStartRefusal();
  if (running) exit(writeServeGraduationEnvelope(running));
}

/** The degraded serve's reconnect gate: captures the identity now, checks it on each call. */
export function engineIdentityGate(): () => void {
  const start = engineIdentity();
  return () => exitOnEngineIdentityChange(start);
}

/** A resident PGLite serve should hand the brain over: a live graduation run (not this process) wrote its marker. */
export function graduationHandoffRequested(cfg: GBrainConfig | null = loadConfig()): OperationError | null {
  return serveGraduationStartRefusal(cfg);
}

export const GRADUATION_MANIFEST_FILE = 'graduation-manifest.json';
export const TERMINAL_MANIFEST_STATES: ReadonlySet<ManifestState> = new Set(['graduated', 'rolled_back', 'abandoned']);

/** The redacted, file-only view of the 0600 manifest (no URLs); null when absent or unreadable. */
export interface GraduationManifestSummary {
  runId: string;
  state: ManifestState;
  dataDir: string;
  brainId: string;
  target: { host: string; port: number; database: string };
  updatedAt: string;
}

export function readGraduationManifestSummary(home: string = gbrainPath()): GraduationManifestSummary | null {
  try {
    const m = JSON.parse(readFileSync(`${home}/${GRADUATION_MANIFEST_FILE}`, 'utf8')) as Partial<GraduationManifest>;
    if (typeof m.runId !== 'string' || typeof m.state !== 'string' || !m.source?.dataDir || !m.target) return null;
    return { runId: m.runId, state: m.state, dataDir: m.source.dataDir, brainId: m.source.brainId ?? '',
      target: { host: m.target.host, port: m.target.port, database: m.target.database }, updatedAt: m.updatedAt ?? '' };
  } catch {
    return null;
  }
}
