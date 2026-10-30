import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts } from '../../commands/sync.ts';
import { parseMarkdown } from '../markdown.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { managedForbiddenFlag, managedSyncFlagRefusal } from './managed-sync-flags.ts';
import type { Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { buildDetachedWorkingTreeManifest, computeSyncDelta } from '../sync-delta.ts';
import { confirmedSyncDelta, confirmRenameIdentities, explicitIdVeto, frontmatterIdentity, identityHeadDigest } from '../sync-rename-identity.ts';
import { isSyncable, isSyncMetafile, isCodeFilePath, isImageFilePath, matchesAnyGlob, readMetafilePagesMode, resolveSlugForPath, slugifyPath, type DowngradedRename, type SyncManifest } from '../sync.ts';
import { diskMetafileHeads, firstMetafileHead, gitMetafileHeads, listMetafileNamedBlobs, metafilePagePredicate, type GitMetafileHeads } from '../sync-metafile-pages.ts';
import { databaseOnlyPageSql } from './unbound-pages.ts';
import { validateSlug } from '../utils.ts';
import { resolveSlugRootMode } from '../sync-anchor.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { unboundBindCommand } from './unbound-source.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { ownerUnavailableReason } from './owner-refusal.ts';
import { sha256 } from './digest.ts';
import { isWindowsColonTarget } from './native-file-target.ts';
import { ERROR_CATALOGUE } from '../error-catalogue.ts';
import { currentCompanyBrainSync } from '../company-brain/profile.ts';
import type { CompanyBrainPlan } from '../company-brain/types.ts';
import { assertDistinctSyncOrigins, legacySyncOrigin, sameSyncOrigin, selectOriginClaimant, sharedOriginExit, syncOriginPath, type SyncOriginScope } from './sync-origin.ts';
import { assertManagedSyncActive } from './sync-authority.ts';
import { decideOriginTwins, readOriginClaimants, slugPathOccupied, type OriginConflict } from './origin-twins.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { holdBasisMoved, holdRescreenDue, readGitHoldRetryPaths, readGitSourceHolds, readSyncImportProvenances } from './sync-holds.ts';
import { readBlobContents, readTreeBlobs, SYNC_READ_BOUND } from './sync-blobs.ts';
import { gitChildEnv } from '../git-env.ts';
import { readOriginEvidence } from './sync-origin-evidence.ts';
import { sourceDbOnlyVerdict } from './source-storage.ts';
import { movedDriftHolds, prescreenSyncEntries, type SyncDriftSide } from './sync-prescreen.ts';
import { sliceEntries, type SyncSliceCursor, type SyncSliceState } from './sync-slices.ts';

/** The page an import takes over from its previous origin: a Git rename, or a file that replaced a vanished origin at the same slug. */
export interface SyncRename { sourcePath: string; slug: string; pageId: number; revision: string; }
export interface SyncEntry { path: string; sourcePath: string; action: 'import' | 'delete'; working: boolean; slug?: string; pageId?: number | null; revision?: string | null;
  renameFrom?: SyncRename;
  /** #6729: a dirty-tree rename's verdict digest (see `SyncManifest.renamed`); readSyncContent refuses bytes that differ. */
  identityHead?: string;
  /** #5565: a deleted file no page records as its origin; its slug's page keeps another origin, so the deletion is a fenced no-op. */
  unownedDeletion?: boolean;
  /** G3: a strict source's entry; the freeze reads its commit alone and publication never compares the working tree. */
  committedOnly?: true;
  /** #5988: a held rename destination whose source page changed since the rename was recorded; the freeze screen holds it as `rename_held`. */
  renameHeld?: SyncRename;
  /** #6712 PR 1: the import provenance matches the pinned blob, the frozen revision and this parser; the no-op kernel decides (sync-prescreen.ts). */
  prescreened?: true;
  /** #6712 PR 1: the page moved since its last recorded import (or has no record); imported only when the freeze proves it a no-op, else held `file_drift`. */
  drift?: SyncDriftSide;
  /** #6712: for `both`, the blob the last recorded import left on disk; #7338: for `unknown`, the file at the baseline commit. The freeze imports when the page still holds what that blob imports. */
  driftBaseline?: string;
  /** #6727: live pages with no recorded origin whose slugs fold to this file's slug, several or one the importer cannot write; the freeze holds it `legacy_slug_conflict`. */
  legacySlugs?: string[];
  /** #6729 x #6727: the one legacy page carries an explicit frontmatter id that differs from the file's, so it is another document; held `legacy_slug_conflict` (`explicit_id_conflict`). */
  legacyIdVeto?: true;
  /** #6948: several live pages record this file as their origin; the freeze holds it `origin_conflict` (sync.holds=fail refuses). */
  originConflict?: OriginConflict;
  /** GBRA-133: a held committed deletion `sync.apply_held_deletions` proved (sync-held-deletions.ts); its request carries the proof as the receipt. */
  heldDeletion?: { commit: string; blob_oid: string }; }
/** Files that map to a slug another origin keeps; they are left out of the manifest until one is renamed. */
export interface SyncSlugCollision { slug: string; kept: string; skipped: string[]; }
/** #5032: a file sync skipped on this host with a named refusal, without failing the run. */
export interface SyncFileRefusal { path: string; code: 'colon_slug_windows_write_through'; message: string; suggestion: string; docs: string; }
export interface SyncDiscovery { binding: WorktreeBinding; root: string; gitRoot: string; sourceId: string; incarnation: string;
  companyPlan?: CompanyBrainPlan; slugCollisions?: SyncSlugCollision[]; fileRefusals?: SyncFileRefusal[];
  from: string | null; target: string; entries: SyncEntry[]; uncommitted?: { added: number; modified: number; deleted: number }; slugMode: 'git-root' | 'source-root';
  /** #5988: when this discovery ran; holds this run writes or clears are conditional on it. */
  discoveredAt?: string;
  /** #5988: held paths that left the source (now excluded); their holds clear when the run checkpoints. */
  releasedHolds?: string[];
  /** #5988: `sources retry-held` paths this discovery consumed (screened as an entry or a candidate, or no longer eligible); cleared with the cursor save. */
  retryTaken?: string[];
  /** #6349: the checkout's HEAD when the delta to it exceeded the cursor bound and `target` is a staged first-parent commit short of it. */
  stagedHead?: string;
  /** #5459 (P4.5): live pages the tree walk left alone because their file is in the working tree and their import provenance is the working tree or unknown. */
  workingTreeKept?: string[];
  /** #7130: live pages whose file is absent but Git never committed it (or `.gitignore` excludes it): kept, never deleted. */
  uncommittedKept?: string[];
  /** #8007: live pages whose file is absent while gbrain.yml's storage section is invalid, so whether each is database-only is unknown: kept, never deleted. */
  storageInvalidKept?: string[];
  /** #6349 (P4.4): this discovery is one path slice of its target; the checkpoint records it instead of advancing `last_commit` until `done`. */
  slice?: SyncSliceState;
  /** #6729: inexact Git renames split into a delete plus an add (origin form); recorded after the run commits. */
  identityDowngrades?: DowngradedRename[]; }
/** #5032: the per-file refusal text for a Windows-unstorable ':' path, by the side sync skipped. */
export const COLON_REFUSAL_MESSAGES = { import: (path: string) => `${path} has a ':' in its name, which Windows cannot store; sync skipped it.`,
  delete: (path: string) => `${path} has a ':' in its name, which Windows cannot reconcile; sync skipped its deletion and its page stays live.`,
  rename: (path: string, from: string, to: string) => `${path} is one side of the rename ${from} -> ${to}, which Windows cannot reconcile; sync skipped both sides so the page keeps its identity.` };
/** #5032: the named refusal of one Windows-unstorable ':' path (discovery and the pass, sync-pass.ts). */
export function colonFileRefusal(sourceId: string, path: string, message: string): SyncFileRefusal {
  return { path, code: 'colon_slug_windows_write_through', message,
    suggestion: `Rename it without ':' on a macOS or Linux checkout and commit, then run gbrain sync --source ${sourceId} --no-pull.`,
    docs: ERROR_CATALOGUE.colon_slug_windows_write_through.docs };
}
export interface ManagedSyncContext { binding: WorktreeBinding; root: string; gitRoot: string; sourceId: string; incarnation: string;
  source: { last_commit: string | null; config: Record<string, unknown> }; }
/** The persisted `sync.exclude` globs (plus a run's `--exclude`), as discovery matches them against a path relative to the source root. */
export async function syncExcludePatterns(engine: Pick<BrainEngine, 'getConfig'>, extra: readonly string[] = []): Promise<string[]> {
  return [...extra, ...(await engine.getConfig('sync.exclude') ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)]
    .map(v => v.endsWith('/') ? `${v}**` : v);
}
export function syncGit(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args],
    { env: gitChildEnv(), encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
}
/** `syncGit` without blocking the event loop while Git runs (a level read: a synchronous spawn held timers for 200+ ms on a loaded host). */
const execFileAsync = promisify(execFile);
export async function syncGitAsync(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-c', 'core.quotepath=false', '-C', root, ...args], { env: gitChildEnv(), encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 ** 2 })).stdout;
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
/**
 * The checked absolute path of a sync file: inside its registered root, no symlink component, a regular file of at
 * most `maxBytes`; null when it is gone. Wave B: a streamed import (sync-streamed.ts) passes the page ceiling.
 */
export function syncFilePath(root: string, path: string, maxBytes = SYNC_READ_BOUND): string | null {
  if (realpathSync(root) !== resolve(root)) throw syncTargetRefusal('source_changed', 'The registered source root was replaced by a symlink.',
    `The registered root holding ${path} is now a symlink.`);
  const absolute = resolve(root, path);
  if (!isWriteTargetContained(absolute, root)) throw unreadableSyncFile(syncTargetRefusal('source_changed', 'Sync file escaped its registered root.',
    `${path} resolves outside its registered source root.`));
  try {
    // Reject symlink components, including ones targeting another path inside the root.
    let current = root;
    let stat: Stats | undefined;
    for (const part of relative(root, absolute).split(sep)) {
      current = join(current, part);
      stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw unreadableSyncFile(syncTargetRefusal('source_changed', 'Sync cannot publish through a symlink.',
        `A component of ${path} is a symlink; sync reads and publishes only real files inside the root.`));
    }
    if (!stat?.isFile()) throw unreadableSyncFile(syncTargetRefusal('source_changed', 'Sync target is not a regular file.',
      `${path} is not a regular file.`));
    if (stat.size > maxBytes) throw opError('request_too_large', 'Sync file exceeds the bounded import size.',
      `${path} is larger than the ${SYNC_READ_BOUND}-byte (24 MiB) page ceiling, so nothing was imported from it. Pages up to that size are chunked and searchable; above it, add the file to the sync.exclude config (or keep it outside the brain repo), then sync its source again. See docs/guides/memory-boundaries.md#large-pages.`);
    return absolute;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** GBRA-130 A-7: the per-file refusals of a path that is not a readable regular file inside its root (the freeze holds that file `file_unreadable`). */
export const UNREADABLE_SYNC_FILE = 'unreadable_sync_file';
const unreadableSyncFile = (error: OperationError): OperationError => Object.assign(error, { detail: UNREADABLE_SYNC_FILE });
export function readSyncFile(root: string, path: string): Buffer | null {
  const absolute = syncFilePath(root, path);
  try { return absolute === null ? null : readFileSync(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** Whether a file backs `path` in the working tree; a file that exists but cannot be read as a sync target (a symlink, oversized) still counts as present. */
function workingTreeFilePresent(root: string, path: string): boolean {
  try { return readSyncFile(root, path) !== null; } catch { return true; }
}
export const syncRawHash = (root: string, path: string): string | null => { const bytes = readSyncFile(root, path); return bytes === null ? null : sha256(bytes); };
export function assertConfiguredSyncRoot(root: string, configuredRoot: string | null): void {
  if (configuredRoot === null) return;
  try { if (realpathSync.native(resolve(configuredRoot)) === realpathSync.native(root) && realpathSync(root) === root) return; } catch {}
  throw syncTargetRefusal('source_changed', 'The configured source directory no longer matches the accepted sync owner.',
    'The configured directory of this source no longer resolves to the owner\'s registered root (it moved, was re-pointed, or became a symlink).');
}
export function syncGitPath(context: Pick<SyncDiscovery, 'root' | 'gitRoot'>, path: string): string {
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
    // GBRA-133 S-22: a directory where the deleted file was (notes/a.md became notes/a.md/x.md) means the file origin is gone.
    if (index === parts.length - 1 && matches.every(item => item.kind === 'tree')) return;
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
type ManagedSourceRow = { incarnation: string; archived: boolean; local_path: string | null; last_commit: string | null; config: Record<string, unknown> };
/** The source row and worktree binding `resolveManagedSyncContext` validates, read together. */
export function readManagedSyncRows(engine: BrainEngine, sourceId: string): Promise<[ManagedSourceRow | undefined, WorktreeBinding | null]> {
  return Promise.all([engine.executeRaw<ManagedSourceRow>('SELECT incarnation,archived,local_path,last_commit,config FROM sources WHERE id=$1', [sourceId]).then(rows => rows[0]),
    getWorktreeBinding(engine, sourceId)]);
}
/**
 * Validate the current owner and source without enumerating a new manifest. `rows`: `readManagedSyncRows` started by a
 * caller that has asserted the managed mode itself (and handles the promise's rejection).
 */
export async function resolveManagedSyncContext(engine: BrainEngine, opts: SyncOpts, rows?: ReturnType<typeof readManagedSyncRows>): Promise<ManagedSyncContext> {
  if (!rows) await assertManagedSyncActive(engine);
  const sourceId = opts.sourceId ?? 'default';
  if (!opts.noPull && !opts.dryRun) throw managedSyncRefusal(sourceId, 'Managed sync requires skipping the Git pull (CLI `--no-pull`, sync_brain `no_pull: true`); Git pull/rebase needs an explicit drained maintenance window.',
    `Sync without pulling to import the checkout as it is (CLI: gbrain sync --no-pull --source ${sourceId}; MCP: sync_brain with no_pull: true), or fast-forward and sync the checkout with gbrain sources refresh ${sourceId}.`);
  const forbidden = managedForbiddenFlag(opts);
  if (forbidden) throw managedSyncFlagRefusal(forbidden, sourceId, ['--source', sourceId, '--no-pull']);
  const [read, binding] = await (rows ?? readManagedSyncRows(engine, sourceId));
  if (opts.canonicalOverride === 'git' && (currentSubmissionAuthority()?.kind === 'remote_generic' || currentVerifiedLocalWriter()?.remote)) {
    throw trustedCliRequired('The strict-equivalent pass of a git-canonical conversion runs only from the trusted local CLI.');
  }
  const source = read && opts.canonicalOverride === 'git' ? { ...read, config: { ...read.config, canonical: 'git' } } : read;
  if (source?.config?.canonical === 'git' && managedForbiddenFlag(opts, true)) throw managedSyncFlagRefusal('--working-tree', sourceId, ['--source', sourceId, '--no-pull', '--working-tree']);
  if (!source || source.archived || !binding || binding.source_incarnation !== source.incarnation ||
      binding.owner_host_id !== localHostId() || binding.state !== 'active' || !binding.local_path) {
    // #6449: a rooted source with no owner at all is the database-only one activation listed; the exit is a deliberate claim.
    const unbound = source && !source.archived && !binding && source.local_path && source.config?.kind == null;
    // #7239: a missing, archived or re-registered source, or a checkout another host id owns, refuses the same way on every
    // retry from this host, so a sync job ends at once; a transfer or clone in progress can finish, so it stays retryable.
    const reason = source && !source.archived ? ownerUnavailableReason(binding, source.incarnation, localHostId()) : null;
    const deterministic = !source || source.archived || (reason !== null && reason !== 'transfer_in_progress' && reason !== 'clone_in_progress');
    throw opError('owner_unavailable', 'Sync must run on the active registered worktree owner.',
      unbound
        ? `Source ${sourceId} has a checkout path (${source.local_path}) but no canonical owner, so it is database-only and there is no checkout to sync; nothing changed. `
          + `To make this host its owner (a brain-wide change: ask the user first), preview with gbrain sources writer claim ${sourceId} --path ${source.local_path} --dry-run --json, then ${unboundBindCommand(sourceId, source.local_path)}; afterwards run gbrain sync --no-pull --source ${sourceId}.`
        : `Source ${sourceId} is archived, re-registered, or not bound to an active worktree owned by this host. Run its sync on the owner host that gbrain sources writer status --source ${sourceId} --json names; do not claim or transfer the source to make this host the owner.`,
      { ...(reason ? { reason } : {}), ...(deterministic ? { retryable: false } : {}),
        fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
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
/** #6865: which Git paths of one managed source sync admits, and the page origin each maps to under the source's slug mode. */
export interface SyncEligibility { scope: string; slugMode: 'git-root' | 'source-root'; nativeRoot: string; nativeGitRoot: string;
  eligible: (gitPath: string) => boolean; sourcePath: (gitPath: string) => string;
  /** GBRA-150: the blob heads `eligible` judges a metafile-named path by; a caller streaming a tree primes them in batches. */
  metafileHeads: GitMetafileHeads; }
/**
 * #6865: the eligibility rules managed discovery applies to a Git path (the source's scope, `sync.exclude`, `sync.include_hidden`,
 * the strategy and reserved skillpack paths) and the origin a path maps to under the slug mode. Discovery and the unindexed-file
 * detector share this one definition, so a file the detector reports is a file a sync would screen.
 */
export async function loadSyncEligibility(engine: BrainEngine, context: Pick<ManagedSyncContext, 'root' | 'gitRoot' | 'sourceId' | 'source'>,
  opts: Pick<SyncOpts, 'strategy' | 'exclude' | 'includeHidden' | 'srcSubpath'> = {}, company = !!currentCompanyBrainSync(context.sourceId),
  /** GBRA-150: the bytes a metafile-named path is judged by: the commits it is read at (default the source's last synced commit), the checkout first in working mode. */
  metafileRead: { commits?: Array<string | null | undefined>; working?: boolean } = {}): Promise<SyncEligibility> {
  const strategy = opts.strategy ?? context.source.config?.strategy ?? 'markdown';
  const nativeRoot = realpathSync.native(context.root), nativeGitRoot = realpathSync.native(context.gitRoot);
  const scope = relative(nativeGitRoot, nativeRoot).split(sep).join('/');
  const probe = resolveSlugForPath(join(scope, 'x.md'));
  const slugMode = company ? 'source-root' : scope ? await resolveSlugRootMode(engine, { sourceId: context.sourceId, explicitGitRoot: opts.srcSubpath !== undefined,
    slugPrefix: probe.slice(0, -2), dryRun: true }) : 'git-root';
  const sourcePath = (path: string) => slugMode === 'source-root' && scope ? path.slice(scope.length + 1) : path;
  const exclude = await syncExcludePatterns(engine, opts.exclude);
  const includeHidden = [...new Set([...(opts.includeHidden ?? []), ...(await engine.getConfig('sync.include_hidden') ?? '')
    .split(/[\n,]/).map(v => v.trim()).filter(Boolean)].map(v => v.endsWith('/') ? `${v}**` : v))];
  // GBRA-150: a typed nested metafile is a page, judged at its depth below the source root by the bytes the import reads.
  const metafileHeads = gitMetafileHeads(context.gitRoot, metafileRead.commits ?? [context.source.last_commit]);
  const metafilePage = metafilePagePredicate(await readMetafilePagesMode(engine),
    metafileRead.working ? firstMetafileHead(diskMetafileHeads(nativeGitRoot), metafileHeads.read) : metafileHeads.read,
    path => scope && path.startsWith(`${scope}/`) ? path.slice(scope.length + 1) : path);
  // Reserved skillpack paths belong to the shared skill publisher; the managed importer always refuses them.
  const eligible = (path: string) => (!scope || path.startsWith(`${scope}/`)) &&
    !matchesAnyGlob(scope ? path.slice(scope.length + 1) : path, exclude) && !isReservedSkillBundlePath(sourcePath(path)) &&
    isSyncable(path, { strategy: strategy as 'markdown', includeHidden, metafilePage });
  return { scope, slugMode, nativeRoot, nativeGitRoot, eligible, sourcePath, metafileHeads };
}
/** The cursor bound: entries and serialized bytes one frozen manifest may hold. */
let cursorBound = { entries: 100_000, bytes: 16 * 1024 ** 2 };
/** Test seam: a smaller cursor bound (call with no argument to restore the default). */
export function _setCursorBoundForTest(bound?: { entries: number; bytes: number }): void { cursorBound = bound ?? { entries: 100_000, bytes: 16 * 1024 ** 2 }; }
const manifestFits = (entries: readonly unknown[]) => entries.length <= cursorBound.entries && Buffer.byteLength(JSON.stringify(entries)) <= cursorBound.bytes;

/**
 * #6349: the furthest first-parent commit after `from` whose delta from `from` fits the cursor bound, found by a forward
 * gallop that verifies every candidate it accepts (a net delta from a fixed base is not monotone along history: an add
 * reverted later shrinks it again, so a binary search has no valid predicate). Null when even the first commit does not fit.
 */
export function stagedSyncTarget(gitRoot: string, from: string, target: string, fits: (commit: string) => boolean): { commit: string; first: string } | { oversized: string } {
  const commits = syncGit(gitRoot, ['rev-list', '--first-parent', '--reverse', `${from}..${target}`]).split('\n').map(line => line.trim()).filter(Boolean);
  let good = -1, step = 1;
  while (good < commits.length - 1) {
    const at = Math.min(good + step, commits.length - 1);
    if (fits(commits[at]!)) { good = at; step *= 2; continue; }
    if (step === 1 || at === good + 1) break;
    step = Math.max(1, Math.floor((at - good) / 2));
  }
  return good < 0 ? { oversized: commits[0] ?? target } : { commit: commits[good]!, first: commits[0]! };
}

/**
 * #5459 (P4.5): "not in the Git tree" is not "deleted" for a page imported from the working tree. The durable import
 * provenance (not the request intent, which compaction nulls) says where the bytes came from; a working-tree import
 * whose file is still present is kept, and unknown provenance with the file present is held rather than deleted. A
 * page whose provenance is the pinned Git blob follows Git even when a copy of the file lingers untracked.
 */
async function keptWorkingTreePages(engine: BrainEngine, scope: { sourceId: string; incarnation: string; root: string; nativeRoot: string; nativeGitRoot: string },
  absent: ReadonlyArray<{ id: number; gitPath: string }>): Promise<Set<string>> {
  const provenance = await readSyncImportProvenances(engine, scope.sourceId, scope.incarnation, absent.map(page => page.id));
  const kept = new Set<string>();
  for (const page of absent) {
    const record = provenance.get(Number(page.id));
    const fromGit = record?.working === false || (record?.working === undefined && !!record?.blob_oid);
    if (!fromGit && workingTreeFilePresent(scope.root, relative(scope.nativeRoot, join(scope.nativeGitRoot, page.gitPath)).split(sep).join('/'))) kept.add(page.gitPath);
  }
  return kept;
}
/** #6349 (P4.4): cuts the resolved manifest to its next path slice and marks the discovery as one slice of a pinned target. */
function cutDiscoveryToSlice(discovered: SyncDiscovery, slicing: Pick<SyncSliceCursor, 'phase' | 'after'>, head: string): void {
  const cut = sliceEntries(discovered.entries, slicing, manifestFits);
  if (!manifestFits(cut.entries)) throw opError('request_too_large', 'One sync entry exceeds the bounded cursor size.',
    `Entry ${cut.entries[0]?.path} of ${discovered.sourceId} alone exceeds the ${Math.round(cursorBound.bytes / 1024 ** 2)} MiB cursor bound; nothing was written. Exclude it with --exclude or the sync.exclude config, then run gbrain sync --no-pull --source ${discovered.sourceId}.`);
  discovered.entries = cut.entries;
  discovered.slice = { phase: cut.phase, after: cut.after, head, target: discovered.target, done: cut.done };
  if (cut.done && discovered.target === head) delete discovered.stagedHead; else discovered.stagedHead = head;
}
/**
 * #7130: the deletions no Git change names (`unproven`: Git path to the path its evidence is read at) that Git never
 * committed are dropped from `entries` and returned: their absence is no evidence the page was deleted.
 */
async function dropUncommittedDeletes(gitRoot: string, tips: Array<string | null | undefined>, unproven: ReadonlyMap<string, string>,
  entries: Map<string, { action: string }>): Promise<string[] | undefined> {
  const deletes = [...unproven.keys()].filter(path => entries.get(path)?.action === 'delete');
  if (!deletes.length) return undefined;
  const evidence = await readOriginEvidence(gitRoot, tips, deletes.map(path => unproven.get(path)!));
  const kept = deletes.filter(path => evidence.get(unproven.get(path)!) !== 'committed');
  for (const path of kept) entries.delete(path);
  return kept;
}

/**
 * #7324: a delete under a declared storage.db_only dir is retired (its database row is canonical). #8007: while gbrain.yml's
 * storage section is invalid, whether a path is database-only is unknown, so its delete is retired too and named.
 */
function retireDbOnlyDeletes(root: string, entries: readonly SyncEntry[], retired: Set<SyncEntry>): { storageInvalidKept?: string[] } {
  const storageInvalidKept: string[] = [];
  for (const entry of entries) {
    const dbOnly = entry.action === 'delete' && entry.slug ? sourceDbOnlyVerdict(root, entry.slug) : false;
    if (dbOnly) retired.add(entry);
    if (dbOnly === 'unknown') storageInvalidKept.push(entry.path);
  }
  return storageInvalidKept.length ? { storageInvalidKept } : {};
}

export async function discoverManagedSync(engine: BrainEngine, opts: SyncOpts, context?: ManagedSyncContext,
  stage?: { target: string; head: string; slice?: Pick<SyncSliceCursor, 'phase' | 'after'> }, walk = false): Promise<SyncDiscovery> {
  const { binding, root, gitRoot, sourceId, incarnation, source } = context ?? await resolveManagedSyncContext(engine, opts);
  const company = currentCompanyBrainSync(sourceId);
  const target = stage?.target ?? company?.plan.revision?.commit ?? syncGit(gitRoot, ['rev-parse', 'HEAD']).trim();
  const head = stage?.head ?? target;
  const slicing = stage?.slice ?? null;
  const detached = !company && syncGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD';
  // #6349: a staged run stops at a commit, so uncommitted working-tree changes wait for the stage that reaches HEAD.
  const working = !company && !stage && (detached || (opts.workingTree ?? (await engine.getConfig('sync.include_working_tree') === 'true')));
  // GBRA-150: a metafile is judged by the bytes this run imports (the target's blob, the checkout in working mode) or,
  // deleted, by the blob it was last synced from.
  const { scope, slugMode, nativeRoot, nativeGitRoot, eligible, sourcePath, metafileHeads } = await loadSyncEligibility(engine, { root, gitRoot, sourceId, source }, opts, !!company,
    { commits: [target, source.last_commit], working });
  const originScope: SyncOriginScope = { sourceId, root, scope, slugMode };
  // #6729: inexact renames keep their page identity only when confirmed (an imported dirty tree reads its target side from the working tree).
  const confirm = { sourceId, sourcePathOf: sourcePath }, built: SyncManifest = company ? { added: [], modified: [], deleted: [], renamed: [] } : buildDetachedWorkingTreeManifest(gitRoot);
  const dirty = working ? await confirmRenameIdentities(engine, gitRoot, 'HEAD', null, built, confirm) : built;
  const delta = !opts.full && !walk && source.last_commit ? await confirmedSyncDelta(engine, gitRoot, source.last_commit, target, confirm) : null;
  const entries = new Map<string, SyncEntry>();
  const renamedFrom = new Map<string, { from: string; identityHead?: string }>();
  let workingTreeKept: string[] | undefined;
  let treeAbsent: Array<{ id: number; gitPath: string; evidencePath?: string }> = [];
  // #7130: deletions no Git change names (a tree walk's absent pages, a re-screened held deletion) need a commit that held the file.
  const unproven = new Map<string, string>();
  const discoveredAt = new Date().toISOString();
  // #5988: active holds are re-screened when their file changed, left, or a newer reader may import it.
  const holds = company ? [] : (await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds.filter(hold => hold.incarnation === incarnation) ?? [];
  const retry = new Set(company ? [] : await readGitHoldRetryPaths(engine, sourceId, incarnation));
  const toGitPath = (path: string) => scope ? `${scope}/${path}` : path;
  const holdByPath = new Map(holds.map(hold => [hold.path, hold]));
  const holdRenameOrigins = new Set(holds.flatMap(hold => hold.meta.rename_from ? [syncOriginPath(hold.meta.rename_from.sourcePath)] : []));
  // #5032: a ':' path has no file on Windows. Each eligible one gets a named
  // refusal and takes no part in this run, including the origin checks below.
  // A deletion or rename touching one is refused on both sides, so the page
  // keeps its identity until the change is synced from macOS or Linux.
  const refused = new Map<string, SyncFileRefusal>();
  const record = (path: string, message: string) => {
    if (eligible(path)) refused.set(path, colonFileRefusal(sourceId, path, message));
  };
  const refuse = (path: string, action: SyncEntry['action'] = 'import') => {
    if (!isWindowsColonTarget(path)) return false;
    record(path, COLON_REFUSAL_MESSAGES[action](path));
    return true;
  };
  const storable = <T extends { source_path: string | null }>(page: T) => page.source_path === null || !isWindowsColonTarget(page.source_path);
  const put = (path: string, action: SyncEntry['action'], working = false) => {
    if (process.platform === 'win32' && path.includes('\\')) throw opError('page_identity_changed', 'Git paths containing literal backslashes are not safe Windows sync targets.',
      `${path} in ${sourceId} has a literal backslash in its name, which Windows cannot store; nothing was synced. Rename it on a macOS or Linux checkout and commit, then run gbrain sync --no-pull --source ${sourceId}.`);
    if (refuse(path, action)) return;
    if (eligible(path)) entries.set(path, { path: relative(nativeRoot, join(nativeGitRoot, path)).split(sep).join('/'), sourcePath: sourcePath(path), action, working });
  };
  const putRename = (rename: SyncManifest['renamed'][number], working = false) => {
    if (isWindowsColonTarget(rename.from) || isWindowsColonTarget(rename.to)) {
      for (const path of [rename.from, rename.to]) {
        record(path, COLON_REFUSAL_MESSAGES.rename(path, rename.from, rename.to));
      }
      return;
    }
    put(rename.from, 'delete', working); put(rename.to, 'import', working); renamedFrom.set(rename.to, { from: rename.from, ...(working && rename.identityHead ? { identityHead: rename.identityHead } : {}) });
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
    if (paths.some(isSyncMetafile)) metafileHeads.prime(listMetafileNamedBlobs(gitRoot, target, scope));
    for (const path of paths) put(path, 'import');
    const livePages = await engine.executeRaw<{ id: number; slug: string; source_path: string }>('SELECT slug,source_path,id FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL', [sourceId]);
    const gitPathOf = (origin: string) => slugMode === 'source-root' && scope ? `${scope}/${origin}` : origin;
    const listedSet = new Set(listed);
    for (const page of livePages) if (!storable(page) && !listedSet.has(gitPathOf(page.source_path))) refuse(gitPathOf(page.source_path), 'delete');
    const pages = livePages.filter(storable);
    assertDistinctSyncOrigins([...present, ...pages.map(page => page.source_path)]);
    const absent = pages.filter(page => {
      const origin = syncOriginPath(page.source_path);
      const stripped = slugMode === 'source-root' && scope && origin.startsWith(`${scope}/`) ? origin.slice(scope.length + 1) : null;
      if (present.has(origin) || stripped !== null && present.has(stripped) && sameSyncOrigin(origin, stripped, originScope, page.slug)) return false;
      // #5988: the old page of a held rename keeps its origin until the renamed file imports.
      return !holdRenameOrigins.has(origin);
    });
    treeAbsent = absent.map(page => {
      const origin = syncOriginPath(page.source_path);
      // #7130: a legacy origin recorded Git-root-relative under a source-root scope is already the file's Git path.
      const legacy = slugMode === 'source-root' && scope && origin.startsWith(`${scope}/`) && sameSyncOrigin(origin, origin.slice(scope.length + 1), originScope, page.slug);
      return { id: page.id, gitPath: gitPathOf(origin), ...(legacy ? { evidencePath: origin } : {}) };
    });
  }
  if (working) {
    for (const path of [...dirty.added, ...dirty.modified]) put(path, 'import', true);
    for (const path of dirty.deleted) put(path, 'delete', true);
    for (const rename of dirty.renamed) putRename(rename, true);
  }
  if (treeAbsent.length) {
    // A path the selected working tree already decided (an import or a deletion above) is not re-judged.
    const kept = await keptWorkingTreePages(engine, { sourceId, incarnation, root, nativeRoot, nativeGitRoot }, treeAbsent.filter(page => !entries.has(page.gitPath)));
    for (const page of treeAbsent) if (!entries.has(page.gitPath) && !kept.has(page.gitPath)) { put(page.gitPath, 'delete'); unproven.set(page.gitPath, page.evidencePath ?? page.gitPath); }
    if (kept.size) workingTreeKept = [...kept];
  }
  // #6278 (B7): every scheduled path is consumed by this discovery: it is screened as an entry (the file changed in Git),
  // re-screened as a candidate below, or can never be screened (no longer eligible), so none may outlive the run.
  const released: string[] = [], retryTaken = [...retry];
  if (holds.length || retry.size) {
    const candidates = [...new Set([...holds.map(hold => hold.path), ...retry])].filter(path => !entries.has(toGitPath(path)));
    for (const path of candidates.filter(path => holdByPath.has(path) && !eligible(toGitPath(path)))) released.push(path);
    const checked = candidates.filter(path => eligible(toGitPath(path)));
    const blobs = readTreeBlobs(gitRoot, target, checked.map(toGitPath));
    const unversioned = checked.flatMap(path => {
      const hold = holdByPath.get(path), blob = blobs.get(toGitPath(path));
      return hold && !hold.meta.blob_oid && !hold.meta.working && blob ? [blob] : [];
    });
    const contents = readBlobContents(gitRoot, unversioned), movedDrift = await movedDriftHolds(engine, sourceId, holds);
    const moved = await holdBasisMoved(engine, sourceId, holdByPath, checked);
    for (const path of checked) {
      const hold = holdByPath.get(path), gitPath = toGitPath(path), blob = blobs.get(gitPath);
      const workingHold = working && (hold?.meta.working === true || !blob);
      let changed = !hold || holdRescreenDue(hold, retry.has(path)) || moved.has(path) || movedDrift.has(path);
      let present = !!blob;
      if (workingHold) {
        let bytes: Buffer | null = null;
        try { bytes = readSyncFile(root, path); } catch { changed = true; }
        present = bytes !== null || changed;
        if (!changed) changed = bytes === null || sha256(bytes.toString('utf8')) !== hold!.upstream_version;
      } else if (!changed) {
        // #6278: a held deletion has no bytes to compare; the file reappearing is the change.
        changed = hold!.meta.deleted ? !!blob : !blob || (hold!.meta.blob_oid ? blob.oid !== hold!.meta.blob_oid : sha256(contents.get(blob.oid) ?? '') !== hold!.upstream_version);
      }
      if (!changed) continue;
      put(gitPath, present ? 'import' : 'delete', workingHold);
      if (!present) unproven.set(gitPath, gitPath);
    }
  }
  const uncommittedKept = company ? undefined : await dropUncommittedDeletes(gitRoot, [target, source.last_commit], unproven, entries);
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
  // #5493: an image import is held at freeze (managed_image_sync_unsupported); an image deletion needs no importer.
  const unsupported = selected.find(e => e.action === 'import' && !/\.mdx?$/i.test(e.path) && !isCodeFilePath(e.path) && (company || !isImageFilePath(e.path)));
  if (unsupported) throw opError('writer_coordinator_required', 'Managed image sync requires a prepared importer; this sync was refused before any page write.',
    `Managed sync of ${sourceId} imports only Markdown and code files, and this run selected others (for example ${unsupported.path}). Exclude them with --exclude or the sync.exclude config, then run gbrain sync --no-pull --source ${sourceId}.`);
  if (!manifestFits(selected) && !slicing) {
    // #6349: an incremental delta past the bound is synced in stages: the furthest first-parent commit whose delta fits,
    // then the next stage from there (the CLI loops; a scheduled sync takes one stage per run).
    if (delta?.status === 'ok' && !company && source.last_commit) {
      const last = source.last_commit;
      const deltaEntries = (commit: string) => {
        const step = computeSyncDelta(gitRoot, last, commit);
        if (step.status !== 'ok') return null;
        const paths = [...step.manifest.added, ...step.manifest.modified, ...step.manifest.deleted, ...step.manifest.renamed.flatMap(r => [r.from, r.to])].filter(eligible);
        return paths.map(path => ({ path: relative(nativeRoot, join(nativeGitRoot, path)).split(sep).join('/'), sourcePath: sourcePath(path), action: 'import', working: false }));
      };
      const staged = stagedSyncTarget(gitRoot, last, head, commit => { const entries = deltaEntries(commit); return !!entries && manifestFits(entries); });
      if ('commit' in staged && staged.commit !== target) return discoverManagedSync(engine, opts, context, { target: staged.commit, head });
      // #6349 (P4.4): one commit alone above the bound is a fixed set, so it is pinned and cut into path slices.
      if ('oversized' in staged) return discoverManagedSync(engine, opts, context, { target: staged.oversized, head, slice: { phase: 'import', after: null } });
    }
    if (company) throw opError('request_too_large', 'Sync discovery exceeds the bounded cursor size.',
      `This sync of ${sourceId} selected ${selected.length} entries, above the 100,000-entry and 16 MiB cursor bound; nothing was written. Narrow it with --exclude or the sync.exclude config, then run gbrain sync --no-pull --source ${sourceId}.`);
    // #6349 (P4.4): a first sync or a `--full` tree walk has no commit axis to stage on; the target is cut into path slices
    // (re-entered as a stage so the slices read the pinned tree alone, never the working tree).
    return discoverManagedSync(engine, opts, context ?? { binding, root, gitRoot, sourceId, incarnation, source }, { target, head, slice: { phase: 'import', after: null } }, walk);
  }
  const discovered: SyncDiscovery = { discoveredAt, ...(released.length ? { releasedHolds: released } : {}), ...(retryTaken.length ? { retryTaken } : {}),
    ...(refused.size ? { fileRefusals: [...refused.values()] } : {}), binding: { ...binding, owner_epoch: String(binding.owner_epoch), topology_generation: String(binding.topology_generation) }, root, gitRoot, sourceId, incarnation, from: source.last_commit, target, entries: selected, slugMode, ...(company ? { companyPlan: company.plan } : {}), ...(stage ? { stagedHead: stage.head } : {}),
    ...(workingTreeKept ? { workingTreeKept } : {}), ...(uncommittedKept?.length ? { uncommittedKept } : {}), ...(company ? {} : identityDowngradesOf([delta?.status === 'ok' ? delta.manifest : null, working ? dirty : null], eligible, sourcePath)) };
  // Freeze all logical identities in one database statement, before yielding
  // between pages. A later interactive edit must conflict with this scan.
  const identities = await engine.executeRaw<{ id: number; slug: string; source_path: string | null; knowledge_revision: string; deleted_at: Date | string | null; fm_id: string | null }>(
    "SELECT q.*,f.frontmatter->>'id' AS fm_id FROM (SELECT id,slug,source_path,knowledge_revision,deleted_at FROM pages WHERE source_id=$1) q JOIN pages f ON f.id=q.id", [sourceId]);
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
    const claimants = [...byPath.get(syncOriginPath(entry.sourcePath)) ?? [],
      ...(legacy ? byPath.get(legacy) ?? [] : []).filter(page => sameSyncOrigin(page.source_path!, entry.sourcePath, originScope, page.slug))];
    // #6517: one origin rule (sync-origin.ts): a live page wins over tombstones; several live pages, or several tombstones, refuse.
    const { winner: origin, ambiguous } = selectOriginClaimant(claimants);
    if (ambiguous === 'several_live') {
      // #6948: twin claimants hold this file (`origin_conflict`) instead of refusing the source; the freeze holds it, the heal resolves the safe case.
      entry.originConflict = await originConflictOf(engine, discovered, entry, claimants.filter(page => page.deleted_at == null));
      Object.assign(entry, { slug: entry.originConflict.canonical, pageId: null, revision: null });
      continue;
    }
    if (ambiguous) throw ambiguousOriginRefusal(sourceId, entry.sourcePath, claimants, ambiguous);
    let slug = entry.slug ?? origin?.slug ?? resolveSlugForPath(entry.sourcePath);
    if (!slug && entry.action === 'import') slug = parseMarkdown(readSyncContent(discovered, entry), '').slug;
    if (!slug) throw opError('invalid_params', 'The imported file has no usable page slug.',
      `${entry.sourcePath} in ${sourceId} yields no page slug from its path or frontmatter; nothing was written. Rename the file or set a frontmatter slug and commit, then run gbrain sync --no-pull --source ${sourceId}.`);
    if (!company && entry.action === 'import' && !origin && !isCodeFilePath(entry.sourcePath)) {
      slug = await adoptLegacyPage(engine, discovered, identities, bySlug.get(slug), slug, entry);
      entry.slug = slug;
      claims.set(slug, [...(claims.get(slug) ?? []), entry]);
      continue;
    }
    const page = origin ?? bySlug.get(slug);
    const foreignOrigin = page?.source_path != null && !sameSyncOrigin(page.source_path, entry.sourcePath, originScope, page.slug);
    // Deleting a file that no page records (a skipped slug twin) must not delete the page another file backs.
    const unownedDeletion = foreignOrigin && entry.action === 'delete' && !origin && !company;
    if (foreignOrigin && !unownedDeletion) {
      const error = new OperationError('page_identity_changed', 'A different origin occupies the imported slug.',
        `Page ${slug} in source ${sourceId} records the origin '${page.source_path}', but sync found it at '${entry.sourcePath}'. On the brain host, rename or move one of the two files so each page has one origin, commit, then run gbrain sync --source ${sourceId} --no-pull.`);
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
      assertTakeoverIdentity(discovered, winner, holder);
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
    const { from, identityHead } = renamedFrom.get(gitPath(winner)) ?? {};
    const deletion = from === undefined ? undefined : [...deletions.values()].find(entry => gitPath(entry) === from);
    const moved = deletion?.pageId == null ? undefined : identities.find(page => page.id === deletion.pageId);
    if (deletion && moved && !deleted.has(moved.id) && moved.source_path != null) {
      // A Git rename moves the page to its new slug, like the library path's updateSlug: same page id, inbound links and an alias.
      Object.assign(winner, { renameFrom: { sourcePath: moved.source_path, slug: moved.slug, pageId: moved.id, revision: moved.knowledge_revision }, ...(identityHead ? { identityHead } : {}) });
      retired.add(deletion);
      continue;
    }
    // #5988: a held rename destination (or a held one renamed again) still owes its page the move; the deletion of a held path stays to clear its hold.
    const held = holdByPath.get(winner.path)?.meta.rename_from ?? (deletion ? holdByPath.get(deletion.path)?.meta.rename_from : undefined);
    const origin = held ? identities.find(page => page.id === held.pageId) : undefined;
    if (held && origin && !deleted.has(origin.id) && origin.source_path != null && sameSyncOrigin(origin.source_path, held.sourcePath, originScope, origin.slug) && !explicitIdVeto(incomingId(discovered, winner), origin.fm_id)) {
      if (origin.knowledge_revision === held.revision) winner.renameFrom = held;
      else winner.renameHeld = held;
    }
  }
  if (!company) Object.assign(discovered, retireDbOnlyDeletes(root, selected, retired));
  if (retired.size) discovered.entries = selected.filter(entry => !retired.has(entry));
  if (collisions.length) discovered.slugCollisions = collisions;
  // Identities and origin collisions were resolved over the whole target above; only the frozen manifest is cut.
  if (slicing) cutDiscoveryToSlice(discovered, slicing, head);
  await prescreenSyncEntries(engine, discovered, { full: !!opts.full, treeWalk: delta?.status !== 'ok', noSchemaPack: !!opts.noSchemaPack, dryRun: !!opts.dryRun, held: holdByPath });
  if (!working) {
    const uncommitted = { added: new Set([...dirty.added,...dirty.renamed.map(r=>r.to)].filter(eligible)).size,
      modified: new Set(dirty.modified.filter(eligible)).size,
      deleted: new Set([...dirty.deleted,...dirty.renamed.map(r=>r.from)].filter(eligible)).size };
    if (uncommitted.added || uncommitted.modified || uncommitted.deleted) discovered.uncommitted = uncommitted;
  }
  return discovered;
}
export type LegacyIdentity = { id: number; slug: string; source_path: string | null; deleted_at: Date | string | null; fm_id: string | null };
/**
 * #6727: per discovery, its live pages with no recorded origin whose slug the current fold changes, by folded slug. Built on
 * first need; database-only pages (never imported from a file) are left out by one read over just those candidates, so a
 * source without legacy pages issues no extra statement.
 */
const legacyByFold = new WeakMap<LegacyIdentity[], Promise<Map<string, string[]>>>();
async function foldLegacyPages(engine: BrainEngine, identities: LegacyIdentity[]): Promise<Map<string, string[]>> {
  const candidates = identities.filter(page => page.deleted_at == null && page.source_path == null && slugifyPath(page.slug) !== page.slug);
  const databaseOnly = new Set(candidates.length ? (await engine.executeRaw<{ id: number }>(
    `SELECT p.id FROM pages p WHERE p.id=ANY($1::bigint[]) AND (${databaseOnlyPageSql('p')} OR p.database_only_reason IS NOT DISTINCT FROM 'origin_twin')`, [candidates.map(page => Number(page.id))])).map(row => Number(row.id)) : []);
  return candidates.filter(page => !databaseOnly.has(Number(page.id)))
    .reduce((map, page) => map.set(slugifyPath(page.slug), [...map.get(slugifyPath(page.slug)) ?? [], page.slug]), new Map<string, string[]>());
}
/**
 * #6727: the slug a file with no recorded origin imports as. With no live page at its folded slug, exactly one legacy page
 * (an older gbrain imported it before the current fold) folding to it is the file's: it imports into that page (same id,
 * links and history). Several, or one whose slug the importer cannot write as it stands (`validateSlug` lowercases), keep
 * the folded slug and are named on the entry, so the freeze holds the file `legacy_slug_conflict`. #6729: so does the one
 * page when its explicit frontmatter id differs from the file's (`explicitIdVeto`): it is another document.
 */
export async function adoptLegacyPage(engine: BrainEngine, discovery: SyncDiscovery, identities: LegacyIdentity[], holder: LegacyIdentity | undefined, slug: string, entry: SyncEntry): Promise<string> {
  if (holder && holder.deleted_at == null) return slug;
  let folded = legacyByFold.get(identities);
  if (!folded) legacyByFold.set(identities, folded = foldLegacyPages(engine, identities));
  const legacy = (await folded).get(slug) ?? [];
  const writable = () => { try { return validateSlug(legacy[0]!) === legacy[0]; } catch { return false; } };
  const legacyId = legacy.length === 1 ? identities.find(page => page.slug === legacy[0] && page.deleted_at == null)?.fm_id ?? null : null;
  const vetoed = legacyId !== null && explicitIdVeto(incomingId(discovery, entry), legacyId);
  if (legacy.length === 1 && writable() && !vetoed) return legacy[0]!;
  if (vetoed) entry.legacyIdVeto = true;
  if (legacy.length) entry.legacySlugs = [...legacy].sort();
  return slug;
}
/** #6729: the inexact Git renames this discovery split into a delete plus an add, in origin form, for the sync report and its durable record. */
function identityDowngradesOf(manifests: Array<SyncManifest | null>, eligible: (path: string) => boolean, sourcePath: (path: string) => string): Pick<SyncDiscovery, 'identityDowngrades'> {
  const pairs = manifests.flatMap(manifest => manifest?.downgradedRenames ?? []).filter(pair => eligible(pair.from) || eligible(pair.to))
    .map(pair => ({ ...pair, from: sourcePath(pair.from), to: sourcePath(pair.to) }));
  return pairs.length ? { identityDowngrades: pairs } : {};
}
/**
 * #6729: a file that takes over the page holding its slug (a vanished or deleted origin) inherits that page's identity,
 * so it must not when both carry an explicit frontmatter id and the ids differ: they are two different documents that
 * happen to map to one slug. The sync is refused before any write, naming both.
 */
export function assertTakeoverIdentity(discovery: SyncDiscovery, winner: SyncEntry, holder: { slug: string; fm_id: string | null }): void {
  const incoming = holder.fm_id ? incomingId(discovery, winner) : null;
  if (!explicitIdVeto(incoming, holder.fm_id)) return;
  throw opError('page_identity_changed', 'A file would take over a page whose frontmatter id differs from its own.',
    `${winner.sourcePath} in ${discovery.sourceId} maps to page ${holder.slug}, whose file is gone, but its frontmatter id '${incoming}' differs from the page's id '${holder.fm_id}', so it is a different document and must not inherit that page's facts, links and history; nothing was written. `
    + `Give the file the page's id if it is the same document, or rename it so its slug differs, commit, then run gbrain sync --no-pull --source ${discovery.sourceId}.`,
    { detail: 'rename_identity_conflict' });
}
/** #6948: the frontmatter id of the file an entry imports (null: none), or undefined when it cannot be read: unreadable is never agreement. */
function readableId(discovery: SyncDiscovery, entry: SyncEntry): string | null | undefined {
  try { return frontmatterIdentity(readSyncContent(discovery, entry)).id; } catch { return undefined; }
}
/** #6729: the frontmatter id of the file an entry imports (null when it has none or cannot be read). */
export function incomingId(discovery: SyncDiscovery, entry: SyncEntry): string | null {
  try { return frontmatterIdentity(readSyncContent(discovery, entry)).id; } catch { return null; }
}
/**
 * #6948: the conflict record of an entry several live pages claim: the claimants (with the verdict inputs, read only on
 * this path) and the shared verdict (origin-twins.ts), which the freeze turns into an
 * `origin_conflict` hold of this file alone.
 */
async function originConflictOf(engine: BrainEngine, discovery: SyncDiscovery, entry: SyncEntry, live: Array<{ id: number }>): Promise<OriginConflict> {
  const claimants = await readOriginClaimants(engine, discovery.sourceId, live.map(page => Number(page.id)));
  const verdict = decideOriginTwins({ sourcePath: entry.sourcePath, claimants, fileId: entry.action === 'import' ? readableId(discovery, entry) : undefined,
    slugPathOccupied: slugPathOccupied(discovery) });
  return { canonical: verdict.canonical, claimants: verdict.verdict === 'resolve' ? [verdict.survivor, ...verdict.twins] : verdict.claimants,
    ...(verdict.verdict === 'hold' ? { reason: verdict.reason } : {}) };
}
/** #6517: several tombstones record one imported origin (several live pages are an `origin_conflict` hold, #6948). */
export function ambiguousOriginRefusal(sourceId: string, sourcePath: string, named: Array<{ slug: string }>, ambiguous: 'several_live' | 'several_tombstones'): OperationError {
  return opError('page_identity_changed', 'Several pages claim the same imported origin.',
    `Pages ${named.map(page => page.slug).join(', ')} in ${sourceId} all record ${sourcePath} as their origin; nothing was written. `
    + (ambiguous === 'several_live' ? `${sharedOriginExit(sourceId, named.map(page => page.slug))} Then` : 'Keep one, remove or re-point the others, then') + ` run gbrain sync --no-pull --source ${sourceId}.`,
    { fix: { argv: ['gbrain', 'get', '--source', sourceId, '--', named[0]!.slug], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows one of the pages that claim the origin, to decide which one keeps it.' } });
}
export function readSyncContent(discovery: SyncDiscovery, entry: SyncEntry): string {
  if (entry.working) {
    const bytes = readSyncFile(discovery.root, entry.path);
    if (bytes === null) throw opError('source_changed', 'The discovered working-tree file disappeared.',
      `${entry.path} left the working tree of ${discovery.sourceId} between discovery and import, so nothing was imported from it. Run gbrain sync --no-pull --source ${discovery.sourceId} to rediscover the tree.`,
      { fix: managedSyncFix(discovery.sourceId, 'A new discovery reads the working tree as it is now.') });
    if (entry.identityHead && identityHeadDigest(bytes) !== entry.identityHead) throw opError('source_changed', 'A renamed working-tree file changed after its page identity was confirmed.',
      `${entry.path} changed in the working tree of ${discovery.sourceId} after sync confirmed it keeps the page of its rename, so nothing was imported from it and no identity moved. Run gbrain sync --no-pull --working-tree --source ${discovery.sourceId} to re-check it.`,
      { fix: { ...managedSyncFix(discovery.sourceId, 'A retry rediscovers the tree and re-checks the rename against the file as it is now.'),
        argv: ['gbrain', 'sync', '--no-pull', '--working-tree', '--source', discovery.sourceId] } });
    return bytes.toString('utf8');
  }
  return syncGit(discovery.gitRoot, ['show', `${discovery.target}:${syncGitPath(discovery, entry.path)}`]);
}
