import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts } from '../../commands/sync.ts';
import { parseMarkdown } from '../markdown.ts';
import { OperationError } from '../ops/contract.ts';
import { buildDetachedWorkingTreeManifest, computeSyncDelta } from '../sync-delta.ts';
import { isSyncable, isCodeFilePath, matchesAnyGlob, resolveSlugForPath } from '../sync.ts';
import { resolveSlugRootMode } from '../sync-anchor.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { localHostId } from './identity.ts';
import { sha256 } from './digest.ts';
import { currentCompanyBrainSync } from '../company-brain/profile.ts';
import type { CompanyBrainPlan } from '../company-brain/types.ts';

export interface SyncEntry { path: string; sourcePath: string; action: 'import' | 'delete'; working: boolean; slug?: string; pageId?: number | null; revision?: string | null; }
export interface SyncDiscovery { binding: WorktreeBinding; root: string; gitRoot: string; sourceId: string; incarnation: string;
  companyPlan?: CompanyBrainPlan;
  from: string | null; target: string; entries: SyncEntry[]; uncommitted?: { added: number; modified: number; deleted: number }; slugMode: 'git-root' | 'source-root'; }
export interface ManagedSyncContext { binding: WorktreeBinding; root: string; gitRoot: string; sourceId: string; incarnation: string;
  source: { last_commit: string | null; config: Record<string, unknown> }; }
export function syncGit(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function readSyncFile(root: string, path: string): Buffer | null {
  if (realpathSync(root) !== resolve(root)) throw new OperationError('source_changed', 'The registered source root was replaced by a symlink.');
  const absolute = resolve(root, path);
  if (!isWriteTargetContained(absolute, root)) throw new OperationError('source_changed', 'Sync file escaped its registered root.');
  try {
    // Reject symlink components, including ones targeting another path inside the root.
    let current = root;
    for (const part of relative(root, absolute).split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new OperationError('source_changed', 'Sync cannot publish through a symlink.');
    }
    if (!lstatSync(absolute).isFile()) throw new OperationError('source_changed', 'Sync target is not a regular file.');
    if (lstatSync(absolute).size > 10 * 1024 ** 2) throw new OperationError('request_too_large', 'Sync file exceeds the bounded import size.');
    return readFileSync(absolute);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export const syncRawHash = (root: string, path: string): string | null => { const bytes = readSyncFile(root, path); return bytes === null ? null : sha256(bytes); };
/** Validate the current owner and source without enumerating a new manifest. */
export async function resolveManagedSyncContext(engine: BrainEngine, opts: SyncOpts): Promise<ManagedSyncContext> {
  if (!opts.noPull && !opts.dryRun) throw new OperationError('writer_coordinator_required', 'Managed sync requires --no-pull; Git pull/rebase needs an explicit drained maintenance window.');
  if (opts.includeGitignored || opts.skipFailed) throw new OperationError('writer_coordinator_required', 'Managed sync cannot bypass ignored-file or failed-receipt guards.');
  const sourceId = opts.sourceId ?? 'default';
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; last_commit: string | null; config: Record<string, unknown> }>(
    'SELECT incarnation,archived,local_path,last_commit,config FROM sources WHERE id=$1', [sourceId]);
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!source || source.archived || !binding || binding.source_incarnation !== source.incarnation ||
      binding.owner_host_id !== localHostId() || binding.state !== 'active' || !binding.local_path) {
    throw new OperationError('owner_unavailable', 'Sync must run on the active registered worktree owner.');
  }
  const registeredRoot = resolve(binding.local_path, binding.relative_path);
  const root = realpathSync(registeredRoot);
  if (root !== registeredRoot) throw new OperationError('source_changed', 'The registered source root identity changed.');
  const gitRoot = realpathSync(syncGit(root, ['rev-parse', '--show-toplevel']).trim());
  const requested = realpathSync(opts.srcSubpath ? resolve(opts.repoPath ?? gitRoot, opts.srcSubpath) : opts.repoPath ?? root);
  if (requested !== root || !isWriteTargetContained(root, gitRoot)) throw new OperationError('source_changed', 'Sync path does not match this source binding.');
  if (source.config?.kind != null) throw new OperationError('writer_coordinator_required', 'Connector sync requires its dedicated coordinator.');
  return { binding, root, gitRoot, sourceId, incarnation: source.incarnation, source };
}
export async function discoverManagedSync(engine: BrainEngine, opts: SyncOpts, context?: ManagedSyncContext): Promise<SyncDiscovery> {
  const { binding, root, gitRoot, sourceId, incarnation, source } = context ?? await resolveManagedSyncContext(engine, opts);
  const company = currentCompanyBrainSync(sourceId);
  const strategy = opts.strategy ?? source.config?.strategy ?? 'markdown';
  const scope = relative(gitRoot, root).split(sep).join('/');
  const probe = resolveSlugForPath(join(scope, 'x.md'));
  const slugMode = company ? 'source-root' : scope ? await resolveSlugRootMode(engine, { sourceId, explicitGitRoot: opts.srcSubpath !== undefined,
    slugPrefix: probe.slice(0, -2), dryRun: true }) : 'git-root';
  const sourcePath = (path: string) => slugMode === 'source-root' && scope ? path.slice(scope.length + 1) : path;
  const exclude = [...(opts.exclude ?? []), ...(await engine.getConfig('sync.exclude') ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)]
    .map(v => v.endsWith('/') ? `${v}**` : v);
  const includeHidden = [...new Set([...(opts.includeHidden ?? []), ...(await engine.getConfig('sync.include_hidden') ?? '')
    .split(/[\n,]/).map(v => v.trim()).filter(Boolean)].map(v => v.endsWith('/') ? `${v}**` : v))];
  const eligible = (path: string) => (!scope || path.startsWith(`${scope}/`)) &&
    !matchesAnyGlob(scope ? path.slice(scope.length + 1) : path, exclude) &&
    isSyncable(path, { strategy: strategy as 'markdown', includeHidden });
  const target = company?.plan.revision?.commit ?? syncGit(gitRoot, ['rev-parse', 'HEAD']).trim();
  const detached = !company && syncGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD';
  const working = !company && (detached || (opts.workingTree ?? (await engine.getConfig('sync.include_working_tree') === 'true')));
  const dirty = company ? { added: [], modified: [], deleted: [], renamed: [] } : buildDetachedWorkingTreeManifest(gitRoot);
  const delta = !opts.full && source.last_commit ? computeSyncDelta(gitRoot, source.last_commit, target) : null;
  const entries = new Map<string, SyncEntry>();
  const put = (path: string, action: SyncEntry['action'], working = false) => {
    if (eligible(path)) entries.set(path, { path: relative(root, join(gitRoot, path)).split(sep).join('/'), sourcePath: sourcePath(path), action, working });
  };
  if (delta?.status === 'ok') {
    for (const path of [...delta.manifest.added, ...delta.manifest.modified]) put(path, 'import');
    for (const path of delta.manifest.deleted) put(path, 'delete');
    for (const rename of delta.manifest.renamed) { put(rename.from, 'delete'); put(rename.to, 'import'); }
  } else {
    const paths = syncGit(gitRoot, ['ls-tree', '-r', '--name-only', '-z', target]).split('\0').filter(Boolean);
    const present = new Set(paths.map(sourcePath));
    for (const path of paths) put(path, 'import');
    const pages = await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL', [sourceId]);
    for (const page of pages) if (!present.has(page.source_path)) put(slugMode === 'source-root' && scope ? `${scope}/${page.source_path}` : page.source_path, 'delete');
  }
  if (working) {
    for (const path of [...dirty.added, ...dirty.modified]) put(path, 'import', true);
    for (const path of dirty.deleted) put(path, 'delete', true);
    for (const rename of dirty.renamed) { put(rename.from, 'delete', true); put(rename.to, 'import', true); }
  }
  if (company) {
    entries.clear();
    const included = company.plan.manifest.filter(entry => entry.disposition === 'included');
    const present = new Set(included.map(entry => entry.path));
    for (const entry of included) entries.set(entry.path, { path: entry.path, sourcePath: entry.path, action: 'import', working: false, slug: entry.page!.slug });
    const pages = await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL', [sourceId]);
    for (const page of pages) if (!present.has(page.source_path)) entries.set(page.source_path, { path: page.source_path, sourcePath: page.source_path, action: 'delete', working: false });
  }
  const selected = [...entries.values()].sort((a, b) => a.action.localeCompare(b.action) || a.path.localeCompare(b.path));
  if (selected.some(e => !/\.mdx?$/i.test(e.path) && !isCodeFilePath(e.path))) throw new OperationError('writer_coordinator_required', 'Managed image sync requires a prepared importer; this sync was refused before any page write.');
  if (selected.length > 100_000 || Buffer.byteLength(JSON.stringify(selected)) > 16 * 1024 ** 2) throw new OperationError('request_too_large', 'Sync discovery exceeds the bounded cursor size.');
  const discovered: SyncDiscovery = { binding: { ...binding, owner_epoch: String(binding.owner_epoch), topology_generation: String(binding.topology_generation) }, root, gitRoot, sourceId, incarnation, from: source.last_commit, target, entries: selected, slugMode, ...(company ? { companyPlan: company.plan } : {}) };
  // Freeze all logical identities in one database statement, before yielding
  // between pages. A later interactive edit must conflict with this scan.
  const identities = await engine.executeRaw<{ id: number; slug: string; source_path: string | null; knowledge_revision: string }>(
    'SELECT id,slug,source_path,knowledge_revision FROM pages WHERE source_id=$1', [sourceId]);
  const bySlug = new Map(identities.map(p => [p.slug, p]));
  const byPath = new Map<string, typeof identities>();
  for (const page of identities) if (page.source_path) byPath.set(page.source_path, [...(byPath.get(page.source_path) ?? []), page]);
  for (const entry of selected) {
    const origins = byPath.get(entry.sourcePath) ?? [];
    if (origins.length > 1) throw new OperationError('page_identity_changed', 'Several pages claim the same imported origin.');
    let slug = entry.slug ?? origins[0]?.slug ?? resolveSlugForPath(entry.sourcePath);
    if (!slug && entry.action === 'import') slug = parseMarkdown(readSyncContent(discovered, entry), '').slug;
    if (!slug) throw new OperationError('invalid_params', 'The imported file has no usable page slug.');
    const page = origins[0] ?? bySlug.get(slug);
    if (page?.source_path != null && page.source_path !== entry.sourcePath) throw new OperationError('page_identity_changed', 'A different origin occupies the imported slug.');
    Object.assign(entry, { slug, pageId: page?.id ?? null, revision: page?.knowledge_revision ?? null });
  }
  if (!working) {
    const uncommitted = { added: new Set([...dirty.added,...dirty.renamed.map(r=>r.to)].filter(eligible)).size,
      modified: new Set(dirty.modified.filter(eligible)).size,
      deleted: new Set([...dirty.deleted,...dirty.renamed.map(r=>r.from)].filter(eligible)).size };
    if (uncommitted.added || uncommitted.modified || uncommitted.deleted) discovered.uncommitted = uncommitted;
  }
  return discovered;
}
export function readSyncContent(discovery: SyncDiscovery, entry: SyncEntry): string {
  if (entry.working) {
    const bytes = readSyncFile(discovery.root, entry.path);
    if (bytes === null) throw new OperationError('source_changed', 'The discovered working-tree file disappeared.');
    return bytes.toString('utf8');
  }
  return syncGit(discovery.gitRoot, ['show', `${discovery.target}:${relative(discovery.gitRoot, join(discovery.root, entry.path)).split(sep).join('/')}`]);
}
