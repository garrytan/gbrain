/** Missing files in a registered plain directory use the same guarded retirement as ghost-page repair.
 * Git sources never enter this path. Database-ahead revisions and shared skillpack members stay intact.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../core/engine.ts';
import type { OperationContext } from '../../core/ops/contract.ts';
import type { SyncOpts } from '../sync.ts';
import { scanGhostSource } from '../../core/ghost-pages.ts';
import { assertPlainDirectoryFileInStep } from '../../core/persistence/plain-directory-drift.ts';
import { OperationError } from '../../core/ops/contract.ts';
import { retireGhost } from '../../core/repair/ghost-pages.ts';
import { massReconcileAllowed, readSyncDeleteCaps, syncDeleteTrip } from '../../core/sync-reconcile.ts';
import { isSyncable, matchesAnyGlob } from '../../core/sync.ts';
import { serr } from '../../core/console-prefix.ts';
import { confirmedMissingPaths, plainRootLooksEmpty } from './plain-directory-missing.ts';

export async function reconcilePlainDirectoryDeletes(engine: BrainEngine, opts: SyncOpts, root: string, managed: boolean): Promise<number> {
  // Classic imports have no receipt proving a missing path ever held this page (GBRA-287).
  if (!managed) return 0;
  const sourceId = opts.sourceId!;
  if (plainRootLooksEmpty(root) && !massReconcileAllowed()) {
    const [page] = await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND source_path IS NOT NULL AND deleted_at IS NULL LIMIT 1', [sourceId]);
    if (page) serr(`[sync] Kept every page of ${sourceId}: ${root} is empty, which usually means its volume is not mounted. If the files were really removed, re-run with GBRAIN_ALLOW_MASS_RECONCILE=1.`);
    return 0;
  }
  const scan = await scanGhostSource(engine, sourceId, { candidateLimit: 250_000, signal: opts.signal });
  if (scan.status !== 'known' || scan.truncated || !scan.owner) return 0;
  const gone = confirmedMissingPaths(root, scan.ghosts.map(ghost => ghost.path));
  if (!gone) return 0;
  const ghosts = scan.ghosts.filter(ghost => gone.has(ghost.path) && isSyncable(ghost.path, { strategy: opts.strategy, includeHidden: opts.includeHidden })
    && !matchesAnyGlob(ghost.path, opts.exclude ?? []));
  const caps = await readSyncDeleteCaps(engine, sourceId);
  if (!massReconcileAllowed() && syncDeleteTrip(ghosts.length, scan.file_backed, caps)) {
    serr(`[sync] Kept ${ghosts.length} missing-file pages of ${sourceId}: mass-delete limits exceeded. Check the directory before using GBRAIN_ALLOW_MASS_RECONCILE=1.`);
    return 0;
  }
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId,
    logger: { info() {}, warn() {}, error() {} } };
  let deleted = 0;
  for (const ghost of ghosts) {
    opts.signal?.throwIfAborted();
    const snapshot = await engine.readPageSnapshot(ghost.slug, { sourceId });
    if (!snapshot || snapshot.revision !== ghost.revision) continue;
    try { await assertPlainDirectoryFileInStep(engine, sourceId, scan.owner.source_incarnation, snapshot, ghost.path); }
    catch (error) {
      if (!(error instanceof OperationError) || error.code !== 'file_drift') throw error;
      serr(`[sync] Kept ${ghost.slug}: database revision is ahead of its missing file.`);
      continue;
    }
    const outcome = await retireGhost(ctx, ghost, scan.owner, async () => randomUUID());
    if (outcome.applied) deleted++;
    else serr(`[sync] Kept ${ghost.slug}: ${outcome.reason ?? outcome.outcome}`);
  }
  return deleted;
}
