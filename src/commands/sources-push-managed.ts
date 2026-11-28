import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/ops/contract.ts';
import { managedFilesystemRootFor } from '../core/persistence/filesystem-guard.ts';
import { existingHostIdFor } from '../core/persistence/identity.ts';
import { acquireWorktree, containsPath, getWorktreeBinding, readManagedMode, type WorktreeBinding } from '../core/persistence/ownership.ts';
import { canonicalFilesystemPath } from '../core/persistence/root-registry.ts';
import { isConnectorSourceKind } from '../core/persistence/connector-kinds.ts';
import { pushManagedSourcesHead } from '../core/git/managed-sources-push.ts';

interface Options { id?: string; dir: string; branch?: string; message?: string; allowUnverified: boolean; json: boolean; scanTimeoutMs?: number }
const noOwner = () => new OperationError('owner_unavailable', 'This host has no active canonical owner binding for the push.',
  'Inspect gbrain sources writer status on the owner host. No files or commits were changed.');

/** A marker is refusal evidence, never authorization: resolve a live binding in the selected database. */
async function managedPush(engine: BrainEngine, opts: Options): Promise<Record<string, unknown> | null> {
  const marker = managedFilesystemRootFor(opts.dir);
  // The legacy --path form is DB-free when no managed evidence exists.
  if (!marker && !opts.id) return null;
  if (!marker && typeof engine.hasPersistenceTable !== 'function') return null;
  if (!await engine.hasPersistenceTable('persistence_brain') || !await readManagedMode(engine)) return null;
  const host = existingHostIdFor(engine);
  const requested = canonicalFilesystemPath(opts.dir);
  let id = opts.id;
  let binding: WorktreeBinding | null = null;
  if (id) binding = await getWorktreeBinding(engine, id, host);
  else if (host) {
    const candidates = await engine.listManagedRootBindings(host);
    let depth = -1;
    for (const candidate of candidates) {
      if (!candidate.worktree_id) continue;
      const current = await getWorktreeBinding(engine, candidate.source_id, host);
      const source = await engine.readSourceState(candidate.source_id);
      if (!current?.local_path || !source?.local_path || source.archived || isConnectorSourceKind(source.config.kind)) continue;
      const sourcePath = canonicalFilesystemPath(source.local_path);
      if (sourcePath !== canonicalFilesystemPath(join(current.local_path, current.relative_path))) continue;
      if (!containsPath(sourcePath, requested) && requested !== canonicalFilesystemPath(current.local_path)) continue;
      if (sourcePath.length <= depth) continue;
      depth = sourcePath.length; id = candidate.source_id; binding = current;
    }
  }
  if (!id || !host || !binding || binding.owner_host_id !== host || binding.state !== 'active' || !binding.local_path
    || !containsPath(canonicalFilesystemPath(binding.local_path), requested)) throw noOwner();
  if (opts.branch !== undefined || opts.message !== undefined || opts.allowUnverified) {
    throw new OperationError('invalid_params', 'Managed push does not accept --branch, --message or --allow-unverified-remote.',
      'It publishes the committed HEAD to its configured tracking branch; those options are for unmanaged workspaces.');
  }
  const lock = await acquireWorktree(binding, 0);
  if (!lock) return { status: 'skipped_in_flight', managed: true, committed: false, repoRoot: binding.local_path };
  try {
    return await engine.transaction(async tx => {
      const enabled = await readManagedMode(tx, { lock: 'share' });
      await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [binding!.worktree_id]);
      const current = await getWorktreeBinding(tx, id!, host);
      const source = await tx.readSourceState(id!, { lock: 'share' });
      if (!enabled || !current || !source || source.archived || isConnectorSourceKind(source.config.kind)
        || source.incarnation !== binding!.source_incarnation || current.source_incarnation !== binding!.source_incarnation
        || current.worktree_id !== binding!.worktree_id || current.owner_host_id !== host || current.state !== 'active'
        || String(current.owner_epoch) !== String(binding!.owner_epoch) || String(current.topology_generation) !== String(binding!.topology_generation)
        || current.local_path !== binding!.local_path || current.coordination_path !== binding!.coordination_path
        || current.relative_path !== binding!.relative_path || !source.local_path
        || canonicalFilesystemPath(source.local_path) !== canonicalFilesystemPath(join(binding!.local_path!, current.relative_path))
        || (!opts.id && !containsPath(canonicalFilesystemPath(source.local_path), requested) && canonicalFilesystemPath(current.local_path!) !== requested)) throw noOwner();
      const result = await pushManagedSourcesHead(binding!.local_path!, opts.scanTimeoutMs);
      return { ...result, managed: true, committed: false, repoRoot: binding!.local_path };
    });
  } finally { await lock.release(); }
}

/** Return false only for the legacy unmanaged route. */
export async function runManagedSourcesPush(engine: BrainEngine, opts: Options): Promise<boolean> {
  try {
    const result = await managedPush(engine, opts);
    if (!result) return false;
    if (opts.json) console.log(JSON.stringify(result));
    else console.log(result.status === 'pushed' ? `Pushed ${result.repoRoot} (committed HEAD; no new commit)` : `skipped: ${result.reason ?? 'canonical worktree is busy'}`);
    return true;
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const result = { status: 'refused', managed: true, code: error.code, reason: error.message, suggestion: error.suggestion, detail: error.detail };
    if (opts.json) console.log(JSON.stringify(result));
    else console.error(`push refused (${error.code}): ${error.message}\n${error.suggestion ?? ''}`);
    return process.exit(['blocked_secrets', 'blocked_tracked_deny', 'publish_secret_found', 'publish_scan_unreadable'].includes(error.code) ? 5 : 1);
  }
}
