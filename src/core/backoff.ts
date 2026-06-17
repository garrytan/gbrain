/**
 * Adaptive load-aware throttling for batch operations.
 *
 * Prevents batch imports, embedding jobs, and enrichment from overloading
 * the system. Checks CPU load, memory, and concurrent process count.
 *
 * Note on os.loadavg(): returns [0,0,0] on Windows. When load data is
 * unavailable (all zeros on non-Linux/macOS), defaults to "proceed" since
 * we can't determine actual load.
 */

import { loadavg, freemem, totalmem, cpus } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThrottleConfig {
  /** Load average as fraction of CPU count above which to stop. Default: 0.62 */
  loadStopPct: number;
  /** Load average as fraction of CPU count above which to slow down. Default: 0.37 */
  loadSlowPct: number;
  /** Load average as fraction of CPU count considered normal. Default: 0.19 */
  loadNormalPct: number;
  /** Memory usage fraction above which to stop. Default: 0.85 */
  memoryStopPct: number;
  /** Multiplier applied during active hours (8am-11pm). Default: 2 */
  activeHoursMultiplier: number;
  /** Hour (0-23) when active hours start. Default: 8 */
  activeHoursStart: number;
  /** Hour (0-23) when active hours end. Default: 23 */
  activeHoursEnd: number;
  /** Maximum iterations for waitForCapacity before throwing. Default: 20 */
  maxAttempts: number;
}

export interface ThrottleResult {
  proceed: boolean;
  delay: number;
  reason: string;
  load: number;
  memoryUsed: number;
}

const DEFAULT_CONFIG: ThrottleConfig = {
  loadStopPct: 0.62,
  loadSlowPct: 0.37,
  loadNormalPct: 0.19,
  memoryStopPct: 0.85,
  activeHoursMultiplier: 2,
  activeHoursStart: 8,
  activeHoursEnd: 23,
  maxAttempts: 20,
};

// Module-level concurrent process counter
let _activeProcesses = 0;
const MAX_CONCURRENT = 2;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/** Merge user config with defaults */
function mergeConfig(config?: Partial<ThrottleConfig>): ThrottleConfig {
  return { ...DEFAULT_CONFIG, ...config };
}

/** Check if current hour is within active hours */
function isActiveHours(cfg: ThrottleConfig): boolean {
  const hour = new Date().getHours();
  return hour >= cfg.activeHoursStart && hour < cfg.activeHoursEnd;
}

/** Get normalized load (0-1 scale relative to CPU count) */
function getLoad(): number {
  const cores = cpus().length || 1;
  const avg = loadavg()[0]; // 1-minute average
  return avg / cores;
}

/** Get memory usage fraction (0-1) */
function getMemoryUsage(): number {
  const total = totalmem();
  if (total === 0) return 0;
  return 1 - (freemem() / total);
}

/**
 * Check if it's safe to proceed with batch work.
 * Returns { proceed, delay, reason, load, memoryUsed }.
 */
export function shouldProceed(config?: Partial<ThrottleConfig>): ThrottleResult {
  const cfg = mergeConfig(config);
  const load = getLoad();
  const memUsed = getMemoryUsage();

  // Windows/unsupported: loadavg returns [0,0,0] — can't determine load, proceed
  if (loadavg()[0] === 0 && loadavg()[1] === 0 && loadavg()[2] === 0) {
    return { proceed: true, delay: 0, reason: 'Load data unavailable (Windows?), proceeding', load: 0, memoryUsed: memUsed };
  }

  // Concurrent process limit
  if (_activeProcesses >= MAX_CONCURRENT) {
    return { proceed: false, delay: 5000, reason: `${_activeProcesses} batch processes active (max ${MAX_CONCURRENT})`, load, memoryUsed: memUsed };
  }

  // Memory check
  if (memUsed > cfg.memoryStopPct) {
    return { proceed: false, delay: 30000, reason: `Memory ${(memUsed * 100).toFixed(0)}% > ${(cfg.memoryStopPct * 100).toFixed(0)}% threshold`, load, memoryUsed: memUsed };
  }

  // CPU load checks
  const activeMultiplier = isActiveHours(cfg) ? cfg.activeHoursMultiplier : 1;

  if (load > cfg.loadStopPct) {
    return { proceed: false, delay: 30000 * activeMultiplier, reason: `Load ${(load * 100).toFixed(0)}% > stop threshold ${(cfg.loadStopPct * 100).toFixed(0)}%`, load, memoryUsed: memUsed };
  }

  if (load > cfg.loadSlowPct) {
    return { proceed: true, delay: 2000 * activeMultiplier, reason: `Load ${(load * 100).toFixed(0)}% > slow threshold, adding delay`, load, memoryUsed: memUsed };
  }

  // Normal load
  return { proceed: true, delay: 300 * activeMultiplier, reason: 'Normal load', load, memoryUsed: memUsed };
}

/**
 * Wait until system has capacity for batch work.
 * Exponential backoff from 1s to 60s, max attempts before throwing.
 */
export async function waitForCapacity(config?: Partial<ThrottleConfig>): Promise<void> {
  const cfg = mergeConfig(config);
  let backoff = 1000;
  const maxBackoff = 60000;

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    const result = shouldProceed(cfg);
    if (result.proceed) {
      if (result.delay > 0) {
        await sleep(result.delay);
      }
      return;
    }

    // Not safe to proceed — wait with exponential backoff
    const waitTime = Math.min(backoff, maxBackoff);
    await sleep(waitTime);
    backoff = Math.min(backoff * 1.5, maxBackoff);
  }

  throw new Error(`Throttle timeout: system overloaded after ${cfg.maxAttempts} attempts (~${Math.round(cfg.maxAttempts * 30)}s). Load: ${(getLoad() * 100).toFixed(0)}%, Memory: ${(getMemoryUsage() * 100).toFixed(0)}%`);
}

/**
 * Pre-flight check at script/command start.
 * Registers this process as active and returns false if overloaded.
 */
export async function preflight(processName: string, config?: Partial<ThrottleConfig>): Promise<boolean> {
  const result = shouldProceed(config);
  if (!result.proceed) {
    return false;
  }
  _activeProcesses++;
  return true;
}

/** Mark a batch process as complete (decrement counter). */
export function complete(): void {
  _activeProcesses = Math.max(0, _activeProcesses - 1);
}

/** Get current throttle state for diagnostics. */
export function getThrottleState(): { load: number; memoryUsed: number; activeProcesses: number; isActiveHours: boolean } {
  return {
    load: getLoad(),
    memoryUsed: getMemoryUsage(),
    activeProcesses: _activeProcesses,
    isActiveHours: isActiveHours(DEFAULT_CONFIG),
  };
}

// For testing: reset module state
export function _resetForTest(): void {
  _activeProcesses = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
