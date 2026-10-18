/**
 * #6543 D5 (+ #6518): rows the pre-managed sync left in the local ledger (`sync-failures.jsonl`) on a managed brain.
 * A managed sync never retries them, so without this they stayed `auto_skipped` forever.
 *
 * - `settleLegacySyncFailures` runs after a successful managed sync of one source. It reconciles each legacy row on its
 *   own with the #6288 settle rule (`unsettledReason`: the imported commit holds the file and a live page claims it with
 *   no hold, or the file is gone and no page claims it). A row recorded on a commit this checkout does not have (a
 *   replaced source), a sentinel row, and any row whose evidence cannot be read are kept, as are files the sync did not
 *   index or that are held. Mirror rows (`managed_cursor_key`) whose durable failure is gone are pruned only after the
 *   durable lookup succeeded, and only rows written before that lookup began.
 * - `legacyLedgerRows` / `legacyLedgerNote` are what `--retry-failed` and doctor `sync_failures` print about them.
 */
import type { BrainEngine } from '../engine.ts';
import { clearFailures, clearManagedSyncFailure, loadSyncFailures, unacknowledgedSyncFailures, type SyncFailure } from '../sync-failure-ledger.ts';
import { syncGit } from './sync-discovery.ts';
import { unsettledReason, type ManagedSyncImported } from './sync-failures.ts';

/** Unacknowledged legacy (pre-managed) ledger rows, optionally for one source. */
export function legacyLedgerRows(sourceId?: string, entries: SyncFailure[] = loadSyncFailures()): SyncFailure[] {
  return unacknowledgedSyncFailures(entries).filter(row => !row.managed_cursor_key && (sourceId === undefined || row.source_id === sourceId));
}

/** Doctor's suffix for the legacy rows among the unresolved failures of a managed brain; empty when there are none. */
export function legacyLedgerNote(rows: SyncFailure[]): string {
  if (!rows.length) return '';
  const sources = [...new Set(rows.map(row => row.source_id))].sort();
  return ` ${rows.length} of these are legacy ledger row(s) recorded by the pre-managed sync (${sources.join(', ')}), which a managed sync does not retry: `
    + `the next successful ${sources.map(id => `gbrain sync --source ${id}`).join(' / ')} settles every one whose file it imported; `
    + 'the rest name files it did not index, held files, or a replaced source, and stay listed.';
}

export async function settleLegacySyncFailures(engine: BrainEngine, run: ManagedSyncImported): Promise<{ settled: number; prunedMirrors: number }> {
  const lookupStarted = new Date().toISOString();
  const entries = loadSyncFailures().filter(row => row.source_id === run.sourceId);
  const settled: string[] = [];
  const commits = new Map<string, boolean>();
  for (const row of legacyLedgerRows(run.sourceId, entries)) {
    if (!row.commit || row.path.startsWith('<')) continue;
    if (!commits.has(row.commit)) {
      let known = false;
      try { known = syncGit(run.gitRoot, ['cat-file', '-t', row.commit]).trim() === 'commit'; } catch { /* not in this checkout */ }
      commits.set(row.commit, known);
    }
    if (!commits.get(row.commit)) continue;
    const reason = await unsettledReason(engine, run, { source_id: row.source_id, source_incarnation: run.incarnation, path: row.path } as Parameters<typeof unsettledReason>[2])
      .catch(() => 'unknown');
    if (!reason) settled.push(row.path);
  }
  if (settled.length) clearFailures(run.sourceId, settled);
  const mirrors = entries.filter(row => row.managed_cursor_key && row.ts < lookupStarted);
  if (!mirrors.length) return { settled: settled.length, prunedMirrors: 0 };
  const durable = new Set((await engine.executeRaw<{ fingerprint: string }>(
    "SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint = ANY($1::text[])", [mirrors.map(row => row.managed_cursor_key!)])).map(row => row.fingerprint));
  const stale = mirrors.filter(row => !durable.has(row.managed_cursor_key!));
  for (const row of stale) clearManagedSyncFailure(row.managed_cursor_key!);
  return { settled: settled.length, prunedMirrors: stale.length };
}
