/** Clean whole-root non-Git imports may publish a source heartbeat, never a Git/connector bookmark. */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { parseSourceConfig, sourceConfigHasRemoteUrl } from '../sources-load.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { acquireWorktree, getWorktreeBinding } from './ownership.ts';
import { managedSyncAuthority, assertManagedSyncActive } from './sync-authority.ts';
import { authorizeWrite } from './authority.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';

interface ImportSource { incarnation: string; local_path: string | null; config: unknown; archived: boolean }
/** Classic imports retain their existing best-effort heartbeat, without establishing a managed-write capability. */
export async function completeClassicImport(engine: BrainEngine, sourceId: string, root: string, assertActive: () => void): Promise<void> {
  const [row] = await engine.executeRaw<{ local_path: string | null; config: unknown }>(
    `SELECT local_path, config FROM sources WHERE id = $1`, [sourceId]);
  // The classic contract predates the archived flag; keep its eligibility unchanged.
  if (!eligible(row && { ...row, archived: false }, root)) return;
  assertActive();
  await engine.executeRaw(`UPDATE sources SET last_sync_at = now() WHERE id = $1`, [sourceId]);
}

function eligible(source: Pick<ImportSource, 'local_path' | 'config' | 'archived'> | undefined, root: string): boolean {
  if (!source?.local_path || source.archived || sourceConfigHasRemoteUrl(source.config)) return false;
  const cfg = parseSourceConfig(source.config);
  if (typeof cfg.kind === 'string' && cfg.kind.length > 0) return false;
  try { if (realpathSync(source.local_path) !== root) return false; } catch { return false; }
  try { discoverGitRoot(root); return false; } catch { return true; }
}

/**
 * Capture the source incarnation, owner epoch and CLI authority BEFORE enumeration. The returned completion
 * is called only after every selected file settled successfully. Recheck everything under the physical owner
 * lock and database row locks: an import must not stamp a replacement source or a transferred worktree.
 * A busy/changing owner leaves the old heartbeat; this best-effort metadata must not undo committed pages.
 */
export async function prepareManagedImportCompletion(engine: BrainEngine, sourceId: string, root: string,
  signal?: AbortSignal): Promise<(() => Promise<void>) | null> {
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) return null;
  const [source] = await engine.executeRaw<ImportSource>('SELECT incarnation,local_path,config,archived FROM sources WHERE id=$1', [sourceId]);
  if (!eligible(source, root)) return null;
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active'
    || binding.source_incarnation !== source!.incarnation || realpathSync(join(binding.local_path, binding.relative_path)) !== root) return null;
  const authority = await managedSyncAuthority(engine, sourceId, source!.incarnation, root);
  return async () => {
    signal?.throwIfAborted();
    const lock = await acquireWorktree(binding, 1000, signal, engine);
    if (!lock) return;
    try {
      await engine.transaction(async tx => {
        await assertManagedSyncActive(tx, true);
        const [owner] = await tx.executeRaw<{ owner_host_id: string; owner_epoch: string | number; state: string }>(
          'SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [binding.worktree_id]);
        const [current] = await tx.executeRaw<ImportSource>('SELECT incarnation,local_path,config,archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
        const live = await getWorktreeBinding(tx, sourceId);
        if (!owner || owner.owner_host_id !== binding.owner_host_id || String(owner.owner_epoch) !== String(binding.owner_epoch)
          || owner.state !== 'active' || !live || live.worktree_id !== binding.worktree_id
          || String(live.topology_generation) !== String(binding.topology_generation) || live.relative_path !== binding.relative_path
          || current?.incarnation !== source!.incarnation || !eligible(current, root)) return;
        await authorizeWrite(tx, authority.writer, 'submit_job', '__managed_sync_checkpoint__', true);
        signal?.throwIfAborted();
        await withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
          'UPDATE sources SET last_sync_at=now() WHERE id=$1 AND incarnation=$2::uuid', [sourceId, source!.incarnation]),
        principalAttribution(authority.writer.principal));
      });
    } finally { await lock.release(); }
  };
}
