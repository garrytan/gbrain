import { join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { loadStorageConfig, validateStorageConfig, getStorageTier } from '../core/storage-config.ts';
import type { StorageConfig, StorageTier } from '../core/storage-config.ts';
import { walkBrainRepo, type DiskFileEntry } from '../core/disk-walk.ts';
import { getDefaultSourcePath } from '../core/source-resolver.ts';

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
  totalPages: number;
  pagesByTier: PageCountsByTier;
  missingFiles: Array<{ slug: string; expectedPath: string }>;
  diskUsageByTier: DiskUsageByTier;
  warnings: string[];
}

// ── Dispatcher ────────────────────────────────────────────

export async function runStorage(engine: BrainEngine, args: string[]): Promise<void> {
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
  // No cwd fallback. The original silent footgun is dead.
  let repoPath: string | null = null;
  const repoIdx = args.indexOf('--repo');
  if (repoIdx !== -1 && args[repoIdx + 1]) {
    repoPath = args[repoIdx + 1];
  } else {
    repoPath = await getDefaultSourcePath(engine);
  }

  const result = await getStorageStatus(engine, repoPath);

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
      `Postgres with \`gbrain migrate --to supabase\`.`,
  );
}

/** Reset for tests. */
export function __resetPGLiteWarn(): void {
  _pgliteWarned = false;
}

// ── Pure data ─────────────────────────────────────────────

/**
 * Compute the storage status against the given engine + brain repo path.
 *
 * Side-effect-free apart from the engine.listPages call and one recursive
 * filesystem walk. Pure for testability — formatters are tested separately.
 *
 * Returns null `config` when no gbrain.yml is present at repoPath. In that
 * case pagesByTier is all zeros for db_tracked/db_only and totals roll up
 * into unspecified.
 */
export async function getStorageStatus(
  engine: BrainEngine,
  repoPath: string | null,
): Promise<StorageStatusResult> {
  const config = repoPath ? loadStorageConfig(repoPath) : null;
  const warnings = config ? validateStorageConfig(config) : [];

  const pagesByTier: PageCountsByTier = { db_tracked: 0, db_only: 0, unspecified: 0 };
  const diskUsageByTier: DiskUsageByTier = { db_tracked: 0, db_only: 0, unspecified: 0 };
  const missingFiles: Array<{ slug: string; expectedPath: string }> = [];

  // Single recursive walk of the brain repo (Issue #14). Replaces per-page
  // existsSync+statSync — was ~400K syscalls on 200K-page brains, now ~one
  // per directory + one stat per .md file, plus O(1) lookups below.
  const fileMap: Map<string, DiskFileEntry> = repoPath ? walkBrainRepo(repoPath) : new Map();

  const pages = await engine.listPages({ limit: 1_000_000 });

  for (const page of pages) {
    const tier = config ? getStorageTier(page.slug, config) : 'unspecified';
    pagesByTier[tier]++;
    if (!repoPath) continue;
    const entry = fileMap.get(page.slug);
    if (entry) {
      diskUsageByTier[tier] += entry.size;
    } else if (config && tier === 'db_only') {
      missingFiles.push({ slug: page.slug, expectedPath: join(repoPath, page.slug + '.md') });
    }
  }

  return {
    config,
    repoPath,
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
    lines.push(`Use: gbrain export --restore-only --repo "${result.repoPath}"`);
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
