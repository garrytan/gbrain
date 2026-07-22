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
import { join } from 'path';
import { execFileSync } from 'child_process';
import { gbrainPath, loadConfig } from '../config.ts';
import { getEffectiveNiceness } from './niceness.ts';

/** On-disk shape of a `worker-<pid>.json` entry. */
export interface WorkerRegistryEntry {
  pid: number;
  queue: string;
  /** Short identifier of the brain (DB) this worker serves. */
  brain_id: string;
  /** Epoch ms when the worker registered (≈ its own process start). */
  started_at: number;
  /** Niceness the worker asked for (the `--nice` value), or null if none. */
  nice_requested: number | null;
  /** Niceness actually in effect when the worker registered. */
  nice_effective: number | null;
}

/** A live worker as returned by readWorkers(): on-disk entry + fresh re-measure. */
export interface LiveWorker extends WorkerRegistryEntry {
  /** Niceness re-measured NOW via getEffectiveNiceness(pid). */
  nice_now: number | null;
}

/** Directory holding one file per live worker. Brain-isolated via GBRAIN_HOME. */
export function workerRegistryDir(): string {
  return gbrainPath('workers');
}

/**
 * Short, stable id for the active brain (database). Best-effort: derived from
 * the configured DB url/path. Returns 'default' when nothing is configured.
 * Used to tag + filter registry entries so multiple DBs under one GBRAIN_HOME
 * don't cross-report.
 */
export function currentBrainId(): string {
  try {
    const cfg = loadConfig();
    const key = cfg?.database_url ?? cfg?.database_path ?? 'default';
    // Tiny non-crypto hash (djb2) — we only need a stable short discriminator.
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  } catch {
    return 'default';
  }
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
  const entry: WorkerRegistryEntry = {
    pid: info.pid,
    queue: info.queue,
    brain_id: info.brain_id ?? currentBrainId(),
    started_at: info.started_at,
    nice_requested: info.nice_requested,
    nice_effective: info.nice_effective,
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

/**
 * Best-effort process start time (epoch ms) via `ps`. Used for the PID-reuse
 * guard: a stale `worker-<pid>.json` plus an OS-reused pid would otherwise make
 * us report an unrelated process's niceness (Codex #8). Returns null when
 * undeterminable — callers must NOT treat null as "reused".
 */
function processStartMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const t = Date.parse(out);
    return Number.isNaN(t) ? null : t;
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
 * `getNice` is injectable for tests.
 */
export function readWorkers(
  getNice: (pid: number) => number | null = (pid) => getEffectiveNiceness(pid),
): LiveWorker[] {
  const dir = workerRegistryDir();
  if (!existsSync(dir)) return [];

  const brainId = currentBrainId();
  const live: LiveWorker[] = [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('worker-') && f.endsWith('.json'));
  } catch {
    return [];
  }

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
    if (entry.brain_id && entry.brain_id !== brainId) continue;

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
