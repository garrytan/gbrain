import { lstatSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { authorizeStoredRequest } from './authority.ts';
import { digest } from './digest.ts';
import { reconcileCanonical } from './reconcile-merge.ts';
import { assertReconcilePins, readReconcileState, reconcileReadOptions, staleReconcile, type ReconcileArtifact, type ReconcileState } from './reconcile-state.ts';
import { verifyReconcileBackup } from './reconcile-backup.ts';

/** Empty-cache recovery changes no canonical page content or origin metadata. */
export function emptyCacheResult(state: ReconcileState) {
  return { result: reconcileCanonical(state.snapshot.page, state.snapshot.tags), conflicts: [], protectedPaths: [], scanPaths: [], ready: true };
}

/** The coordinator removes the pinned empty cache before apply and restores it on failure. */
export function prepareEmptyCacheRemoval(_engine: BrainEngine, row: WriteRequest, state: ReconcileState,
  artifact: ReconcileArtifact, reference: string): PreparedMutation {
  if (state.origin !== 'database_only_cache' || state.raw.length !== 0 || artifact.action !== 'remove_empty_db_only_cache'
    || artifact.decisions.length || artifact.conflicts.length || (artifact.auto_decisions?.length ?? 0)
    || digest(emptyCacheResult(state).result) !== artifact.result_digest) {
    staleReconcile('empty database-only cache recovery changed');
  }
  return {
    observedRevision: state.snapshot.revision, noop: false, cacheRemoval: true,
    file: { root: state.root, path: state.path, content: null, expectedBeforeHash: state.pins.raw_file_hash },
    validate: async tx => {
      await authorizeStoredRequest(tx, row, true);
      const current = await readReconcileState(tx, row.source_id, row.slug, artifact.preconditions.assessment_at, reconcileReadOptions(artifact));
      assertReconcilePins(artifact.preconditions, current.pins);
      if (current.origin !== 'database_only_cache' || current.raw.length !== 0
        || digest(emptyCacheResult(current).result) !== artifact.result_digest) staleReconcile('empty database-only cache recovery changed');
      verifyReconcileBackup(reference, artifact);
    },
    apply: async () => {
      // lstat distinguishes absence from dangling symlinks; any replacement is left to coordinator recovery.
      try {
        lstatSync(state.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {
          status: 'reconciled', action: 'remove_empty_db_only_cache', source_id: row.source_id, slug: row.slug,
          backup_reference: reference, result_digest: artifact.result_digest, database_changed: false, file_changed: true,
        };
        throw error;
      }
      throw opError('storage_error', 'The empty database-only cache was not removed.',
        `Inspect request ${row.request_id}'s receipt before retrying; the canonical page was not changed.`);
    },
  };
}
