/**
 * Live worker registry for niceness observability (issue #1815, Q1-C).
 *
 * Each running `gbrain jobs work` process self-registers a small JSON file
 * recording its pid, queue, brain identity, start time, and the niceness it
 * requested + the niceness actually in effect. The read surfaces (jobs stats,
 * doctor, supervisor status) enumerate these to report the EFFECTIVE niceness of
 * the real worker process — not the supervisor's value as a proxy. This also
 * covers standalone `jobs work` (no supervisor / PID file) and sidesteps the
 * tini-wrapper-PID problem (the worker writes its OWN pid, Codex #5).
 *
 * Discipline mirrors src/core/audit/audit-writer.ts: best-effort, never blocks
 * the worker. A failed write just means that worker is omitted from the read
 * surfaces — it does not affect job execution.
 *
 * Location is brain-isolated via gbrainPath() (honors GBRAIN_HOME); entries are
 * additionally tagged with a brain id so a single GBRAIN_HOME hosting multiple
 * databases doesn't cross-report (Codex #7).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from '../spawn.ts';
import { gbrainPath, loadConfig } from '../config.ts';
import { getEffectiveNiceness } from './niceness.ts';
import { VERSION } from '../../version.ts';
import { runtimeInstallRoot } from '../runtime-build.ts';

/** On-disk shape of a `worker-<pid>.json` entry. */
export interface WorkerRegistryEntry {
  pid: number;
  queue: string;
  /** Short identifier of the brain (DB) this worker serves. */
  brain_id: string;
  /** #9229: normalized target discriminator; absent on pre-upgrade entries. */
  brain_target_id?: string;
  /** Epoch ms when the worker registered (≈ its own process start). */
  started_at: number;
  /** Niceness the worker asked for (the `--nice` value), or null if none. */
  nice_requested: number | null;
  /** Niceness actually in effect when the worker registered. */
  nice_effective: number | null;
  /** #7245: the gbrain version the worker runs (in memory); absent on an entry an older worker wrote. */
  version?: string;
  /** #7245: the package root the worker loaded its code from (local path, never in remote output); null in a compiled binary. */
  install_root?: string | null;
}

/** A live worker as returned by readWorkers(): on-disk entry + fresh re-measure. */
export interface LiveWorker extends WorkerRegistryEntry {
  /** Niceness re-measured NOW via getEffectiveNiceness(pid). */
  nice_now: number | null;
}

/**
 * The registry directory exists but cannot be listed (EACCES on it or a
 * parent, ENOTDIR, ...). Worker liveness is unknown: callers report it as
 * unknown with this errno and path, never as zero workers.
 */
export class WorkerRegistryUnreadableError extends Error {
  readonly path: string;
  readonly errno: string;
  constructor(path: string, errno: string, cause: unknown) {
    super(`worker registry unreadable (${errno}): ${path}`, { cause });
    this.name = 'WorkerRegistryUnreadableError';
    this.path = path;
    this.errno = errno;
  }
}

/** The safe evidence of a failed registry read: errno and path, or the error class name for anything else. */
export function workerRegistryReadFailure(err: unknown): { errno: string; path: string | null } {
  if (err instanceof WorkerRegistryUnreadableError) return { errno: err.errno, path: err.path };
  return { errno: err instanceof Error ? err.name : 'unknown', path: null };
}

/** Directory holding one file per live worker. Brain-isolated via GBRAIN_HOME. */
export function workerRegistryDir(): string {
  return gbrainPath('workers');
}

// Only transport/driver tuning is irrelevant to worker visibility. Keep unknown
// parameters (including options, host, user and dbname) so routing differences
// cannot silently cross-report. This is observability, not an authorization key.
const WORKER_DRIVER_PARAMS = new Set([
  'connect_timeout', 'idle_timeout', 'max_lifetime', 'application_name', 'prepare',
  'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'sslpassword',
  'password',
]);

function brainHash(key: string): string {
  // Preserve the old hash for exact-spelling compatibility with live workers
  // registered before #9229. A hash alone cannot recover their original URL.
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function brainIds(): { current: string; legacy: string } {
  try {
    const cfg = loadConfig();
    const key = cfg?.database_url ?? cfg?.database_path ?? 'default';
    const legacy = brainHash(key);
    let target: string;
    if (cfg?.database_url) {
      try {
        const url = new URL(cfg.database_url);
        // Incomplete and non-Postgres URLs keep the historical discriminator:
        // implicit user/database defaults can depend on another process's env.
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length <= 1) {
          return { current: legacy, legacy };
        }
        const params = [...url.searchParams.entries()].filter(([name]) => !WORKER_DRIVER_PARAMS.has(name));
        // Preserve duplicate-value order (a driver may use the last value), but
        // normalize ordering of distinct keys. No host/port alias guessing.
        params.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        // Match the driver's fallback order without coercing invalid PGPORT values.
        target = JSON.stringify(['postgres', url.hostname.toLowerCase(), url.port || process.env.PGPORT || '5432',
          decodeURIComponent(url.username), decodeURIComponent(url.pathname), params]);
      } catch { return { current: legacy, legacy }; }
    } else if (cfg?.database_path) {
      target = JSON.stringify(['pglite', resolve(cfg.database_path)]);
    } else {
      return { current: legacy, legacy };
    }
    return { current: `target-v1-${brainHash(target)}`, legacy };
  } catch {
    return { current: 'default', legacy: 'default' };
  }
}

/** Historical configured-spelling id, also used in supervisor pidfile names.
 * Keep those persisted paths and old readers stable across upgrades. Registry
 * entries additionally carry brain_target_id for equivalent-spelling discovery.
 * Restart old workers to gain that visibility: a raw hash cannot recover a URL. */
export function currentBrainId(): string {
  return brainIds().legacy;
}

function entryPath(pid: number): string {
  return join(workerRegistryDir(), `worker-${pid}.json`);
}

/**
 * Register the current worker process. Best-effort write; returns a cleanup
 * function that unlinks the entry. The caller MUST wire cleanup to both the
 * shutdown `finally` AND `process.on('exit')` — the unhealthy `process.exit(1)`
 * path bypasses awaited cleanup (Codex #10). SIGKILL still leaves a stale file;
 * the read side prunes those via liveness checks.
 */
export function registerWorker(info: {
  pid: number;
  queue: string;
  nice_requested: number | null;
  nice_effective: number | null;
  started_at: number;
  brain_id?: string;
}): () => void {
  const ids = brainIds();
  const entry: WorkerRegistryEntry = {
    pid: info.pid,
    queue: info.queue,
    brain_id: info.brain_id ?? ids.legacy,
    // An explicit caller-supplied identity must not acquire the config's target.
    ...(info.brain_id === undefined ? { brain_target_id: ids.current } : {}),
    started_at: info.started_at,
    nice_requested: info.nice_requested,
    nice_effective: info.nice_effective,
    version: VERSION,
    install_root: runtimeInstallRoot(),
  };
  const path = entryPath(info.pid);
  try {
    mkdirSync(workerRegistryDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(entry), 'utf8');
  } catch {
    // Best-effort: a failed write just omits this worker from read surfaces.
  }

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch { /* best effort */ }
  };
}

/**
 * Classify a `process.kill(pid, 0)` outcome. EPERM means the process exists but
 * we can't signal it → alive, NOT dead (Codex #9). Only ESRCH (no such process)
 * is a confirmed death worth pruning. Exported pure helper so the EPERM/ESRCH
 * policy is unit-testable without a real privileged process.
 */
export function classifyLiveness(killErrorCode: string | undefined): 'alive' | 'dead' | 'unknown' {
  if (killErrorCode === undefined) return 'alive'; // kill(0) did not throw
  if (killErrorCode === 'ESRCH') return 'dead';
  if (killErrorCode === 'EPERM') return 'alive';
  return 'unknown';
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return classifyLiveness(undefined);
  } catch (e) {
    return classifyLiveness((e as NodeJS.ErrnoException)?.code);
  }
}

/** Parses portable `ps -o etime=` output (`[[dd-]hh:]mm:ss`) to milliseconds. */
export function parseEtimeToMs(etime: string): number | null {
  const raw = etime.trim();
  if (!raw) return null;

  let days = 0;
  let rest = raw;
  const dash = rest.indexOf('-');
  if (dash !== -1) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
    if (!Number.isInteger(days) || days < 0) return null;
  }

  const parts = rest.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every(part => part.length > 0 && /^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  const [hours, minutes, seconds] =
    numbers.length === 3 ? numbers : [0, numbers[0]!, numbers[1]!];

  return (((days * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000;
}

/**
 * Best-effort process start time (epoch ms) via `ps`. Used for the PID-reuse
 * guard: a stale `worker-<pid>.json` plus an OS-reused pid would otherwise make
 * us report an unrelated process's niceness (Codex #8). Returns null when
 * undeterminable — callers must NOT treat null as "reused".
 *
 * Elapsed time (`etime`) is zone-free. The previous `lstart` path printed a
 * zoneless local timestamp in the libc zone while `Date.parse` read it in the
 * runtime zone; the two can differ (bun test pins UTC without exporting TZ,
 * `TZ=:/etc/localtime` resolves to UTC in ICU, and Bun does not propagate a
 * runtime `process.env.TZ` change to the ps child), shifting every start by
 * the offset and dropping live workers on UTC+ hosts (#4885). `etime` is used
 * instead of Linux-only `etimes` so this also works on macOS.
 */
function processStartMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const elapsedMs = parseEtimeToMs(out);
    return elapsedMs === null ? null : Date.now() - elapsedMs;
  } catch {
    return null;
  }
}

/** Tolerance (ms) for the PID-reuse start-time comparison — covers the small gap
 *  between a worker's actual start and when it wrote its registry entry, plus
 *  clock/`ps`-resolution slop. */
const PID_REUSE_TOLERANCE_MS = 5000;

/**
 * Read live workers for the current brain. Enumerates the registry, drops
 * confirmed-dead entries (pruning their files), filters by brain id, applies the
 * PID-reuse guard, and re-measures each live worker's niceness now.
 *
 * Only a missing registry directory (ENOENT) is an empty registry; any other
 * listing failure throws WorkerRegistryUnreadableError (existsSync() answers
 * false for an unsearchable parent too, so it is not used as the gate).
 * `getNice` is injectable for tests.
 */
export function readWorkers(
  getNice: (pid: number) => number | null = (pid) => getEffectiveNiceness(pid),
): LiveWorker[] {
  const dir = workerRegistryDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('worker-') && f.endsWith('.json'));
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException)?.code;
    if (errno === 'ENOENT') return [];
    throw new WorkerRegistryUnreadableError(dir, errno ?? 'unknown', e);
  }

  const { current: brainId, legacy: legacyBrainId } = brainIds();
  const live: LiveWorker[] = [];

  for (const f of files) {
    const full = join(dir, f);
    let entry: WorkerRegistryEntry;
    try {
      entry = JSON.parse(readFileSync(full, 'utf8')) as WorkerRegistryEntry;
    } catch {
      continue; // corrupt / truncated write — skip
    }
    if (!entry || typeof entry.pid !== 'number') continue;

    const liveness = processLiveness(entry.pid);
    if (liveness === 'dead') {
      try { unlinkSync(full); } catch { /* best effort */ }
      continue;
    }

    // Only this brain's workers (multi-DB under one GBRAIN_HOME).
    if (entry.brain_target_id !== undefined) {
      if (entry.brain_target_id !== brainId) continue;
    } else if (entry.brain_id && entry.brain_id !== legacyBrainId) continue;

    // PID-reuse guard: if the live pid demonstrably started well after this
    // entry was written, the pid was recycled — don't report a stranger.
    const startMs = processStartMs(entry.pid);
    if (startMs !== null && entry.started_at && startMs - entry.started_at > PID_REUSE_TOLERANCE_MS) {
      continue;
    }

    live.push({ ...entry, nice_now: getNice(entry.pid) });
  }

  return live.sort((a, b) => a.pid - b.pid);
}
