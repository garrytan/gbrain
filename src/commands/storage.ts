import { existsSync, mkdirSync, readdirSync, rmSync, renameSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { basename, join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { gbrainPath } from '../core/config.ts';
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

export interface StorageBackupResult {
  ok: boolean;
  started_at: string;
  finished_at: string;
  output_path: string | null;
  output_bytes: number;
  raw_bytes: number;
  compression: 'zstd' | 'none';
  verified_file_count: number;
  pruned: Array<{ path: string; bytes: number }>;
  retained_count: number;
  retained_bytes: number;
  warnings: string[];
}

// ── Dispatcher ────────────────────────────────────────────

export async function runStorage(engine: BrainEngine, args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'status') {
    await runStorageStatus(engine, args.slice(1));
    return;
  }
  if (subcommand === 'vacuum') {
    await runStorageVacuum(engine, args.slice(1));
    return;
  }
  if (subcommand === 'backup') {
    await runStorageBackup(engine, args.slice(1));
    return;
  }
  console.error(`Unknown storage subcommand: ${subcommand}`);
  console.error('Available subcommands: status, vacuum, backup');
  process.exit(1);
}

async function runStorageBackup(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseBackupArgs(args);
  const result = await createPgliteBackup(engine, opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.ok) {
    console.log(`Storage backup skipped: ${result.warnings.join('; ')}`);
    return;
  }

  console.log(
    `Storage backup complete: ${result.output_path} ` +
      `(${formatBytes(result.output_bytes)}, ${result.verified_file_count} files verified)`,
  );
  if (result.pruned.length > 0) {
    console.log(`Pruned ${result.pruned.length} old backup(s).`);
  }
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
}

async function runStorageVacuum(engine: BrainEngine, args: string[]): Promise<void> {
  const vacuumSql = 'VACUUM (ANALYZE)';
  const checkpointSql = 'CHECKPOINT';
  const startedAt = new Date().toISOString();

  await engine.executeRaw(vacuumSql);
  await engine.executeRaw(checkpointSql);

  const result = {
    ok: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    vacuum: vacuumSql,
    checkpoint: checkpointSql,
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Storage vacuum complete: ${vacuumSql}; ${checkpointSql}`);
}

interface BackupOptions {
  dir: string;
  maxCount: number;
  maxBytes: number;
  minFreeBytes: number;
  compress: boolean;
  zstdBin: string;
  json: boolean;
}

function parseBackupArgs(args: string[]): BackupOptions {
  const valueAfter = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx === -1 ? undefined : args[idx + 1];
  };

  return {
    dir: valueAfter('--dir') || process.env.GBRAIN_DREAM_BACKUP_DIR || gbrainPath('backups', 'dream-cycle'),
    maxCount: parsePositiveInt(valueAfter('--max-count') || process.env.GBRAIN_DREAM_BACKUP_MAX_COUNT, 7),
    maxBytes: parseBytes(valueAfter('--max-bytes') || process.env.GBRAIN_DREAM_BACKUP_MAX_BYTES, 5 * 1024 ** 3),
    minFreeBytes: parseBytes(valueAfter('--min-free') || process.env.GBRAIN_DREAM_BACKUP_MIN_FREE_BYTES, 20 * 1024 ** 3),
    compress: !args.includes('--no-compress'),
    zstdBin: valueAfter('--zstd-bin') || process.env.GBRAIN_ZSTD_BIN || '/opt/homebrew/bin/zstd',
    json: args.includes('--json'),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBytes(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)?$/i);
  if (!match) return fallback;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return fallback;
  const unit = (match[2] || 'b').toLowerCase();
  const multiplier =
    unit.startsWith('t') ? 1024 ** 4 :
    unit.startsWith('g') ? 1024 ** 3 :
    unit.startsWith('m') ? 1024 ** 2 :
    unit.startsWith('k') ? 1024 :
    1;
  return Math.floor(value * multiplier);
}

interface BackupFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

async function createPgliteBackup(engine: BrainEngine, opts: BackupOptions): Promise<StorageBackupResult> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  mkdirSync(opts.dir, { recursive: true });

  const existing = listBackupFiles(opts.dir);
  const pruneable = existing.length > 2;
  const freeBytes = freeBytesForPath(opts.dir);
  if (!pruneable && freeBytes !== null && freeBytes < opts.minFreeBytes) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      output_path: null,
      output_bytes: 0,
      raw_bytes: 0,
      compression: opts.compress ? 'zstd' : 'none',
      verified_file_count: 0,
      pruned: [],
      retained_count: existing.length,
      retained_bytes: sumBytes(existing),
      warnings: [`free space ${formatBytes(freeBytes)} is below ${formatBytes(opts.minFreeBytes)} and no backups are pruneable`],
    };
  }

  if (engine.kind !== 'pglite') {
    throw new Error('gbrain storage backup currently supports PGLite only.');
  }

  const db = (engine as unknown as { db?: { dumpDataDir?: (compression?: 'none' | 'gzip' | 'auto') => Promise<Blob | File> } }).db;
  if (!db?.dumpDataDir) {
    throw new Error('Connected PGLite engine does not expose dumpDataDir().');
  }

  await engine.executeRaw('CHECKPOINT');

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const rawName = `brain-pglite-${stamp}.tar`;
  const finalName = opts.compress ? `${rawName}.zst` : rawName;
  const rawTmpPath = join(opts.dir, `.${rawName}.tmp-${process.pid}`);
  const finalTmpPath = join(opts.dir, `.${finalName}.tmp-${process.pid}`);
  const finalPath = join(opts.dir, finalName);

  let rawBytes = 0;
  try {
    const dump = await db.dumpDataDir('none');
    const dumpBytes = Buffer.from(await dump.arrayBuffer());
    rawBytes = dumpBytes.byteLength;
    writeFileSync(rawTmpPath, dumpBytes);

    if (opts.compress) {
      runZstdCompress(opts.zstdBin, rawTmpPath, finalTmpPath);
      unlinkIfExists(rawTmpPath);
    } else {
      renameSync(rawTmpPath, finalTmpPath);
    }

    const verifiedFileCount = verifyBackupArchive(finalTmpPath, opts);
    renameSync(finalTmpPath, finalPath);

    const outputBytes = statSync(finalPath).size;
    const latestExisting = existing.toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (latestExisting && outputBytes > latestExisting.bytes * 3) {
      warnings.push(
        `new backup ${formatBytes(outputBytes)} is more than 3x previous ${formatBytes(latestExisting.bytes)}`,
      );
    }

    const pruned = pruneBackups(opts.dir, opts.maxCount, opts.maxBytes);
    const retained = listBackupFiles(opts.dir);
    const retainedBytes = sumBytes(retained);
    if ((retained.length > opts.maxCount || retainedBytes > opts.maxBytes) && retained.length <= 2) {
      warnings.push('retention caps exceeded but fewer than two verified backups remain, so prune stopped');
    }

    return {
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      output_path: finalPath,
      output_bytes: outputBytes,
      raw_bytes: rawBytes,
      compression: opts.compress ? 'zstd' : 'none',
      verified_file_count: verifiedFileCount,
      pruned,
      retained_count: retained.length,
      retained_bytes: retainedBytes,
      warnings,
    };
  } catch (err) {
    unlinkIfExists(rawTmpPath);
    unlinkIfExists(finalTmpPath);
    throw err;
  }
}

function listBackupFiles(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => /^brain-pglite-\d{8}T\d{6}Z\.tar(?:\.zst)?$/.test(name))
    .map(name => {
      const path = join(dir, name);
      const st = statSync(path);
      return { path, bytes: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || basename(a.path).localeCompare(basename(b.path)));
}

function sumBytes(files: BackupFile[]): number {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

function freeBytesForPath(path: string): number | null {
  try {
    const stat = statfsSync(path);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

function resolveZstdBin(zstdBin: string): string {
  if (existsSync(zstdBin)) return zstdBin;
  if (!zstdBin.includes('/')) return zstdBin;
  return 'zstd';
}

function runZstdCompress(zstdBin: string, inputPath: string, outputPath: string): void {
  const bin = resolveZstdBin(zstdBin);
  const result = spawnSync(bin, ['-q', '-f', '-o', outputPath, inputPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`zstd compression failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
}

function runZstdDecompress(zstdBin: string, inputPath: string, outputPath: string): void {
  const bin = resolveZstdBin(zstdBin);
  const result = spawnSync(bin, ['-q', '-d', '-f', '-o', outputPath, inputPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`zstd verification decompress failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
}

function verifyBackupArchive(path: string, opts: BackupOptions): number {
  let tarPath = path;
  const verifyTmp = `${path}.verify-${process.pid}.tar`;
  try {
    if (path.endsWith('.zst')) {
      runZstdDecompress(opts.zstdBin, path, verifyTmp);
      tarPath = verifyTmp;
    }
    const result = spawnSync('tar', ['-tf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
      throw new Error(`tar verification failed: ${(result.stderr || result.error?.message || '').trim()}`);
    }
    const fileCount = result.stdout.split('\n').filter(Boolean).length;
    if (fileCount < 1) throw new Error('tar verification failed: archive contained zero files');
    return fileCount;
  } finally {
    unlinkIfExists(verifyTmp);
  }
}

function pruneBackups(dir: string, maxCount: number, maxBytes: number): Array<{ path: string; bytes: number }> {
  const pruned: Array<{ path: string; bytes: number }> = [];
  let files = listBackupFiles(dir);
  while ((files.length > maxCount || sumBytes(files) > maxBytes) && files.length > 2) {
    const victim = files[0];
    rmSync(victim.path, { force: true });
    pruned.push({ path: victim.path, bytes: victim.bytes });
    files = listBackupFiles(dir);
  }
  return pruned;
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
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
