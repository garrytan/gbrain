/**
 * The storage manifest source (GST-1943): one source, `storage`, holding a card per archived item. It is never
 * federated, so ordinary search and bound remote clients without a grant naming it never see cards, and only the
 * storage verbs write it (the page door refuses every other writer, see `assertStorageSourceWriter`).
 *
 * Repo-less brain: a database-only source, created by the first `storage_register`; the database is the record.
 * Repo brain (any active source with a directory): git stays the parent, so the shelf is a hosted git-canonical
 * repository (`hostRepo`), created only by `gbrain storage init` after its preview, which needs managed persistence.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { STORAGE_ROLE, STORAGE_SOURCE_ID } from './door.ts';
import { readFix } from '../ops/op-fix.ts';
import { normalizeSourceConfig, parseSourceConfig } from '../sources-load.ts';
import { addSource } from '../sources-ops.ts';
import { hostRepo, type HostRepoPlan } from '../persistence/hosted-repo.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { syncContentDirectory } from '../sync-applicability.ts';

export { STORAGE_ROLE, STORAGE_SOURCE_ID, storageDoorContext, isStorageDoor, assertStorageSourceWriter } from './door.ts';

export function isStorageRole(config: unknown): boolean {
  return parseSourceConfig(config).role === STORAGE_ROLE;
}

/** `ours`: an empty source a shelf creation started and did not finish marking (hosted by storage init, or database-only). */
export interface StorageSourceState { exists: boolean; archived: boolean; repoBrain: boolean; role: boolean; hosted: boolean; ours: boolean }

/**
 * A repo brain is one with any active source that has a directory (or the legacy sync.repo_path of default); mixed
 * brains count. The gbrain-owned content directory `gbrain init` creates holds no Git checkout, so it does not count.
 */
export async function isRepoBrain(engine: BrainEngine): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: string; local_path: string }>('SELECT id, local_path FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL AND id <> $1', [STORAGE_SOURCE_ID]);
  for (const row of rows) if (!await syncContentDirectory(engine, { sourceId: row.id, repoPath: row.local_path })) return true;
  return !!(await engine.getConfig('sync.repo_path'));
}

export async function storageSourceState(engine: BrainEngine): Promise<StorageSourceState> {
  const [row] = await engine.executeRaw<{ config: unknown; archived: boolean; local_path: string | null; pages: boolean }>(
    'SELECT s.config, s.archived, s.local_path, EXISTS (SELECT 1 FROM pages p WHERE p.source_id = s.id) AS pages FROM sources s WHERE s.id=$1', [STORAGE_SOURCE_ID]);
  const config = row ? parseSourceConfig(row.config) : {};
  const hosted = !!config.hosted_repo;
  return { exists: !!row && !row.archived, archived: !!row?.archived, repoBrain: await isRepoBrain(engine), role: config.role === STORAGE_ROLE, hosted,
    ours: !!row && !row.pages && (hosted || !row.local_path) };
}

/** A `storage` source a shelf creation left without its role (a crash or a concurrent first write), which the next storage write or init finishes. */
const unfinished = (state: StorageSourceState) => state.exists && !state.role && state.ours && (state.hosted || !state.repoBrain);

function notOurs() {
  return opError('storage_manifest_missing', `Source ${STORAGE_SOURCE_ID} exists but is not a storage manifest; nothing was written.`,
    `The storage shelf needs the source ID ${STORAGE_SOURCE_ID}. Ask the user what that source holds before anything else; gbrain sources list shows it. Its pages stay where they are.`);
}

function archivedShelf() {
  return opError('storage_manifest_missing', `Source ${STORAGE_SOURCE_ID} is archived; nothing was written.`,
    `Ask the user whether to bring it back with gbrain sources restore ${STORAGE_SOURCE_ID} (gbrain sources archived shows when it would be purged).`);
}

function initFix() {
  return readFix('Previews creating the storage shelf on this brain; changes nothing.', { argv: ['gbrain', 'storage', 'init', '--dry-run'] });
}

async function markRole(engine: BrainEngine): Promise<void> {
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [STORAGE_SOURCE_ID]);
  const config = parseSourceConfig(row?.config);
  config.role = STORAGE_ROLE;
  config.federated = false;
  await engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2', [JSON.stringify(normalizeSourceConfig(config)), STORAGE_SOURCE_ID]);
}

/**
 * Whether a storage write can land: throws the refusal it would get, and says whether the first write creates the
 * database-only shelf (a repo-less brain) or finishes one a crash or a concurrent first write left without its role.
 * A repo brain must run `gbrain storage init` first; any other `storage` source without the role is someone else's,
 * refused. Writes nothing.
 */
export async function shelfWritable(engine: BrainEngine): Promise<{ creates: boolean; exists: boolean }> {
  const state = await storageSourceState(engine);
  if (state.archived) throw archivedShelf();
  if (state.exists && state.role) return { creates: false, exists: true };
  if (unfinished(state)) return { creates: true, exists: true };
  if (state.exists) throw notOurs();
  if (state.repoBrain) throw opError('storage_manifest_missing', 'This brain keeps its pages in Git, so the storage shelf is a hosted Git repository that gbrain storage init creates; nothing was written.',
    'Preview it with gbrain storage init --dir <absolute path> --dry-run, and apply the command it prints after the user agrees. It needs managed persistence (gbrain sources writer activate).',
    { fix: initFix() });
  return { creates: true, exists: false };
}

/** The shelf a storage write lands in: a repo-less brain gets its database-only source on first use (see shelfWritable). */
export async function ensureStorageSource(engine: BrainEngine): Promise<void> {
  const { creates, exists } = await shelfWritable(engine);
  if (!creates) return;
  if (!exists) {
    try { await addSource(engine, { id: STORAGE_SOURCE_ID, name: 'Storage manifest', federated: false }); } catch (error) {
      const now = await storageSourceState(engine);
      if (!now.exists || (!now.role && !unfinished(now))) throw error;
    }
  }
  await markRole(engine);
}

export interface StorageInitResult { action: 'none' | 'create_database_source' | 'host_repo'; dry_run: boolean; repo_brain: boolean; summary: string[]; apply?: string[]; plan?: HostRepoPlan }

/** `gbrain storage init`: preview, then apply. Repo-less: a database-only source. Repo brain: hostRepo, then the role. */
export async function initStorageSource(engine: BrainEngine, opts: { dir?: string; pushRemote?: string; dryRun: boolean; expect?: string }): Promise<StorageInitResult> {
  const state = await storageSourceState(engine);
  if (state.archived) throw archivedShelf();
  if (state.exists && state.role && (!state.repoBrain || state.hosted)) {
    return { action: 'none', dry_run: opts.dryRun, repo_brain: state.repoBrain, summary: [`The storage shelf (source ${STORAGE_SOURCE_ID}) already exists${state.hosted ? ' as a hosted Git repository' : ''}.`] };
  }
  if (unfinished(state)) {
    const summary = [`Marks source ${STORAGE_SOURCE_ID}, which an earlier storage init or first register created, as the storage shelf (not federated).`];
    if (!opts.dryRun) await markRole(engine);
    return { action: 'none', dry_run: opts.dryRun, repo_brain: state.repoBrain, summary, ...(opts.dryRun ? { apply: ['gbrain', 'storage', 'init'] } : {}) };
  }
  if (state.exists && !state.role) throw notOurs();
  if (!state.repoBrain) {
    const summary = [`Creates source ${STORAGE_SOURCE_ID}, database-only and not federated, as the storage shelf. This brain has no Git checkout, so the database is the record.`];
    if (opts.dryRun) return { action: 'create_database_source', dry_run: true, repo_brain: false, summary, apply: ['gbrain', 'storage', 'init'] };
    await ensureStorageSource(engine);
    return { action: 'create_database_source', dry_run: false, repo_brain: false, summary };
  }
  if (!opts.dir) throw opError('invalid_params', 'This brain keeps its pages in Git, so the storage shelf needs a directory for its hosted repository.',
    'Pass --dir <absolute path outside every checkout>; nothing was changed.', { fix: initFix() });
  if (!await managedPersistenceEnabled(engine)) throw opError('strict_requires_managed',
    'The storage shelf on a brain with a Git checkout is a git-canonical hosted repository, which needs managed persistence; nothing was created.',
    'Ask the user whether to turn on managed persistence for this brain (gbrain sources writer activate), then preview gbrain storage init again.');
  const plan = await hostRepo(engine, { sourceId: STORAGE_SOURCE_ID, dir: opts.dir, dryRun: opts.dryRun, ...(opts.pushRemote ? { pushRemote: opts.pushRemote } : {}), ...(opts.expect ? { expect: opts.expect } : {}) });
  const apply = plan.apply ? ['gbrain', 'storage', 'init', '--dir', opts.dir, ...(opts.pushRemote ? ['--push-remote', opts.pushRemote] : []), '--expect', plan.plan_hash] : undefined;
  if (!plan.dry_run) await markRole(engine);
  return { action: 'host_repo', dry_run: plan.dry_run, repo_brain: true, summary: [...plan.summary, 'The source is not federated and only the storage verbs write it.'], ...(apply ? { apply } : {}), plan };
}
