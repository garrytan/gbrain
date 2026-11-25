/**
 * Writer status (BrainEngine readWriterDiagnosticRows, readWriterStatusRows, listOnboardingSources,
 * listBlockingEffectRows and listActiveWorktreeRefreshRows; SQL in engine-sql/writer-status.ts), served from the
 * store's request, counter, effect, worktree, binding, topology and source records
 * (gbrain-store `persistence::writer_status`).
 *
 * The store returns times as ISO text; the members here make a `Date` of each column the SQL engines return as a
 * timestamp, so both engines hand writer status the same values. No worktree refresh runs on this engine (the store
 * refuses a request that names one), so `listActiveWorktreeRefreshRows` is always empty.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Writer status").
 */
import type {
  ActiveWorktreeRefreshRow, BlockingEffectRow, OnboardingSourceRow, WriterDiagnosticRows, WriterStatusRows,
} from '../../engine-sql/writer-status.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';

const at = (value: string | Date | null): Date | null => (value === null ? null : new Date(value));

/** `readWriterDiagnosticRows(abandonedCutoff, excludedOrigins)`. */
export const readWriterDiagnosticRows = async function readWriterDiagnosticRows(brain: StoreBrain, abandonedCutoff: string | null, excludedOrigins: readonly string[]): Promise<WriterDiagnosticRows> {
  const rows = await storeCall<WriterDiagnosticRows>({ member: 'readWriterDiagnosticRows' }, () => brain.writerDiagnosticRows(abandonedCutoff, [...excludedOrigins]));
  return {
    worktrees: rows.worktrees.map(row => ({ ...row, heartbeat_at: at(row.heartbeat_at), oldest_request_at: at(row.oldest_request_at) })),
    counters: rows.counters,
    blockers: rows.blockers.map(row => ({ ...row, created_at: new Date(row.created_at) })),
    queue: rows.queue.map(row => ({ ...row, oldest_request_at: at(row.oldest_request_at) })),
    effects: rows.effects.map(row => ({ ...row, oldest_at: at(row.oldest_at) })),
    failures: rows.failures.map(row => ({ ...row, completed_at: at(row.completed_at) })),
  };
};

/** `readWriterStatusRows(hostId, sourceId)`. */
export const readWriterStatusRows = async function readWriterStatusRows(brain: StoreBrain, hostId: string | null, sourceId: string | null): Promise<WriterStatusRows> {
  return storeCall({ member: 'readWriterStatusRows' }, () => brain.writerStatusRows(hostId, sourceId));
};

/** `listOnboardingSources(sourceId)`. */
export const listOnboardingSources = async function listOnboardingSources(brain: StoreBrain, sourceId: string | null): Promise<OnboardingSourceRow[]> {
  return storeCall({ member: 'listOnboardingSources' }, () => brain.onboardingSources(sourceId));
};

/** `listBlockingEffectRows(sourceId, limit, recoveringOnly)`. */
export const listBlockingEffectRows = async function listBlockingEffectRows(brain: StoreBrain, sourceId: string | null, limit: number, recoveringOnly: boolean): Promise<BlockingEffectRow[]> {
  const rows = await storeCall<BlockingEffectRow[]>({ member: 'listBlockingEffectRows' }, () => brain.blockingEffectRows(sourceId, limit, recoveringOnly));
  return rows.map(row => ({ ...row, next_attempt_at: at(row.next_attempt_at) }));
};

/** `listActiveWorktreeRefreshRows(sourceId)`: the active refresh rows (of the source's worktree, or all), oldest first, with each worktree's owner and its deferred writes. */
export const listActiveWorktreeRefreshRows = async function listActiveWorktreeRefreshRows(brain: StoreBrain, sourceId: string | null): Promise<ActiveWorktreeRefreshRow[]> {
  return storeCall<ActiveWorktreeRefreshRow[]>({ member: 'listActiveWorktreeRefreshRows' }, () => brain.refreshRows({ kind: 'active_rows', sourceId }));
};
