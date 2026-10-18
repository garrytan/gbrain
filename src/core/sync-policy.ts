/**
 * The single predicate for `config.syncEnabled === false` (#4399).
 *
 * The flag means "excluded from AUTOMATIC/bulk sync": the `sync --all` fan-out
 * filter (sync.ts), autopilot's freshness dispatcher (autopilot.ts), the
 * full-cycle fan-out (autopilot-fanout.ts) and the `sync_enabled` column of
 * the sources status report (sync-status-report.ts, fed RAW `SELECT config`
 * rows) all read it here so they cannot drift apart. It deliberately does
 * NOT gate performSync() itself — an
 * explicit `gbrain sync --source <id>` naming a disabled source still runs.
 * (sync-cost-gate.ts keeps its own inline check: it also feeds the explicit
 * single-source cost preview.)
 */

import type { BrainEngine } from './engine.ts';
import { parseSourceConfig } from './sources-load.ts';
import { readManagedMode } from './persistence/managed-mode.ts';
import { syncContentDirectory } from './sync-applicability.ts';

/**
 * True iff `config` explicitly sets `syncEnabled: false`. parseSourceConfig
 * unwraps PGLite's JSON-string scalar shape (same pattern as
 * sourceConfigHasRemoteUrl); absent/undefined is NOT disabled.
 */
export function isSyncDisabledConfig(config: unknown): boolean {
  return parseSourceConfig(config).syncEnabled === false;
}

/**
 * #5198: source ids that are claimed (`sources writer claim`) while persistence
 * is not yet activated. performSync refuses these with
 * `writer_coordinator_required` until deliberate activation
 * (resolveSyncPersistenceMode in persistence/sync-authority.ts), so automatic
 * dispatchers skip their sync instead of queueing a job that fails the same
 * way on every tick. The refusal contract itself is unchanged: an explicit
 * `gbrain sync --source <id>` still reaches performSync and still refuses.
 *
 * Mirrors resolveSyncPersistenceMode through the shared `readManagedMode`
 * (#6482). Fail-open by design, as a dispatch filter: when the persistence
 * tables are unreadable (older schema, stub engine) or the singleton is
 * malformed, nothing is skipped here and the dispatched sync itself refuses
 * with the typed `storage_error`; this filter never routes a write.
 */
export async function loadActivationPendingSourceIds(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<Set<string>> {
  try {
    if (await readManagedMode(engine)) return new Set();
    const rows = await engine.executeRaw<{ source_id: string }>('SELECT b.source_id FROM persistence_source_bindings b');
    return new Set(rows.map((r) => r.source_id));
  } catch {
    return new Set();
  }
}

const reportedActivationPending = new Set<string>();

/**
 * True the first time a process skips sync for `sourceId` because of a pending
 * activation, so a long-running daemon states the reason once instead of on
 * every tick.
 */
export function firstActivationPendingSkip(sourceId: string): boolean {
  if (reportedActivationPending.has(sourceId)) return false;
  reportedActivationPending.add(sourceId);
  return true;
}

/**
 * Dispatcher guard: true when `sourceId` is awaiting activation, in which case
 * the caller skips its sync. Reports the reason once per process — an NDJSON
 * `event` line under --json, plain prose otherwise.
 */
export function skipActivationPendingSync(
  pending: ReadonlySet<string>,
  sourceId: string,
  event: string,
  jsonMode: boolean,
  write: (line: string) => void,
): boolean {
  if (!pending.has(sourceId)) return false;
  if (firstActivationPendingSkip(sourceId)) {
    write(jsonMode
      ? JSON.stringify({ event, source_id: sourceId, reason: 'activation_pending' })
      : activationPendingSkipMessage(sourceId));
  }
  return true;
}

export function activationPendingSkipMessage(sourceId: string): string {
  return `[sync] skipping automatic sync for source=${sourceId}: it is claimed but persistence is not activated, ` +
    'so sync refuses with writer_coordinator_required. Review `gbrain sources writer status`; ' +
    'automatic sync resumes after activation.';
}

export type AutomaticSyncSkipReason = 'sync_disabled' | 'activation_pending' | 'sync_not_applicable';
export interface AutomaticSyncSkip { reason: AutomaticSyncSkipReason; message: string }
/** Per-source latch for `reportAutomaticSyncSkip`: the last reason written for each source. */
export type AutomaticSyncSkipLatch = Map<string, AutomaticSyncSkipReason>;
const processSkipLatch: AutomaticSyncSkipLatch = new Map();

/**
 * The one "automatic sync does not run for this source" decision (fix wave 15 P4.2, supersedes #6465 by
 * @mattverlaque): `config.syncEnabled === false` (#4399), a claim awaiting activation (#5198, when the caller loaded
 * the pending set) and a gbrain-owned content directory that is not a Git checkout (`sync_not_applicable`), the
 * refusal performSync would raise. The freshness dispatcher, the full-cycle fan-out and `sync --all` all ask here,
 * so a source where sync does not apply is skipped before a job is queued instead of failing a job every tick.
 * Path usability (relative or absent `local_path`) stays with each caller: it is a per-machine condition with its own
 * `--missing-path` modes and events. An explicit `gbrain sync --source <id>` never consults this.
 */
export async function automaticSyncSkip(
  engine: BrainEngine,
  src: { id: string; local_path: string | null; config: unknown },
  activationPending?: ReadonlySet<string>,
): Promise<AutomaticSyncSkip | null> {
  if (isSyncDisabledConfig(src.config)) return { reason: 'sync_disabled', message: `[sync] skipping automatic sync for source=${src.id}: config.syncEnabled is false.` };
  if (activationPending?.has(src.id)) return { reason: 'activation_pending', message: activationPendingSkipMessage(src.id) };
  const dir = await syncContentDirectory(engine, { sourceId: src.id, repoPath: src.local_path ?? undefined });
  if (dir) {
    return { reason: 'sync_not_applicable', message: `[sync] skipping automatic sync for source=${src.id}: ${dir.root} is a gbrain-owned content directory, not a Git checkout. ` +
      `Add markdown files with \`gbrain import <dir>${dir.keyless ? ' --no-embed' : ''} --source ${src.id}\`; automatic sync applies once the directory is a Git checkout.` };
  }
  return null;
}

/**
 * Writes a skip once per source and reason (an NDJSON `event` line under --json, the message otherwise): a daemon
 * states the reason on the tick it first applies and again only when the reason changes. A source that is not skipped
 * clears its entry, so the reason is stated again if it returns. The latch is per process by default (the freshness
 * loop and the fan-out share one daemon); a caller may hold its own.
 */
export function reportAutomaticSyncSkip(
  sourceId: string,
  skip: AutomaticSyncSkip | null,
  event: string,
  jsonMode: boolean,
  write: (line: string) => void,
  latch: AutomaticSyncSkipLatch = processSkipLatch,
): void {
  if (!skip) { latch.delete(sourceId); return; }
  if (latch.get(sourceId) === skip.reason) return;
  latch.set(sourceId, skip.reason);
  write(jsonMode ? JSON.stringify({ event, source_id: sourceId, reason: skip.reason }) : skip.message);
}
