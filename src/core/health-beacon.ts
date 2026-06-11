/**
 * Sync watch-failure marker.
 *
 * `mbrain sync --watch` exits after 5 consecutive failures. Because the
 * failure is often the database itself, the marker is written to the config
 * directory as a plain file instead of the DB config table, so `mbrain doctor`
 * can still surface "your live sync died at <time>" afterwards. A successful
 * watch iteration clears the marker.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { configDir } from './config.ts';

export interface SyncWatchFailure {
  stopped_at: string;
  reason: string;
  consecutive_failures: number;
}

export function syncWatchFailurePath(): string {
  return join(configDir(), 'sync-watch-failure.json');
}

export function readSyncWatchFailure(): SyncWatchFailure | null {
  try {
    const path = syncWatchFailurePath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SyncWatchFailure>;
    if (typeof parsed.stopped_at !== 'string' || typeof parsed.reason !== 'string') return null;
    return {
      stopped_at: parsed.stopped_at,
      reason: parsed.reason,
      consecutive_failures: typeof parsed.consecutive_failures === 'number' ? parsed.consecutive_failures : 0,
    };
  } catch {
    return null;
  }
}

export function recordSyncWatchFailure(failure: SyncWatchFailure): void {
  try {
    const path = syncWatchFailurePath();
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(failure, null, 2));
  } catch {
    // The marker is best-effort; never let it mask the original failure.
  }
}

export function clearSyncWatchFailure(): void {
  try {
    rmSync(syncWatchFailurePath(), { force: true });
  } catch {
    // Best-effort cleanup.
  }
}
