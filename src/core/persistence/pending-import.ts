/**
 * #6693: a page write refused because its canonical file differs from the
 * database is usually another agent's committed Git change that managed sync
 * has not imported yet, not a hand edit. That case is told apart here, from
 * Git alone and read-only: the file on disk is exactly the blob `HEAD` holds
 * for its path (nothing uncommitted), and that blob is not the one the
 * source's last imported commit (`sources.last_commit`) holds, or no import
 * is recorded yet. Any Git failure (no repository, a commit that no longer
 * exists, a path Git cannot resolve) answers false, so the write keeps the
 * ordinary drift refusal.
 *
 * The refusal stays `source_changed` / `file_database_drift` (every reader of
 * drift keeps working) and carries reason `pending_import`, which the
 * coordinator records as the receipt's `error_detail.origin`. A refused
 * `remember` gets one replay attempt from the first managed sync that
 * imports the file (`replayImportedRemembers`, repair/failed-writes.ts); any other write
 * is resubmitted by its caller after that sync.
 */
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { syncGit } from './sync-discovery.ts';
import { PENDING_IMPORT_MESSAGE } from './verb-errors.ts';

export const PENDING_IMPORT = 'pending_import';
/** #6693: the receipt origin of a write refused because sync holds the page's file (heldFileRefusal). */
export const SYNC_HELD = 'sync_held';

/** Whether the file at `path` (inside the source checkout `root`) is a committed change the source has not imported yet. */
export async function committedPendingImport(engine: BrainEngine, sourceId: string, root: string, path: string): Promise<boolean> {
  const [source] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]);
  const rel = `./${relative(root, path).split(sep).join('/')}`;
  try {
    const head = syncGit(root, ['rev-parse', '--verify', '--quiet', `HEAD:${rel}`]).trim();
    if (!head || syncGit(root, ['hash-object', '--', rel]).trim() !== head) return false;
    if (!source?.last_commit) return true;
    syncGit(root, ['cat-file', '-e', `${source.last_commit}^{commit}`]);
    let imported = '';
    try { imported = syncGit(root, ['rev-parse', '--verify', '--quiet', `${source.last_commit}:${rel}`]).trim(); } catch { imported = ''; }
    return imported !== head;
  } catch {
    return false;
  }
}

/** The refusal: nothing was overwritten; a remember waits for its replay, any other write is resubmitted after the next sync. */
export function pendingImportRefusal(row: { source_id: string; slug: string; operation?: string }, remote: boolean): OperationError {
  const status = ['gbrain', 'sync', 'status', '--source', row.source_id, '--json'];
  const remember = row.operation === 'remember';
  const fix: Action = remember
    ? { argv: status, consent: [], actor: 'provider', requires_exclusive: false, verify: { argv: status }, docs: 'docs/guides/write-refusals.md#pending_import',
      why: `The fact is kept in this request's receipt and queued for one automatic replay attempt by the first managed sync that imports the file; do not save it again. `
        + `This read-only status shows when the source has synced; until the replay commits, gbrain repair failed-writes --source ${row.source_id} lists the fact (a replay that is refused stays there for a person to replay).` }
    : { argv: ['gbrain', 'sync', '--source', row.source_id, '--no-pull', '--json'], consent: [], actor: remote ? 'host_admin' : 'agent', requires_exclusive: false,
      verify: { argv: status }, docs: 'docs/guides/write-refusals.md#pending_import',
      why: 'Imports the committed change on the brain host; then read the page again and resubmit the intended write with a new request_id.' };
  return opError('source_changed', PENDING_IMPORT_MESSAGE,
    `Nothing was overwritten. The canonical file of ${row.slug} in source ${row.source_id} holds a change committed through Git that managed sync has not imported yet, `
    + (remember ? 'so this remember was refused and kept: the first sync that imports the file makes one replay attempt, with its original date and authority.'
      : 'so this write was refused rather than replacing those bytes: after the next sync imports them, read the page again and resubmit with a new request_id.'),
    { detail: 'file_database_drift', reason: PENDING_IMPORT, fix });
}
