/**
 * #6543: what a `gbrain serve` reports about itself beyond `SELECT 1`, and the
 * opt-in exit that lets a supervisor recover a wedged serve without a human.
 *
 * Transport: the live read pool's `prepare` and `max_pipeline` (and why
 * `resolveReadPoolPipeline` chose that pipeline depth), the server
 * `statement_timeout` as read through the pool once at startup (the doctor's
 * `persistence_session_timeouts` probe, so the reading and its ALTER ROLE fix
 * live in one place; its env-URL pooler verdict is not used), and the
 * backend's `application_name` when it is Supavisor. A `0` where gbrain
 * configured a timeout means the startup parameters never applied, so no
 * server-side timeout bounds an autocommit statement. Serve logs the facts as
 * one line at startup and `/health?deep=1` returns them as its `transport`.
 *
 * Exit: `GBRAIN_SERVE_RESTART_REQUIRED_EXIT_SECONDS=<n>` (n >= 120, off by default)
 * makes serve exit with `SERVE_UNHEALTHY_EXIT_CODE` once its persistence
 * consumer has reported `restart_required` (a zombie preparation or a stuck
 * publication: it claims nothing until restart) continuously for n seconds,
 * read in-process. The condition clears when the stuck work settles, and the
 * hold restarts then. The exit is bounded: the consumer's stop waits on the
 * very work that is stuck, so cleanup runs under a deadline and the process
 * exits regardless. A supervisor that restarts on failure (the installed
 * service does) then brings up a fresh one; the floor keeps a restart loop
 * below the unit's `StartLimitBurst=10` per 300 s. A loop guard keeps a
 * durable ledger of self-exits (`serve-self-exit.json` under the gbrain home):
 * after 3 within an hour serve stops exiting, logs `serve_self_exit_suppressed`
 * and `/health?deep=1` reports `self_exit_suppressed`, so a human looks. A
 * pooled statement past the in-flight budget is reported by `/health?deep=1`
 * but never triggers the exit (the variable is named for its one trigger).
 */
import type { BrainEngine } from '../core/engine.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from '../core/config.ts';
import { OperationError } from '../core/ops/contract.ts';
import { SERVE_UNHEALTHY_EXIT_CODE } from '../core/exit-codes.ts';
import { consumerConnectionRoute, type ConsumerConnectionRoute } from '../core/persistence/consumer-lane.ts';
import { persistenceConsumerStatus } from '../core/persistence/service.ts';
import { resolveReadPoolPipeline, type ReadPoolPipelineReason } from '../core/db.ts';
import { sessionTimeoutsCheck } from './doctor/checks/persistence-requests.ts';

export interface ServeTransport {
  pooler_mode: ConsumerConnectionRoute['pooler_mode'];
  /** The live read pool's `prepare` option, null when the engine has no driver pool. */
  prepare: boolean | null;
  /** The live read pool's `max_pipeline` (0: no pipelining), null when the engine has no driver pool. */
  max_pipeline: number | null;
  /** Why the read pool got that depth (`resolveReadPoolPipeline` on the engine's URL); null when the URL is unknown. */
  max_pipeline_reason: ReadPoolPipelineReason | null;
  /** `SHOW statement_timeout` through the read pool at startup; null when it could not be read or none is configured. */
  statement_timeout: string | null;
  /** True when that reading is `0` while gbrain configured a timeout: the startup parameter never reached the server. */
  session_timeouts_not_applied: boolean;
  /** The doctor probe's fix for a session timeout that never applied. */
  fix?: string;
  /** Present when the backend reports Supavisor as its application_name (a Supabase pooler). */
  application_name?: 'Supavisor';
}

const transports = new WeakMap<BrainEngine, ServeTransport>();

/** Reads the transport facts of this engine's read pool (`SHOW statement_timeout`, `SHOW application_name`). */
export async function readServeTransport(engine: BrainEngine): Promise<ServeTransport> {
  const { pooler_mode } = consumerConnectionRoute(engine);
  const options = (engine as { sql?: { options?: { max_pipeline?: unknown; prepare?: unknown } } }).sql?.options;
  const url = (engine as { _savedConfig?: { database_url?: string } })._savedConfig?.database_url;
  const details = ((await sessionTimeoutsCheck(engine)) as { details?: { applied?: unknown; reason?: unknown; role_fix?: unknown } }).details ?? {};
  const notApplied = details.reason === 'session_timeouts_not_applied';
  const [app] = await engine.executeRaw<{ application_name?: string }>('SHOW application_name').catch(() => []);
  return { pooler_mode, prepare: typeof options?.prepare === 'boolean' ? options.prepare : null, max_pipeline: typeof options?.max_pipeline === 'number' ? options.max_pipeline : null,
    max_pipeline_reason: url ? resolveReadPoolPipeline(url).reason : null, statement_timeout: typeof details.applied === 'string' ? details.applied : null,
    session_timeouts_not_applied: notApplied, ...(notApplied && typeof details.role_fix === 'string' ? { fix: details.role_fix } : {}),
    ...(app?.application_name === 'Supavisor' ? { application_name: 'Supavisor' as const } : {}) };
}

export function formatServeTransportLine(t: ServeTransport): string {
  return `[gbrain serve] transport pooler_mode=${t.pooler_mode} prepare=${t.prepare ?? 'unknown'} max_pipeline=${t.max_pipeline ?? 'unknown'}`
    + ` max_pipeline_reason=${t.max_pipeline_reason ?? 'unknown'} statement_timeout=${t.statement_timeout ?? 'unknown'}${t.application_name ? ` application_name=${t.application_name}` : ''}`
    + (t.session_timeouts_not_applied ? ` session_timeouts_not_applied=true fix="${t.fix ?? 'gbrain doctor --json'}" docs=docs/guides/troubleshooting.md#session-timeouts-not-applied` : '');
}

/** Startup: reads the transport once, keeps it for `/health?deep=1` and logs the line. Never throws. */
export async function recordServeTransport(engine: BrainEngine, log: (line: string) => void): Promise<void> {
  try {
    const transport = await readServeTransport(engine);
    transports.set(engine, transport);
    log(formatServeTransportLine(transport));
  } catch { /* best-effort: deep health reports transport: null */ }
}

/** The transport recorded at startup, or null before it was read (or on an engine without one). */
export function serveTransport(engine: BrainEngine): ServeTransport | null {
  return transports.get(engine) ?? null;
}

type ConsumerStatusReader = (engine: BrainEngine) => object;

/** Whether this process's persistence consumer reports `restart_required`, read in-process (`persistenceConsumerStatus`). */
export function consumerRestartRequired(engine: BrainEngine, status: ConsumerStatusReader = persistenceConsumerStatus): boolean {
  return (status(engine) as { restart_required?: unknown }).restart_required === true;
}

export const SERVE_RESTART_REQUIRED_EXIT_ENV = 'GBRAIN_SERVE_RESTART_REQUIRED_EXIT_SECONDS';
export const SERVE_RESTART_REQUIRED_EXIT_FLOOR_SECONDS = 120;
/** The loop guard: past this many self-exits within the window, serve stops exiting and a human has to look. */
export const SERVE_SELF_RESTART_LIMIT = 3;
export const SERVE_SELF_EXIT_WINDOW_MS = 60 * 60 * 1000;
/** The bound on cleanup before the exit fires regardless (serve.ts's CLEANUP_DEADLINE_MS). */
export const SERVE_RESTART_REQUIRED_CLEANUP_DEADLINE_MS = 5_000;

/** Seconds restart_required must hold before serve exits, or null (off). Refuses a value that is not a whole number of at least 120. */
export function resolveRestartRequiredExitSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '0') return null;
  const seconds = /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!(seconds >= SERVE_RESTART_REQUIRED_EXIT_FLOOR_SECONDS)) {
    throw new OperationError('invalid_params', `${SERVE_RESTART_REQUIRED_EXIT_ENV}=${JSON.stringify(raw)} is not a whole number of seconds of at least ${SERVE_RESTART_REQUIRED_EXIT_FLOOR_SECONDS}.`,
      `Set it to ${SERVE_RESTART_REQUIRED_EXIT_FLOOR_SECONDS} or more (a shorter hold would restart serve fast enough to trip the service's start limit of 10 per 300 s), or unset it (or 0) to keep serve running while restart_required.`);
  }
  return seconds;
}

/** The durable self-exit ledger under the gbrain home: ISO timestamps of recent self-exits. */
export function serveSelfExitLedgerPath(): string {
  return gbrainPath('serve-self-exit.json');
}

function readSelfExits(path: string): number[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { exits?: unknown };
    return Array.isArray(parsed.exits) ? parsed.exits.map(at => Date.parse(String(at))).filter(Number.isFinite) : [];
  } catch { return []; }
}

const suppressedEngines = new WeakSet<BrainEngine>();
/** True while this serve's exit is suppressed by the loop guard (restart_required held, but 3 self-exits in the last hour). */
export function selfExitSuppressed(engine: BrainEngine): boolean {
  return suppressedEngines.has(engine);
}

export interface RestartRequiredExitDeps {
  exit: (code: number) => void;
  log: (line: string) => void;
  /** Monotonic clock for the hold. */
  now?: () => number;
  /** Wall clock for the ledger. */
  wallNow?: () => number;
  ledgerPath?: string;
  consumerStatus?: ConsumerStatusReader;
  /** Check cadence; default a quarter of the hold, at most 15 s. */
  everyMs?: number;
  cleanupDeadlineMs?: number;
}

/**
 * Arms the opt-in exit. `check()` is what the timer runs; tests drive it directly. When restart_required has held for
 * `seconds`: if the ledger already holds 3 self-exits within the hour, log once and keep serving (`selfExitSuppressed`);
 * otherwise record this exit, log, disconnect the engine (which stops the consumer) under a deadline, and exit with
 * the registered code whether or not cleanup finished.
 */
export function installRestartRequiredExit(engine: BrainEngine, seconds: number, deps: RestartRequiredExitDeps): { check(): void; stop(): void } {
  const now = deps.now ?? (() => performance.now());
  const wallNow = deps.wallNow ?? Date.now;
  const ledger = deps.ledgerPath ?? serveSelfExitLedgerPath();
  let since: number | null = null;
  let fired = false;
  let exited = false;
  const exitOnce = (): void => { if (!exited) { exited = true; deps.exit(SERVE_UNHEALTHY_EXIT_CODE); } };
  const check = (): void => {
    if (fired) return;
    if (!consumerRestartRequired(engine, deps.consumerStatus)) { since = null; suppressedEngines.delete(engine); return; }
    if (since === null) { since = now(); return; }
    const heldMs = now() - since;
    if (heldMs < seconds * 1000 || suppressedEngines.has(engine)) return;
    const at = wallNow();
    const recent = readSelfExits(ledger).filter(t => at - t < SERVE_SELF_EXIT_WINDOW_MS && t <= at);
    if (recent.length >= SERVE_SELF_RESTART_LIMIT) {
      suppressedEngines.add(engine);
      deps.log(`[gbrain serve] error code=serve_self_exit_suppressed cause=persistence_restart_required self_exits_last_hour=${recent.length}`
        + ` message="${SERVE_RESTART_REQUIRED_EXIT_ENV}: ${recent.length} self-exits within the last hour; not exiting again, restart serve by hand and read gbrain sources writer status --json" ledger=${ledger} docs=docs/ENGINES.md#serve-unhealthy-exit`);
      return;
    }
    fired = true;
    clearInterval(timer);
    try {
      mkdirSync(dirname(ledger), { recursive: true });
      writeFileSync(ledger, `${JSON.stringify({ exits: [...recent, at].map(t => new Date(t).toISOString()) })}\n`, { mode: 0o600 });
    } catch (err: unknown) { deps.log(`[gbrain serve] serve_unhealthy_exit: could not record the self-exit in ${ledger}: ${err instanceof Error ? err.message : String(err)}`); }
    const deadlineMs = deps.cleanupDeadlineMs ?? SERVE_RESTART_REQUIRED_CLEANUP_DEADLINE_MS;
    deps.log(`[gbrain serve] error code=serve_unhealthy_exit cause=persistence_restart_required held_s=${Math.round(heldMs / 1000)} exit=${SERVE_UNHEALTHY_EXIT_CODE}`
      + ` message="${SERVE_RESTART_REQUIRED_EXIT_ENV}=${seconds}: exiting (cleanup bounded at ${deadlineMs} ms) so the supervisor starts a fresh serve" docs=docs/ENGINES.md#serve-unhealthy-exit`);
    const cleanup = setTimeout(() => {
      deps.log(`[gbrain serve] serve_unhealthy_exit: cleanup deadline (${deadlineMs} ms) exceeded, exiting ${SERVE_UNHEALTHY_EXIT_CODE} without it`);
      exitOnce();
    }, deadlineMs);
    cleanup.unref?.();
    Promise.resolve()
      .then(() => engine.disconnect())
      .catch((err: unknown) => { deps.log(`[gbrain serve] serve_unhealthy_exit: cleanup error: ${err instanceof Error ? err.message : String(err)}`); })
      .finally(() => { clearTimeout(cleanup); exitOnce(); });
  };
  const timer = setInterval(check, deps.everyMs ?? Math.min(15_000, seconds * 250));
  timer.unref?.();
  return { check, stop: () => clearInterval(timer) };
}
