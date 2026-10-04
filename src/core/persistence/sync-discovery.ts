import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts } from '../../commands/sync.ts';
import { parseMarkdown } from '../markdown.ts';
import { OperationError, opError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { buildDetachedWorkingTreeManifest, computeSyncDelta } from '../sync-delta.ts';
import { isSyncable, isCodeFilePath, matchesAnyGlob, resolveSlugForPath } from '../sync.ts';
import { resolveSlugRootMode } from '../sync-anchor.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { localHostId } from './identity.ts';
import { sha256 } from './digest.ts';
import { isWindowsColonTarget } from './native-file-target.ts';
import { ERROR_CATALOGUE } from '../error-catalogue.ts';
import { currentCompanyBrainSync } from '../company-brain/profile.ts';
import type { CompanyBrainPlan } from '../company-brain/types.ts';
import { assertDistinctSyncOrigins, legacySyncOrigin, sameSyncOrigin, syncOriginPath, type SyncOriginScope } from './sync-origin.ts';
import { assertManagedSyncActive } from './sync-authority.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';

/** The page an import takes over from its previous origin: a Git rename, or a file that replaced a vanished origin at the same slug. */
export interface SyncRename { sourcePath: string; slug: string; pageId: number; revision: string; }
export interface SyncEntry { path: string; sourcePath: string; action: 'import' | 'delete'; working: boolean; slug?: string; pageId?: number | null; revision?: string | null;
  renameFrom?: SyncRename;
  /** #5565: a deleted file no page records as its origin; its slug's page keeps another origin, so the deletion is a fenced no-op. */
  unownedDeletion?: boolean; }
/** Files that map to a slug another origin keeps; they are left out of the manifest until one is renamed. */
export interface SyncSlugCollision { slug: string; kept: string; skipped: string[]; }
/** #5032: a file sync skipped on this host with a named refusal, without failing the run. */
export interface SyncFileRefusal { path: string; code: 'colon_slug_windows_write_through'; message: string; suggestion: string; docs: string; }
export interface SyncDiscovery { binding: WorktreeBinding; root: string; gitRoot: string; sourceId: string; incarnation: string;
  companyPlan?: CompanyBrainPlan; slugCollisions?: SyncSlugCollision[]; fileRefusals?: SyncFileRefusal[];
  from: string | null; target: string; entries: SyncEntry[]; uncommitted?: { added: number; modified: number; deleted: number }; slugMode: 'git-root' | 'source-root'; }
export interface ManagedSyncContext { binding: WorktreeBinding; root: string; gitRoot: string; sourceId: string; incarnation: string;
  source: { last_commit: string | null; config: Record<string, unknown> }; }
export function syncGit(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
}
/**
 * A sync file or root failed a confinement or identity check. These helpers
 * know no source id, so the read-only fix lists every registered root.
 */
function syncTargetRefusal(code: RegistryCode, message: string, cause: string): OperationError {
  return opError(code, message, `${cause} Nothing was written for it. Inspect the source on its owner (gbrain sources writer status --json lists every registered root), `
    + 'fix the checkout there, then sync that source again; do not bypass the check or change ownership to force it.', {
    fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows each source\'s registered root and owner to compare with the checkout.' },
  });
}
/** The supported managed sync run of one source: local HEAD, no git pull, every guard kept. */
function managedSyncFix(sourceId: string, why: string): Action {
  return { argv: ['gbrain', 'sync', '--no-pull', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false, why,
    verify: { argv: ['gbrain', 'sources', 'status', sourceId] } };
}
export function readSyncFile(root: string, path: string): Buffer | null {
  if (realpathSync(root) !== resolve(root)) throw syncTargetRefusal('source_changed', 'The registered source root was replaced by a symlink.',
    `The registered root holding ${path} is now a symlink.`);
  const absolute = resolve(root, path);
  if (!isWriteTargetContained(absolute, root)) throw syncTargetRefusal('source_changed', 'Sync file escaped its registered root.',
    `${path} resolves outside its registered source root.`);
  try {
    // Reject symlink components, including ones targeting another path inside the root.
    let current = root;
    for (const part of relative(root, absolute).split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw syncTargetRefusal('source_changed', 'Sync cannot publish through a symlink.',
        `A component of ${path} is a symlink; sync reads and publishes only real files inside the root.`);
    }
    if (!lstatSync(absolute).isFile()) throw syncTargetRefusal('source_changed', 'Sync target is not a regular file.',
      `${path} is not a regular file.`);
    if (lstatSync(absolute).size > 10 * 1024 ** 2) throw opError('request_too_large', 'Sync file exceeds the bounded import size.',
      `${path} is larger than the 10 MiB sync import bound, so nothing was imported from it. Shrink or split the file, or add it to the sync.exclude config, then sync its source again.`);
    return readFileSync(absolute);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export const syncRawHash = (root: string, path: string): string | null => { const bytes = readSyncFile(root, path); return bytes === null ? null : sha256(bytes); };
export function assertConfiguredSyncRoot(root: string, configuredRoot: string | null): void {
  if (configuredRoot === null) return;
  try { if (realpathSync.native(resolve(configuredRoot)) === realpathSync.native(root) && realpathSync(root) === root) return; } catch {}
  throw syncTargetRefusal('source_changed', 'The configured source directory no longer matches the accepted sync owner.',
    'The configured directory of this source no longer resolves to the owner\'s registered root (it moved, was re-pointed, or became a symlink).');
}
function syncGitPath(context: Pick<SyncDiscovery, 'root' | 'gitRoot'>, path: string): string {
  return relative(realpathSync.native(context.gitRoot), resolve(realpathSync.native(context.root), path)).split(sep).join('/');
}
export function assertSyncEntryOrigin(context: Pick<SyncDiscovery, 'root' | 'gitRoot' | 'target' | 'slugMode'>,
  entry: Pick<SyncEntry, 'path' | 'sourcePath' | 'action'> & { working?: boolean }): void {
  const gitPath = syncGitPath(context, entry.path);
  const expected = context.slugMode === 'source-root' ? relative(context.root, resolve(context.root, entry.path)).split(sep).join('/') : gitPath;
  const origin = syncOriginPath(entry.sourcePath);
  if (origin !== syncOriginPath(expected)) throw syncTargetRefusal('page_identity_changed', 'The sync path does not match its accepted origin.',
    `${entry.path} no longer maps to its recorded origin ${entry.sourcePath} under this source's root.`);
  if (entry.action !== 'delete') return;
  if (typeof entry.working !== 'boolean') throw new OperationError('page_identity_changed', 'The legacy deletion does not identify its Git or working-tree origin.',
    'Inspect the source identity, then explicitly retry failed sync discovery; the accepted request has not been rewritten.');
  if (entry.working === true) {
    if (readSyncFile(context.root, entry.path) !== null) throw syncTargetRefusal('source_changed', 'The working-tree deletion no longer exists.',
      `${entry.path} is back in the working tree after its deletion was recorded, so the deletion was not applied.`);
    return;
  }
  let tree = context.target;
  const parts = syncOriginPath(gitPath).split('/');
  for (const [index, part] of parts.entries()) {
    const matches = syncGit(context.gitRoot, ['ls-tree', '-z', tree]).split('\0').filter(Boolean).map(row => {
      const tab = row.indexOf('\t'), [mode, kind, object] = row.slice(0, tab).split(' ');
      return { mode, kind, object, name: row.slice(tab + 1) };
    }).filter(item => item.name === part || process.platform === 'win32' && item.name.toLowerCase() === part.toLowerCase());
    if (!matches.length) return;
    if (matches.length !== 1 || index === parts.length - 1 || matches[0].kind !== 'tree') {
      throw new OperationError('page_identity_changed', 'The pinned Git target still contains or aliases the origin selected for deletion.',
        'Inspect the source identity, then explicitly retry failed sync discovery; the accepted request has not been rewritten.');
    }
    tree = matches[0].object;
  }
}
/** A managed-sync `writer_coordinator_required` refusal whose fix is the supported `gbrain sync --no-pull --source <id>` run. */
function managedSyncRefusal(sourceId: string, message: string, suggestion: string): OperationError {
  return opError('writer_coordinator_required', message, suggestion, {
    fix: managedSyncFix(sourceId, 'A managed brain syncs its registered checkout through the persistence coordinator: it imports local HEAD without git pull and keeps every ignored-file and failed-receipt guard.'),
  });
}
/** Validate the current owner and source without enumerating a new manifest. */
export async function resolveManagedSyncContext(engine: BrainEngine, opts: SyncOpts): Promise<ManagedSyncContext> {
  await assertManagedSyncActive(engine);
  const sourceId = opts.sourceId ?? 'default';
  if (!opts.noPull && !opts.dryRun) throw managedSyncRefusal(sourceId, 'Managed sync requires skipping the Git pull (CLI `--no-pull`, sync_brain `no_pull: true`); Git pull/rebase needs an explicit drained maintenance window.',
    `Sync without pulling to import the checkout as it is (CLI: gbrain sync --no-pull --source ${sourceId}; MCP: sync_brain with no_pull: true), or fast-forward and sync the checkout with gbrain sources refresh ${sourceId}.`);
  if (opts.includeGitignored || opts.skipFailed) throw managedSyncRefusal(sourceId, 'Managed sync cannot bypass ignored-file or failed-receipt guards.',
    `Run gbrain sync --no-pull --source ${sourceId} without --include-gitignored or --skip-failed; resolve failed files with --retry-failed after fixing them.`);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; last_commit: string | null; config: Record<string, unknown> }>(
    'SELECT incarnation,archived,local_path,last_commit,config FROM sources WHERE id=$1', [sourceId]);
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!source || source.archived || !binding || binding.source_incarnation !== source.incarnation ||
      binding.owner_host_id !== localHostId() || binding.state !== 'active' || !binding.local_path) {
    throw opError('owner_unavailable', 'Sync must run on the active registered worktree owner.',
      `Source ${sourceId} is archived, re-registered, or not bound to an active worktree owned by this host. Run its sync on the owner host that gbrain sources writer status --source ${sourceId} --json names; do not claim or transfer the source to make this host the owner.`,
      { fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows the owning host, binding state and incarnation of the source.' } });
  }
  const registeredRoot = resolve(binding.local_path, binding.relative_path);
  const root = realpathSync(registeredRoot);
  if (root !== registeredRoot) throw opError('source_changed', 'The registered source root identity changed.',
    `The registered root of ${sourceId} now resolves somewhere else (a symlink or a moved directory), so nothing was synced. Restore the directory on the owner, then run gbrain sync --no-pull --source ${sourceId}.`,
    { fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows the root the owner registered, to compare with the directory on disk.' } });
  assertConfiguredSyncRoot(root, source.local_path);
  const gitRoot = realpathSync(syncGit(root, ['rev-parse', '--show-toplevel']).trim());
  const requested = realpathSync(opts.srcSubpath ? resolve(opts.repoPath ?? gitRoot, opts.srcSubpath) : opts.repoPath ?? root);
  if (realpathSync.native(requested) !== realpathSync.native(root) || !isWriteTargetContained(realpathSync.native(root), realpathSync.native(gitRoot))) throw opError('source_changed', 'Sync path does not match this source binding.',
    `The repository path or source subpath given for ${sourceId} does not resolve to its registered root. Run gbrain sync --no-pull --source ${sourceId} without --repo or --src-subpath so it uses the registered root.`,
    { fix: managedSyncFix(sourceId, 'Without a path override, sync reads the registered root of the source.') });
  if (source.config?.kind != null) throw opError('writer_coordinator_required', 'Connector sync requires its dedicated coordinator.',
    `Source ${sourceId} is a connector source, so the Git sync path does not apply. Run gbrain sync --source ${sourceId} without --repo, --src-subpath or other Git options; it dispatches to the connector.`,
    { fix: { argv: ['gbrain', 'sync', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'The sync command routes a connector source to its own coordinator.' } });
  return { binding, root, gitRoot, sourceId, incarnation: source.incarnation, source };
}
export async function discoverManagedSync(engine: BrainEngine, opts: SyncOpts, context?: ManagedSyncContext): Promise<SyncDiscovery> {
  const { binding, root, gitRoot, sourceId, incarnation, source } = context ?? await resolveManagedSyncContext(engine, opts);
  const company = currentCompanyBrainSync(sourceId);
  const strategy = opts.strategy ?? source.config?.strategy ?? 'markdown';
  const nativeRoot = realpathSync.native(root), nativeGitRoot = realpathSync.native(gitRoot);
  const scope = relative(nativeGitRoot, nativeRoot).split(sep).join('/');
  const probe = resolveSlugForPath(join(scope, 'x.md'));
  const slugMode = company ? 'source-root' : scope ? await resolveSlugRootMode(engine, { sourceId, explicitGitRoot: opts.srcSubpath !== undefined,
    slugPrefix: probe.slice(0, -2), dryRun: true }) : 'git-root';
  const sourcePath = (path: string) => slugMode === 'source-root' && scope ? path.slice(scope.length + 1) : path;
  const originScope: SyncOriginScope = { sourceId, root, scope, slugMode };
  const exclude = [...(opts.exclude ?? []), ...(await engine.getConfig('sync.exclude') ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)]
    .map(v => v.endsWith('/') ? `${v}**` : v);
  const includeHidden = [...new Set([...(opts.includeHidden ?? []), ...(await engine.getConfig('sync.include_hidden') ?? '')
    .split(/[\n,]/).map(v => v.trim()).filter(Boolean)].map(v => v.endsWith('/') ? `${v}**` : v))];
  // Reserved skillpack paths belong to the shared skill publisher; the managed importer always refuses them.
  const eligible = (path: string) => (!scope || path.startsWith(`${scope}/`)) &&
    !matchesAnyGlob(scope ? path.slice(scope.length + 1) : path, exclude) && !isReservedSkillBundlePath(sourcePath(path)) &&
    isSyncable(path, { strategy: strategy as 'markdown', includeHidden });
  const target = company?.plan.revision?.commit ?? syncGit(gitRoot, ['rev-parse', 'HEAD']).trim();
  const detached = !company && syncGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD';
  const working = !company && (detached || (opts.workingTree ?? (await engine.getConfig('sync.include_working_tree') === 'true')));
  const dirty = company ? { added: [], modified: [], deleted: [], renamed: [] } : buildDetachedWorkingTreeManifest(gitRoot);
  const delta = !opts.full && source.last_commit ? computeSyncDelta(gitRoot, source.last_commit, target) : null;
  const entries = new Map<string, SyncEntry>();
  const renamedFrom = new Map<string, string>();
  // #5032: a ':' path has no file on Windows. Each eligible one gets a named
  // refusal and takes no part in this run, including the origin checks below.
  // A deletion or rename touching one is refused on both sides, so the page
  // keeps its identity until the change is synced from macOS or Linux.
  const refused = new Map<string, SyncFileRefusal>();
  const refusalMessages = {
    import: (path: string) => `${path} has a ':' in its name, which Windows cannot store; sync skipped it.`,
    delete: (path: string) => `${path} has a ':' in its name, which Windows cannot reconcile; sync skipped its deletion and its page stays live.`,
  };
  const record = (path: string, message: string) => {
    if (eligible(path)) refused.set(path, { path, code: 'colon_slug_windows_write_through', message,
      suggestion: `Rename it without ':' on a macOS or Linux checkout and commit, then run gbrain sync --source ${sourceId} --no-pull.`,
      docs: ERROR_CATALOGUE.colon_slug_windows_write_through.docs });
  };
  const refuse = (path: string, action: SyncEntry['action'] = 'import') => {
    if (!isWindowsColonTarget(path)) return false;
    record(path, refusalMessages[action](path));
    return true;
  };
  const storable = <T extends { source_path: string | null }>(page: T) => page.source_path === null || !isWindowsColonTarget(page.source_path);
  const put = (path: string, action: SyncEntry['action'], working = false) => {
    if (process.platform === 'win32' && path.includes('\\')) throw opError('page_identity_changed', 'Git paths containing literal backslashes are not safe Windows sync targets.',
      `${path} in ${sourceId} has a literal backslash in its name, which Windows cannot store; nothing was synced. Rename it on a macOS or Linux checkout and commit, then run gbrain sync --no-pull --source ${sourceId}.`);
    if (refuse(path, action)) return;
    if (eligible(path)) entries.set(path, { path: relative(nativeRoot, join(nativeGitRoot, path)).split(sep).join('/'), sourcePath: sourcePath(path), action, working });
  };
  const putRename = (rename: { from: string; to: string }, working = false) => {
    if (isWindowsColonTarget(rename.from) || isWindowsColonTarget(rename.to)) {
      for (const path of [rename.from, rename.to]) {
        record(path, `${path} is one side of the rename ${rename.from} -> ${rename.to}, which Windows cannot reconcile; sync skipped both sides so the page keeps its identity.`);
      }
      return;
    }
    put(rename.from, 'delete', working); put(rename.to, 'import', working); renamedFrom.set(rename.to, rename.from);
  };
  if (delta?.status === 'ok') {
    for (const path of [...delta.manifest.added, ...delta.manifest.modified]) put(path, 'import');
    for (const path of delta.manifest.deleted) put(path, 'delete');
    for (const rename of delta.manifest.renamed) putRename(rename);
  } else {
    const listed = syncGit(gitRoot, ['ls-tree', '-r', '--name-only', '-z', target]).split('\0')
      .filter(path => path && (!scope || path.startsWith(`${scope}/`)));
    const paths = listed.filter(path => !refuse(path));
    assertDistinctSyncOrigins(paths);
    const present = new Set(paths.map(path => syncOriginPath(sourcePath(path))));
    for (const path of paths) put(path, 'import');
    const livePages = await engine.executeRaw<{ slug: string; source_path: string }>('SELECT slug,source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL', [sourceId]);
    const gitPathOf = (origin: string) => slugMode === 'source-root' && scope ? `${scope}/${origin}` : origin;
    const listedSet = new Set(listed);
    for (const page of livePages) if (!storable(page) && !listedSet.has(gitPathOf(page.source_path))) refuse(gitPathOf(page.source_path), 'delete');
    const pages = livePages.filter(storable);
    assertDistinctSyncOrigins([...present, ...pages.map(page => page.source_path)]);
    for (const page of pages) {
      const origin = syncOriginPath(page.source_path);
      const stripped = slugMode === 'source-root' && scope && origin.startsWith(`${scope}/`) ? origin.slice(scope.length + 1) : null;
      if (present.has(origin) || stripped !== null && present.has(stripped) && sameSyncOrigin(origin, stripped, originScope, page.slug)) continue;
      put(gitPathOf(origin), 'delete');
    }
  }
  if (working) {
    for (const path of [...dirty.added, ...dirty.modified]) put(path, 'import', true);
    for (const path of dirty.deleted) put(path, 'delete', true);
    for (const rename of dirty.renamed) putRename(rename, true);
  }
  if (company) {
    entries.clear();
    renamedFrom.clear();
    const included = company.plan.manifest.filter(entry => entry.disposition === 'included');
    const present = new Set(included.map(entry => syncOriginPath(entry.path)));
    for (const entry of included) entries.set(entry.path, { path: entry.path, sourcePath: entry.path, action: 'import', working: false, slug: entry.page!.slug });
    const pages = await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL', [sourceId]);
    assertDistinctSyncOrigins([...present, ...pages.map(page => page.source_path)]);
    for (const page of pages) {
      const origin = syncOriginPath(page.source_path);
      if (!present.has(origin)) entries.set(origin, { path: origin, sourcePath: origin, action: 'delete', working: false });
    }
  }
  const selected = [...entries.values()].sort((a, b) => a.action.localeCompare(b.action) || a.path.localeCompare(b.path));
  const unsupported = selected.find(e => !/\.mdx?$/i.test(e.path) && !isCodeFilePath(e.path));
  if (unsupported) throw opError('writer_coordinator_required', 'Managed image sync requires a prepared importer; this sync was refused before any page write.',
    `Managed sync of ${sourceId} imports only Markdown and code files, and this run selected others (for example ${unsupported.path}). Exclude them with --exclude or the sync.exclude config, then run gbrain sync --no-pull --source ${sourceId}.`);
  if (selected.length > 100_000 || Buffer.byteLength(JSON.stringify(selected)) > 16 * 1024 ** 2) throw opError('request_too_large', 'Sync discovery exceeds the bounded cursor size.',
    `This sync of ${sourceId} selected ${selected.length} entries, above the 100,000-entry and 16 MiB cursor bound; nothing was written. Narrow it with --exclude or the sync.exclude config, then run gbrain sync --no-pull --source ${sourceId}.`);
  const discovered: SyncDiscovery = { ...(refused.size ? { fileRefusals: [...refused.values()] } : {}), binding: { ...binding, owner_epoch: String(binding.owner_epoch), topology_generation: String(binding.topology_generation) }, root, gitRoot, sourceId, incarnation, from: source.last_commit, target, entries: selected, slugMode, ...(company ? { companyPlan: company.plan } : {}) };
  // Freeze all logical identities in one database statement, before yielding
  // between pages. A later interactive edit must conflict with this scan.
  const identities = await engine.executeRaw<{ id: number; slug: string; source_path: string | null; knowledge_revision: string }>(
    'SELECT id,slug,source_path,knowledge_revision FROM pages WHERE source_id=$1', [sourceId]);
  const bySlug = new Map(identities.map(p => [p.slug, p]));
  const byPath = new Map<string, typeof identities>();
  const storableIdentities = identities.filter(storable);
  assertDistinctSyncOrigins([...selected.map(entry => entry.sourcePath), ...storableIdentities.flatMap(page => page.source_path ? [page.source_path] : [])]);
  for (const page of storableIdentities) if (page.source_path) {
    const origin = syncOriginPath(page.source_path);
    byPath.set(origin, [...(byPath.get(origin) ?? []), page]);
  }
  // Imports whose origin has no page yet claim their slug; claims are settled after every entry has one.
  const claims = new Map<string, SyncEntry[]>();
  for (const entry of selected) {
    const legacy = legacySyncOrigin(originScope, syncOriginPath(entry.sourcePath));
    const origins = [...byPath.get(syncOriginPath(entry.sourcePath)) ?? [],
      ...(legacy ? byPath.get(legacy) ?? [] : []).filter(page => sameSyncOrigin(page.source_path!, entry.sourcePath, originScope, page.slug))];
    if (origins.length > 1) throw opError('page_identity_changed', 'Several pages claim the same imported origin.',
      `Pages ${origins.map(page => page.slug).join(', ')} in ${sourceId} all record ${entry.sourcePath} as their origin; nothing was written. Keep one, remove or re-point the others, then run gbrain sync --no-pull --source ${sourceId}.`,
      { fix: { argv: ['gbrain', 'get', '--source', sourceId, '--', origins[0]!.slug], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows one of the pages that claim the origin, to decide which one keeps it.' } });
    let slug = entry.slug ?? origins[0]?.slug ?? resolveSlugForPath(entry.sourcePath);
    if (!slug && entry.action === 'import') slug = parseMarkdown(readSyncContent(discovered, entry), '').slug;
    if (!slug) throw opError('invalid_params', 'The imported file has no usable page slug.',
      `${entry.sourcePath} in ${sourceId} yields no page slug from its path or frontmatter; nothing was written. Rename the file or set a frontmatter slug and commit, then run gbrain sync --no-pull --source ${sourceId}.`);
    if (!company && entry.action === 'import' && !origins.length && !isCodeFilePath(entry.sourcePath)) {
      entry.slug = slug;
      claims.set(slug, [...(claims.get(slug) ?? []), entry]);
      continue;
    }
    const page = origins[0] ?? bySlug.get(slug);
    const foreignOrigin = page?.source_path != null && !sameSyncOrigin(page.source_path, entry.sourcePath, originScope, page.slug);
    // Deleting a file that no page records (a skipped slug twin) must not delete the page another file backs.
    const unownedDeletion = foreignOrigin && entry.action === 'delete' && !origins.length && !company;
    if (foreignOrigin && !unownedDeletion) {
      const error = new OperationError('page_identity_changed', 'A different origin occupies the imported slug.',
        `Page ${slug} in source ${sourceId} records the origin '${page.source_path}', but sync found it at '${entry.sourcePath}'. On the brain host, rename or move one of the two files so each page has one origin, commit, then run gbrain sync --source ${sourceId} --no-pull --retry-failed.`);
      error.detail = 'sync_origin_mismatch';
      throw error;
    }
    Object.assign(entry, { slug, pageId: page?.id ?? null, revision: page?.knowledge_revision ?? null, ...(unownedDeletion ? { unownedDeletion: true } : {}) });
  }
  const deletions = new Map(selected.filter(entry => entry.action === 'delete').map(entry => [syncOriginPath(entry.sourcePath), entry]));
  // A soft-delete advances knowledge_revision, so the frozen revisions still guard this read.
  const deleted = new Set(claims.size ? (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND deleted_at IS NOT NULL', [sourceId])).map(row => row.id) : []);
  // Origins that differ only by case or separator spelling may be one file on another platform; refuse rather than
  // guess. The one exception is a case-only respelling whose old file this very sync removes.
  const spelling = (origin: string) => origin.replaceAll('\\', '/').toLowerCase();
  const retired = new Set<SyncEntry>();
  const collisions: SyncSlugCollision[] = [];
  const gitPath = (entry: SyncEntry) => relative(nativeGitRoot, join(nativeRoot, entry.path)).split(sep).join('/');
  for (const [slug, candidates] of claims) {
    const holder = bySlug.get(slug);
    // A legacy Git-root spelling of a source-root origin (#5610) is matched against this sync's deletions by its source-relative form.
    const recorded = holder?.source_path == null ? null : syncOriginPath(holder.source_path);
    const prefix = originScope?.slugMode === 'source-root' && originScope.scope ? `${originScope.scope}/` : null;
    const holderOrigin = recorded !== null && prefix && recorded.startsWith(prefix) && sameSyncOrigin(recorded, recorded.slice(prefix.length), originScope, holder!.slug)
      ? recorded.slice(prefix.length) : recorded;
    const respelled = holderOrigin !== null && !holderOrigin.includes('\\') && deletions.has(holderOrigin);
    const spellings = [...(holderOrigin === null || respelled ? [] : [holderOrigin]), ...candidates.map(entry => syncOriginPath(entry.sourcePath))].map(spelling);
    if (new Set(spellings).size !== spellings.length) throw opError('page_identity_changed', 'Sync origins for one slug differ only by case or separator spelling.',
      `Files mapping to page ${slug} in ${sourceId} differ only by case or separator spelling (${candidates.slice(0, 3).map(entry => entry.sourcePath).join(', ')}); nothing was written. Keep one spelling, rename or remove the others and commit, then run gbrain sync --no-pull --source ${sourceId}.`);
    // A live page keeps its slug while its own file is still in the tree; the newcomer is the collision.
    const kept = holder && !deleted.has(holder.id) && holderOrigin !== null && !deletions.has(holderOrigin) ? holderOrigin : null;
    const winner = kept === null ? candidates.find(entry => /\.mdx?$/i.test(entry.sourcePath) && entry.sourcePath.replace(/\.mdx?$/i, '') === slug) ?? candidates[0] : null;
    const losers = candidates.filter(entry => entry !== winner);
    for (const entry of losers) retired.add(entry);
    if (losers.length) collisions.push({ slug, kept: kept ?? winner!.sourcePath, skipped: losers.map(entry => entry.sourcePath) });
    if (!winner) continue;
    if (holder) {
      // Same slug, vanished origin: the file takes over the page (and its history) instead of racing a deletion.
      Object.assign(winner, { pageId: holder.id, revision: holder.knowledge_revision });
      if (holderOrigin !== null) {
        winner.renameFrom = { sourcePath: holder.source_path!, slug, pageId: holder.id, revision: holder.knowledge_revision };
        const deletion = deletions.get(holderOrigin);
        if (deletion) retired.add(deletion);
      }
      continue;
    }
    Object.assign(winner, { pageId: null, revision: null });
    const from = renamedFrom.get(gitPath(winner));
    const deletion = from === undefined ? undefined : [...deletions.values()].find(entry => gitPath(entry) === from);
    const moved = deletion?.pageId == null ? undefined : identities.find(page => page.id === deletion.pageId);
    if (deletion && moved && !deleted.has(moved.id) && moved.source_path != null) {
      // A Git rename moves the page to its new slug, like the library path's updateSlug: same page id, inbound links and an alias.
      winner.renameFrom = { sourcePath: moved.source_path, slug: moved.slug, pageId: moved.id, revision: moved.knowledge_revision };
      retired.add(deletion);
    }
  }
  if (retired.size) discovered.entries = selected.filter(entry => !retired.has(entry));
  if (collisions.length) discovered.slugCollisions = collisions;
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
    if (bytes === null) throw opError('source_changed', 'The discovered working-tree file disappeared.',
      `${entry.path} left the working tree of ${discovery.sourceId} between discovery and import, so nothing was imported from it. Run gbrain sync --no-pull --source ${discovery.sourceId} to rediscover the tree.`,
      { fix: managedSyncFix(discovery.sourceId, 'A new discovery reads the working tree as it is now.') });
    return bytes.toString('utf8');
  }
  return syncGit(discovery.gitRoot, ['show', `${discovery.target}:${syncGitPath(discovery, entry.path)}`]);
}
