import { existsSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { hasUnresolvedDbOnlyDeclaration, loadStorageConfig, validateStorageConfig, getStorageTier, isDbOnly } from '../core/storage-config.ts';
import type { StorageConfig, StorageTier } from '../core/storage-config.ts';
import { walkBrainRepo, type DiskFileEntry } from '../core/disk-walk.ts';
import { getDefaultSourcePath, isResolverUserError, resolveSourceForRepoPath } from '../core/source-resolver.ts';
import { resolveRestoreTarget, restoreFilePath, RestoreTargetError } from '../core/restore-target.ts';
import { shellQuote } from '../core/shell-quote.ts';
import { scannerSlugRootMode } from '../core/write-through.ts';
import type { SlugRootMode } from '../core/sync-anchor.ts';
import { nativeFileTarget } from '../core/persistence/native-file-target.ts';
import { OperationError } from '../core/ops/contract.ts';

/**
 * Distinct nominal types for the two tier-keyed numeric maps. Both shapes
 * are `Record<StorageTier, number>` structurally — but they carry
 * semantically different units (page COUNT vs disk BYTES). Distinct types
 * make accidental swaps a compile-time error rather than a silent display
 * bug. Issue #11 of the eng review.
 */
export type PageCountsByTier = Record<StorageTier, number> & { __brand?: 'page-counts' };
export type DiskUsageByTier = Record<StorageTier, number> & { __brand?: 'disk-bytes' };

/**
 * Pure-data result of a storage-status query. No side effects, no I/O
 * beyond the engine call and one filesystem walk. Consumed by both the
 * JSON formatter and the human formatter; kept narrow so it's a stable
 * MCP/scripting contract (D14: storage_status is read-only MCP-exposed).
 */
export interface StorageStatusResult {
  config: StorageConfig | null;
  repoPath: string | null;
  /**
   * The source `gbrain export --restore-only` restores for this repo; the
   * counts cover only its pages. Null when no restore target was resolved.
   */
  restoreSource: string | null;
  /** Why the restore target was refused; null when it was not. */
  restoreRefusal: string | null;
  totalPages: number;
  pagesByTier: PageCountsByTier;
  missingFiles: Array<{ slug: string; expectedPath: string }>;
  diskUsageByTier: DiskUsageByTier;
  warnings: string[];
}

// ── Dispatcher ────────────────────────────────────────────

// #3686: real usage, reachable via `gbrain storage --help` (the generic
// one-line CLI_ONLY stub used to shadow this surface entirely).
const STORAGE_HELP = `gbrain storage — storage-tier status for the brain repo

USAGE
  gbrain storage [status] [--repo <path>] [--json]

SUBCOMMANDS
  status            (default) Report page counts and disk usage per storage
                    tier, list DB pages whose repo file is missing, and
                    validate the storage config.

OPTIONS
  --repo <path>     Brain repo to walk (default: resolved from the storage
                    config / default source path)
  --json            Machine-readable output
  --help, -h        Show this help
`;

export async function runStorage(engine: BrainEngine, args: string[]): Promise<void> {
  // Help first — before the engine argument is touched, so `--help` works
  // with no brain configured (dispatched engine-free from cli.ts).
  if (args.includes('--help') || args.includes('-h')) {
    console.log(STORAGE_HELP);
    return;
  }
  const subcommand = args[0];
  if (!subcommand || subcommand === 'status') {
    await runStorageStatus(engine, args.slice(1));
    return;
  }
  console.error(`Unknown storage subcommand: ${subcommand}`);
  console.error('Available subcommands: status');
  process.exit(1);
}

async function runStorageStatus(engine: BrainEngine, args: string[]): Promise<void> {
  warnIfPGLite(engine);

  // Resolution chain (D5, Issue #3): explicit --repo → typed accessor → null.
  // No cwd fallback. The original silent footgun is dead. The repo and source
  // come from export's restore-only rule, so the printed restore command
  // restores the files listed as missing; a refused rule keeps the chain.
  const repoIdx = args.indexOf('--repo');
  const explicitRepo = repoIdx !== -1 && args[repoIdx + 1] ? args[repoIdx + 1] : undefined;
  let repoPath: string | null;
  let restore: StorageRestoreTarget;
  try {
    const target = await resolveRestoreTarget(engine, undefined, explicitRepo);
    // Export matches an archived owner on the exact path only; a repo inside
    // an archived source's tree (dotfile or longest registered local_path)
    // stays a refusal here, as status always refused it. An active source
    // registered at the repo's exact path owns it outright: skip the check,
    // whose prefix match does not prefer active sources over archived ones.
    const [activeOwner] = await engine.executeRaw<{ id: string }>(
      'SELECT id FROM sources WHERE archived IS NOT TRUE AND local_path = $1 LIMIT 1', [resolve(target.repo)]);
    if (!activeOwner) {
      try {
        await resolveSourceForRepoPath(engine, target.repo);
      } catch (e) {
        if (!isResolverUserError(e)) throw e;
        throw new RestoreTargetError((e as Error).message);
      }
    }
    repoPath = target.repo;
    restore = { source: target.source };
  } catch (e) {
    if (!(e instanceof RestoreTargetError)) throw e;
    repoPath = explicitRepo ?? (await getDefaultSourcePath(engine));
    restore = { refusal: e.message };
  }

  const result = await getStorageStatus(engine, repoPath, restore);

  if (args.includes('--json')) {
    console.log(formatStorageStatusJson(result));
    return;
  }
  console.log(formatStorageStatusHuman(result));
}

/**
 * D4: storage tiering on PGLite is a partial feature. The "DB" the pages
 * live in IS the local file gbrain uses for everything else, so "db_only"
 * has no real offload effect. The .gitignore management still helps
 * (keeps bulk content out of git history), so we warn but proceed.
 *
 * Once-per-process via a module-local flag — sub-commands invoked from a
 * single CLI run share the same warning.
 */
let _pgliteWarned = false;
function warnIfPGLite(engine: BrainEngine): void {
  if (_pgliteWarned) return;
  if (engine.kind !== 'pglite') return;
  _pgliteWarned = true;
  console.warn(
    `Note: storage tiering has limited effect on PGLite — pages live in your ` +
      `local database file regardless of tier. The .gitignore management still ` +
      `keeps bulk content out of git history. To get full tiering, migrate to ` +
      `Postgres with \`gbrain migrate --to postgres --plan\`.`,
  );
}

/** Reset for tests. */
export function __resetPGLiteWarn(): void {
  _pgliteWarned = false;
}

// ── Pure data ─────────────────────────────────────────────

/**
 * The repo's path inside its enclosing git checkout, as a `dir/` prefix
 * (empty when the repo is the checkout root or in none). A recorded
 * source_path starting with it is re-anchored by resolveSourceLocalFilePath,
 * so the repo walk cannot answer for it.
 */
function gitScopePrefix(repoPath: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- repoPath is the local operator's --repo arg, a registered source path or the default source path on the trusted `gbrain storage status` CLI (never MCP/remote); this only absolutizes it
  const repo = resolve(repoPath);
  for (let cursor = repo; ; cursor = dirname(cursor)) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- read-only existence probe walking up from that operator-supplied repo path
    if (existsSync(join(cursor, '.git'))) {
      const scope = relative(cursor, repo).split(sep).filter(Boolean).join('/');
      return scope ? scope + '/' : '';
    }
    if (dirname(cursor) === cursor) return '';
  }
}

/** The restore-only source for the repo, or why it was refused. */
export type StorageRestoreTarget = { source: string } | { refusal: string };

/**
 * The source whose pages count when no restore source was resolved: the one
 * owning repoPath (dotfile, then longest registered local_path), else none
 * (every source counts). After a refused restore target, an owner the
 * resolver rejects (an archived source) counts every source too: the refusal
 * already tells the user why no restore command fits.
 */
async function repoOwner(
  engine: BrainEngine,
  repoPath: string,
  restore: StorageRestoreTarget | undefined,
): Promise<string | null> {
  try {
    return (await resolveSourceForRepoPath(engine, repoPath))?.source_id ?? null;
  } catch (e) {
    if (restore && 'refusal' in restore && isResolverUserError(e)) return null;
    throw e;
  }
}

/**
 * Compute the storage status against the given engine + brain repo path.
 *
 * Side-effect-free apart from the engine.listPages call and one recursive
 * filesystem walk. Pure for testability — formatters are tested separately.
 *
 * Returns null `config` when no gbrain.yml is present at repoPath. In that
 * case pagesByTier is all zeros for db_tracked/db_only and totals roll up
 * into unspecified.
 *
 * `restore` with a source counts only that source's pages; without one, the
 * pages of the source that owns repoPath are counted.
 */
export async function getStorageStatus(
  engine: BrainEngine,
  repoPath: string | null,
  restore?: StorageRestoreTarget,
): Promise<StorageStatusResult> {
  const config = repoPath ? loadStorageConfig(repoPath) : null;
  const warnings = config ? validateStorageConfig(config) : [];
  if (repoPath && hasUnresolvedDbOnlyDeclaration(repoPath, config)) warnings.push('gbrain.yml declares storage.db_only but no directory resolved from it (a flow list split over lines, or the key outside storage:); list the directories in block style or as one line, db_only: [a/, b/]. Until then sync keeps every page whose file is gone (#8007).');

  const pagesByTier: PageCountsByTier = { db_tracked: 0, db_only: 0, unspecified: 0 };
  const diskUsageByTier: DiskUsageByTier = { db_tracked: 0, db_only: 0, unspecified: 0 };
  const missingFiles: Array<{ slug: string; expectedPath: string }> = [];

  // Single recursive walk of the brain repo (Issue #14). Replaces per-page
  // existsSync+statSync — was ~400K syscalls on 200K-page brains, now ~one
  // per directory + one stat per .md file, plus O(1) lookups below.
  const fileMap: Map<string, DiskFileEntry> = repoPath ? walkBrainRepo(repoPath) : new Map();

  const restoreSource = restore && 'source' in restore ? restore.source : null;
  const sourceId = restoreSource ?? (repoPath ? await repoOwner(engine, repoPath, restore) : null);
  const pages = await engine.listPages({
    limit: 1_000_000,
    ...(sourceId ? { sourceId } : {}),
  });

  // Pages export would refuse the whole restore on, grouped per reason (with
  // the lowest slug named) so a symlinked db_only dir yields one warning,
  // not one line per page.
  const refusedPages = new Map<string, { first: string; count: number }>();
  const scopePrefix = repoPath ? gitScopePrefix(repoPath) : '';
  const slugRootModes = new Map<string, SlugRootMode>();
  for (const page of pages) {
    const tier = config ? getStorageTier(page.slug, config) : 'unspecified';
    pagesByTier[tier]++;
    if (!repoPath) continue;
    const entry = fileMap.get(page.slug);
    if (entry) diskUsageByTier[tier] += entry.size;
    // Missing means what `export --restore-only` restores: any page under a
    // db_only dir (a db_tracked parent dir does not exempt it) whose recorded
    // source_path, else <slug>.md, is absent, checked the way export checks.
    if (!config || !isDbOnly(page.slug, config)) continue;
    const sourcePath = page.source_path ?? null;
    // Fast path, no per-page syscall: the walk saw the exact file export
    // checks as a regular file under real (non-symlink) directories, so
    // export's check finds it too. A recorded path that export would
    // re-anchor (it starts with the repo's path inside its git checkout)
    // takes the full check.
    const walkedKey = sourcePath === null ? page.slug
      : sourcePath.endsWith('.md') && !(scopePrefix && sourcePath.startsWith(scopePrefix)) ? sourcePath.slice(0, -3) : null;
    if (walkedKey !== null && fileMap.has(walkedKey)) continue;
    let expectedPath: string;
    let present: boolean;
    try {
      if (!slugRootModes.has(page.source_id)) slugRootModes.set(page.source_id, await scannerSlugRootMode(engine, page.source_id, repoPath));
      expectedPath = restoreFilePath(repoPath, page.slug, sourcePath, sourcePath ? Buffer.byteLength(sourcePath) : 0, slugRootModes.get(page.source_id)!);
      present = existsSync(nativeFileTarget(repoPath, expectedPath));
    } catch (e) {
      // Export refuses the whole restore on this page (unsafe recorded path,
      // symlinked or ambiguous file target); report that refusal.
      if (!(e instanceof RestoreTargetError) && !(e instanceof OperationError)) throw e;
      const group = refusedPages.get(e.message);
      if (!group) refusedPages.set(e.message, { first: page.slug, count: 1 });
      else {
        group.count++;
        if (page.slug < group.first) group.first = page.slug;
      }
      continue;
    }
    if (!present) missingFiles.push({ slug: page.slug, expectedPath });
  }

  // Ordered by each group's lowest slug, so warnings and the printed refusal
  // are the same run to run whatever order the pages were listed in.
  const refusals = [...refusedPages].sort(([, a], [, b]) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  for (const [reason, { first, count }] of refusals) {
    warnings.push(count === 1 ? `${first}: ${reason}` : `${first} and ${count - 1} more page(s): ${reason}`);
  }

  return {
    config,
    repoPath,
    restoreSource,
    restoreRefusal: restore && 'refusal' in restore ? restore.refusal : (refusals[0]?.[0] ?? null),
    totalPages: pages.length,
    pagesByTier,
    missingFiles,
    diskUsageByTier,
    warnings,
  };
}

// ── JSON formatter ────────────────────────────────────────

/**
 * Serialize StorageStatusResult to a stable JSON contract. Indented for
 * human readability; agents/orchestrators can parse with a standard
 * JSON.parse. Schema is the StorageStatusResult interface above.
 */
export function formatStorageStatusJson(result: StorageStatusResult): string {
  return JSON.stringify(result, null, 2);
}

// ── Human formatter ───────────────────────────────────────

/**
 * Render StorageStatusResult to ASCII text suitable for terminal output.
 * D10 lock: ASCII separators only — universally portable. No unicode
 * box-drawing.
 */
export function formatStorageStatusHuman(result: StorageStatusResult): string {
  const lines: string[] = [];
  lines.push('Storage Status');
  lines.push('==============');
  lines.push('');

  if (!result.config) {
    lines.push('No gbrain.yml configuration found.');
    if (result.repoPath) lines.push(`Checked: ${result.repoPath}/gbrain.yml`);
    lines.push('');
    lines.push('All pages are stored in git by default.');
    lines.push(`Total pages: ${result.totalPages}`);
    return lines.join('\n');
  }

  lines.push(`Repository: ${result.repoPath}`);
  lines.push(`Total pages: ${result.totalPages}`);
  lines.push('');
  lines.push('Storage Tiers:');
  lines.push('-------------');
  lines.push(`DB tracked:     ${result.pagesByTier.db_tracked.toLocaleString()} pages`);
  lines.push(`DB only:        ${result.pagesByTier.db_only.toLocaleString()} pages`);
  lines.push(`Unspecified:    ${result.pagesByTier.unspecified.toLocaleString()} pages`);

  if (result.diskUsageByTier.db_tracked > 0 || result.diskUsageByTier.db_only > 0) {
    lines.push('');
    lines.push('Disk Usage:');
    lines.push('-----------');
    if (result.diskUsageByTier.db_tracked > 0) {
      lines.push(`DB tracked:     ${formatBytes(result.diskUsageByTier.db_tracked)}`);
    }
    if (result.diskUsageByTier.db_only > 0) {
      lines.push(`DB only:        ${formatBytes(result.diskUsageByTier.db_only)}`);
    }
    if (result.diskUsageByTier.unspecified > 0) {
      lines.push(`Unspecified:    ${formatBytes(result.diskUsageByTier.unspecified)}`);
    }
  }

  if (result.missingFiles.length === 0 && result.restoreRefusal) {
    lines.push('');
    lines.push(`Cannot suggest a restore command: ${result.restoreRefusal}`);
  }

  if (result.missingFiles.length > 0) {
    lines.push('');
    lines.push('Missing Files (need restore):');
    lines.push('-----------------------------');
    for (const missing of result.missingFiles.slice(0, 10)) {
      lines.push(`  ${missing.slug}`);
    }
    if (result.missingFiles.length > 10) {
      lines.push(`  ... and ${result.missingFiles.length - 10} more`);
    }
    lines.push('');
    if (result.restoreRefusal) {
      lines.push(`Cannot suggest a restore command: ${result.restoreRefusal}`);
    } else {
      const source = result.restoreSource ? ` --source ${result.restoreSource}` : '';
      // Shell-quoted: the line is meant to be pasted, and a repo path may hold
      // quotes, `$(...)` or backticks.
      lines.push(`Use: gbrain export --restore-only${source} --repo ${shellQuote(result.repoPath ?? '')}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    lines.push('---------');
    for (const warning of result.warnings) lines.push(`  ! ${warning}`);
  }

  lines.push('');
  lines.push('Configuration:');
  lines.push('--------------');
  lines.push('DB tracked directories:');
  for (const dir of result.config.db_tracked) lines.push(`  - ${dir}`);
  lines.push('');
  lines.push('DB-only directories:');
  for (const dir of result.config.db_only) lines.push(`  - ${dir}`);

  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
