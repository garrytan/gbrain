import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { configDir } from './config.ts';
import { acquireLock, clearReapMarker, releaseLock } from './pglite-lock.ts';
import { isPgliteProcessStartupFailure, isPgliteToastInconsistencyError } from './pglite-errors.ts';
import { createWithStartupDetail } from './pglite-startup-detail.ts';
import { attemptWalRepairAndRetry, clearRepairAttemptSidecar } from './pglite-repair.ts';
import { pgControlLooksCleanlyShutdown } from './pglite-resetwal.ts';
import { PGLITE_DATA_PROTECTION_POLICY } from './pglite-data-policy.ts';

export const PGLITE_UPGRADE_BACKUP_RETENTION = 2;
export const PGLITE_UPGRADE_BACKUP_DIRNAME = 'pglite-upgrades';

const MANIFEST_FILE = 'manifest.json';
const BACKUP_DATABASE_DIR = 'brain.pglite';
const PROTECTED_COUNT_TABLES = [
  'pages',
  'page_versions',
  'sources',
  'tags',
  'page_tags',
  'timeline_entries',
  'raw_data',
  'files',
  'takes',
  'facts',
  'access_tokens',
  'oauth_clients',
] as const;

export interface PgliteDirectoryInventory {
  files: number;
  bytes: number;
  sha256: string;
}

export interface PgliteRecoveryValidation {
  status: 'verified';
  verified_at: string;
  schema_version: number | null;
  protected_table_counts: Record<string, number>;
}

export interface PgliteUpgradeBackupManifest {
  manifest_version: 1;
  backup_id: string;
  status: 'verified';
  created_at: string;
  source_database_path: string;
  backup_database_path: string;
  target_version: string;
  source_schema_version: number | null;
  source_inventory: PgliteDirectoryInventory;
  backup_inventory: PgliteDirectoryInventory;
  recovery_validation: PgliteRecoveryValidation;
  data_policy_version: number;
  rebuildable_artifacts: readonly string[];
}

export interface CreatePgliteUpgradeBackupOptions {
  databasePath: string;
  backupRoot: string;
  targetVersion: string;
  lockTimeoutMs?: number;
}

export interface PgliteUpgradeBackupResult {
  status: 'created' | 'reused' | 'verified';
  backupDirectory: string;
  backupDatabasePath: string;
  manifestPath: string;
  manifest: PgliteUpgradeBackupManifest;
}

export interface PgliteUpgradeBackupSummary {
  backupDirectory: string;
  backupDatabasePath: string;
  manifestPath: string;
  manifest: PgliteUpgradeBackupManifest;
}

export interface DeletePgliteUpgradeBackupResult {
  status: 'deleted';
  backupDirectory: string;
}

export interface PrunePgliteUpgradeBackupsResult {
  status: 'pruned';
  keep: number;
  kept: string[];
  deleted: string[];
}

export interface RestorePgliteUpgradeBackupResult {
  status: 'restored';
  backupDirectory: string;
  databasePath: string;
}

export interface SetPgliteUpgradeBackupRootResult {
  status: 'updated' | 'unchanged';
  backupRoot: string;
}

function normalizedPath(value: string): string {
  const full = resolve(value);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function defaultPgliteUpgradeBackupRoot(): string {
  return join(configDir(), 'backups', PGLITE_UPGRADE_BACKUP_DIRNAME);
}

export function resolvePgliteUpgradeBackupRoot(configured?: string | null): string {
  const trimmed = configured?.trim() ?? '';
  if (!trimmed) return defaultPgliteUpgradeBackupRoot();
  if (!isAbsolute(trimmed)) {
    throw new Error('PGLite backup root must be an absolute path.');
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    throw new Error("PGLite backup root must not contain '..' segments.");
  }
  return resolve(trimmed);
}

function assertDatabaseAndBackupRootSeparated(databasePath: string, backupRoot: string): void {
  const realDatabasePath = existsSync(databasePath) ? realpathSync(databasePath) : resolve(databasePath);
  const realBackupRoot = existsSync(backupRoot) ? realpathSync(backupRoot) : resolve(backupRoot);
  if (normalizedPath(realDatabasePath) === normalizedPath(realBackupRoot)
      || isWithin(realDatabasePath, realBackupRoot)
      || isWithin(realBackupRoot, realDatabasePath)) {
    throw new Error('PGLite database directory and backup root must not contain one another.');
  }
}

function normalizedKeepCount(keep?: number): number {
  const value = keep ?? PGLITE_UPGRADE_BACKUP_RETENTION;
  if (!Number.isInteger(value) || value < PGLITE_UPGRADE_BACKUP_RETENTION) {
    throw new Error(`PGLite upgrade backups must keep at least ${PGLITE_UPGRADE_BACKUP_RETENTION} copies.`);
  }
  return value;
}

function assertBackupInsideRoot(backupRoot: string, backupDirectory: string, label: string): void {
  if (!isWithin(backupRoot, backupDirectory)) {
    throw new Error(`${label} is outside the configured backup root: ${backupDirectory}`);
  }
}

function assertDirectoryNotSymlink(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function isPgliteRuntimePath(relativePath: string): boolean {
  const topLevel = relativePath.split(/[\\/]/)[0];
  return topLevel === '.gbrain-lock'
    || topLevel === '.pmbrain-resolve.sock'
    || topLevel === 'postmaster.pid'
    || topLevel === 'postmaster.opts';
}

function listInventoryFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const rel = relative(root, full);
      if (isPgliteRuntimePath(rel)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`PGLite backup refuses symbolic links inside the database directory: ${full}`);
      }
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
      else throw new Error(`PGLite backup found an unsupported filesystem entry: ${full}`);
    }
  };
  visit(root);
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

async function hashFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolveStream);
  });
}

export async function inventoryPgliteDirectory(root: string): Promise<PgliteDirectoryInventory> {
  assertDirectoryNotSymlink(root, 'PGLite database directory');
  const files = listInventoryFiles(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const path of files) {
    const rel = relative(root, path).split(sep).join('/');
    const size = statSync(path).size;
    bytes += size;
    hash.update(rel);
    hash.update('\0');
    hash.update(String(size));
    hash.update('\0');
    await hashFile(hash, path);
    hash.update('\0');
  }
  return { files: files.length, bytes, sha256: hash.digest('hex') };
}

function sameInventory(a: PgliteDirectoryInventory, b: PgliteDirectoryInventory): boolean {
  return a.files === b.files && a.bytes === b.bytes && a.sha256 === b.sha256;
}

function safeRemoveTemporary(root: string, target: string): void {
  if (!isWithin(root, target) || !basename(target).startsWith('.')) {
    throw new Error(`Refusing to remove unverified temporary backup path: ${target}`);
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

function copyColdDatabase(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: sourcePath => {
      const rel = relative(source, sourcePath);
      return rel === '' || !isPgliteRuntimePath(rel);
    },
  });
}

async function preservingProcessExitCode<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = previous;
  }
}

function isWasmAbortMessage(message: string): boolean {
  if (isPgliteToastInconsistencyError(message)) return false;
  return /aborted\s*\(\)|RuntimeError|unreachable|abort.*runtime|wasm.*runtime/i.test(message)
    || isPgliteProcessStartupFailure(message);
}

async function openVerifiedRestoreCopy(
  databasePath: string,
  open: () => Promise<PGlite>,
): Promise<PGlite> {
  const fail = (detail: string, cause?: unknown): never => {
    throw new Error(`PGLite recovery-copy WAL repair failed: ${detail}`, { cause });
  };
  const repair = () => attemptWalRepairAndRetry(databasePath, open);

  if (!pgControlLooksCleanlyShutdown(databasePath)) {
    const attempt = await repair();
    if (attempt.status === 'repaired') return attempt.db;
    if (attempt.status !== 'skipped') return fail(attempt.repairError);
    try {
      return await open();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isWasmAbortMessage(message)) throw error;
      return fail(attempt.detail, error);
    }
  }

  try {
    return await open();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isWasmAbortMessage(message)) throw error;
    const attempt = await repair();
    if (attempt.status !== 'repaired') {
      return fail(attempt.status === 'skipped' ? attempt.detail : attempt.repairError, error);
    }
    return attempt.db;
  }
}

async function inspectRestoreCopy(databasePath: string): Promise<PgliteRecoveryValidation> {
  return preservingProcessExitCode(async () => {
    const open = () => createWithStartupDetail(debug => PGlite.create({
      dataDir: databasePath,
      extensions: { vector, pg_trgm },
      ...(debug ? { debug } : {}),
    }));
    const db = await openVerifiedRestoreCopy(databasePath, open);
    try {
      const tableResult = await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      const tables = new Set(tableResult.rows.map(row => row.tablename));
      if (!tables.has('config') && !tables.has('pages')) {
        throw new Error('Recovery verification opened the directory, but it is not a recognizable PMBrain PGLite database.');
      }

      let schemaVersion: number | null = null;
      if (tables.has('config')) {
        const versionResult = await db.query<{ value: unknown }>(
          "SELECT value FROM config WHERE key = 'schema_version' LIMIT 1",
        );
        const raw = versionResult.rows[0]?.value;
        const parsed = Number(typeof raw === 'string' ? raw.replace(/^\"|\"$/g, '') : raw);
        if (Number.isFinite(parsed)) schemaVersion = parsed;
      }

      const protectedTableCounts: Record<string, number> = {};
      for (const table of PROTECTED_COUNT_TABLES) {
        if (!tables.has(table)) continue;
        const count = await db.query<{ count: string | number }>(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
        protectedTableCounts[table] = Number(count.rows[0]?.count ?? 0);
      }

      return {
        status: 'verified',
        verified_at: new Date().toISOString(),
        schema_version: schemaVersion,
        protected_table_counts: protectedTableCounts,
      };
    } finally {
      await db.close();
    }
  });
}

function parseManifest(backupDirectory: string): PgliteUpgradeBackupManifest {
  const manifestPath = join(backupDirectory, MANIFEST_FILE);
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as PgliteUpgradeBackupManifest;
  if (parsed.manifest_version !== 1 || parsed.status !== 'verified') {
    throw new Error(`PGLite backup manifest is unsupported or unverified: ${manifestPath}`);
  }
  const expectedDatabasePath = resolve(backupDirectory, BACKUP_DATABASE_DIR);
  if (normalizedPath(parsed.backup_database_path) !== normalizedPath(expectedDatabasePath)) {
    throw new Error(`PGLite backup manifest points outside its backup directory: ${manifestPath}`);
  }
  return parsed;
}

function listBackupManifests(
  backupRoot: string,
  databasePath?: string,
): Array<{ directory: string; manifest: PgliteUpgradeBackupManifest }> {
  if (!existsSync(backupRoot)) return [];
  const matches: Array<{ directory: string; manifest: PgliteUpgradeBackupManifest }> = [];
  for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const directory = join(backupRoot, entry.name);
    try {
      const manifest = parseManifest(directory);
      if (databasePath && normalizedPath(manifest.source_database_path) !== normalizedPath(databasePath)) continue;
      matches.push({ directory, manifest });
    } catch {
      // An unrelated/incomplete backup is never selected as a recovery point.
    }
  }
  return matches.sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
}

export function listPgliteUpgradeBackups(
  backupRoot: string,
  databasePath?: string | null,
): PgliteUpgradeBackupSummary[] {
  return listBackupManifests(resolve(backupRoot), databasePath ? resolve(databasePath) : undefined)
    .map(({ directory, manifest }) => ({
      backupDirectory: directory,
      backupDatabasePath: manifest.backup_database_path,
      manifestPath: join(directory, MANIFEST_FILE),
      manifest,
    }));
}

function listMatchingBackups(
  backupRoot: string,
  databasePath: string,
  targetVersion: string,
): Array<{ directory: string; manifest: PgliteUpgradeBackupManifest }> {
  return listBackupManifests(backupRoot, databasePath)
    .filter(({ manifest }) => manifest.target_version === targetVersion)
    .sort((a, b) => a.manifest.created_at.localeCompare(b.manifest.created_at));
}

async function verifyUsingDisposableCopy(
  backupRoot: string,
  backupDatabasePath: string,
): Promise<PgliteRecoveryValidation> {
  const verifyRoot = join(backupRoot, `.verify-${randomUUID()}`);
  const verifyDatabasePath = join(verifyRoot, BACKUP_DATABASE_DIR);
  mkdirSync(verifyRoot, { recursive: false, mode: 0o700 });
  try {
    copyColdDatabase(backupDatabasePath, verifyDatabasePath);
    return await inspectRestoreCopy(verifyDatabasePath);
  } finally {
    safeRemoveTemporary(backupRoot, verifyRoot);
  }
}

export async function verifyPgliteUpgradeBackup(
  backupDirectory: string,
): Promise<PgliteUpgradeBackupResult> {
  const directory = resolve(backupDirectory);
  assertDirectoryNotSymlink(directory, 'PGLite backup directory');
  const manifest = parseManifest(directory);
  const actual = await inventoryPgliteDirectory(manifest.backup_database_path);
  if (!sameInventory(actual, manifest.backup_inventory)) {
    throw new Error(
      `PGLite backup integrity verification failed (sha256/size/file-count mismatch): ${directory}`,
    );
  }

  const validation = await verifyUsingDisposableCopy(resolve(directory, '..'), manifest.backup_database_path);
  if (validation.schema_version !== manifest.recovery_validation.schema_version
      || JSON.stringify(validation.protected_table_counts) !== JSON.stringify(manifest.recovery_validation.protected_table_counts)) {
    throw new Error(`PGLite backup recovery verification produced different schema/data counts: ${directory}`);
  }
  return {
    status: 'verified',
    backupDirectory: directory,
    backupDatabasePath: manifest.backup_database_path,
    manifestPath: join(directory, MANIFEST_FILE),
    manifest,
  };
}

export async function createVerifiedPgliteUpgradeBackup(
  options: CreatePgliteUpgradeBackupOptions,
): Promise<PgliteUpgradeBackupResult> {
  const databasePath = resolve(options.databasePath);
  const backupRoot = resolve(options.backupRoot);
  const targetVersion = options.targetVersion.trim();
  if (!targetVersion) throw new Error('PGLite upgrade backup requires a target version.');
  if (!existsSync(databasePath)) throw new Error(`PGLite database directory does not exist: ${databasePath}`);
  assertDirectoryNotSymlink(databasePath, 'PGLite database directory');

  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  assertDirectoryNotSymlink(backupRoot, 'PGLite backup root');
  assertDatabaseAndBackupRootSeparated(databasePath, backupRoot);

  const lock = await acquireLock(databasePath, {
    ownerType: 'migration',
    timeoutMs: options.lockTimeoutMs ?? 30_000,
  });
  try {
    const existing = listMatchingBackups(backupRoot, databasePath, targetVersion)[0];
    if (existing) {
      const verified = await verifyPgliteUpgradeBackup(existing.directory);
      return { ...verified, status: 'reused' };
    }

    const createdAt = new Date().toISOString();
    const safeTarget = targetVersion.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'unknown';
    const backupId = `${createdAt.replace(/[-:.]/g, '')}-${safeTarget}-${randomUUID().slice(0, 8)}`;
    const temporaryDirectory = join(backupRoot, `.${backupId}.tmp`);
    const backupDirectory = join(backupRoot, backupId);
    const temporaryDatabasePath = join(temporaryDirectory, BACKUP_DATABASE_DIR);
    mkdirSync(temporaryDirectory, { recursive: false, mode: 0o700 });

    try {
      const sourceInventory = await inventoryPgliteDirectory(databasePath);
      copyColdDatabase(databasePath, temporaryDatabasePath);
      const backupInventory = await inventoryPgliteDirectory(temporaryDatabasePath);
      if (!sameInventory(sourceInventory, backupInventory)) {
        throw new Error('PGLite cold backup copy failed byte integrity verification.');
      }

      const recoveryValidation = await verifyUsingDisposableCopy(backupRoot, temporaryDatabasePath);
      const finalDatabasePath = join(backupDirectory, BACKUP_DATABASE_DIR);
      const manifest: PgliteUpgradeBackupManifest = {
        manifest_version: 1,
        backup_id: backupId,
        status: 'verified',
        created_at: createdAt,
        source_database_path: databasePath,
        backup_database_path: finalDatabasePath,
        target_version: targetVersion,
        source_schema_version: recoveryValidation.schema_version,
        source_inventory: sourceInventory,
        backup_inventory: backupInventory,
        recovery_validation: recoveryValidation,
        data_policy_version: PGLITE_DATA_PROTECTION_POLICY.version,
        rebuildable_artifacts: PGLITE_DATA_PROTECTION_POLICY.derived_artifacts,
      };
      writeFileSync(
        join(temporaryDirectory, MANIFEST_FILE),
        JSON.stringify(manifest, null, 2) + '\n',
        { mode: 0o600 },
      );
      renameSync(temporaryDirectory, backupDirectory);
      return {
        status: 'created',
        backupDirectory,
        backupDatabasePath: finalDatabasePath,
        manifestPath: join(backupDirectory, MANIFEST_FILE),
        manifest,
      };
    } catch (error) {
      safeRemoveTemporary(backupRoot, temporaryDirectory);
      throw error;
    }
  } finally {
    await releaseLock(lock);
  }
}

function findVerifiedBackup(
  backupRoot: string,
  backupDirectory: string,
  databasePath?: string,
): PgliteUpgradeBackupSummary {
  const directory = resolve(backupDirectory);
  const root = resolve(backupRoot);
  assertDirectoryNotSymlink(root, 'PGLite backup root');
  assertDirectoryNotSymlink(directory, 'PGLite backup directory');
  assertBackupInsideRoot(root, directory, 'PGLite backup directory');
  const manifest = parseManifest(directory);
  if (databasePath && normalizedPath(manifest.source_database_path) !== normalizedPath(databasePath)) {
    throw new Error(`PGLite backup belongs to a different database: ${directory}`);
  }
  return {
    backupDirectory: directory,
    backupDatabasePath: manifest.backup_database_path,
    manifestPath: join(directory, MANIFEST_FILE),
    manifest,
  };
}

export function deletePgliteUpgradeBackup(options: {
  backupDirectory: string;
  backupRoot: string;
  databasePath?: string | null;
}): DeletePgliteUpgradeBackupResult {
  const backupRoot = resolve(options.backupRoot);
  const selected = findVerifiedBackup(
    backupRoot,
    options.backupDirectory,
    options.databasePath ? resolve(options.databasePath) : undefined,
  );
  rmSync(selected.backupDirectory, { recursive: true, force: false });
  return { status: 'deleted', backupDirectory: selected.backupDirectory };
}

export function prunePgliteUpgradeBackups(options: {
  backupRoot: string;
  databasePath: string;
  keep?: number;
}): PrunePgliteUpgradeBackupsResult {
  const keep = normalizedKeepCount(options.keep);
  const backupRoot = resolve(options.backupRoot);
  const databasePath = resolve(options.databasePath);
  const backups = listPgliteUpgradeBackups(backupRoot, databasePath);
  const retained = backups.slice(0, keep);
  const removed = backups.slice(keep);
  const deleted: string[] = [];
  for (const backup of removed) {
    const result = deletePgliteUpgradeBackup({
      backupDirectory: backup.backupDirectory,
      backupRoot,
      databasePath,
    });
    deleted.push(result.backupDirectory);
  }
  return {
    status: 'pruned',
    keep,
    kept: retained.map(backup => backup.backupDirectory),
    deleted,
  };
}

export async function restorePgliteUpgradeBackup(options: {
  backupDirectory: string;
  backupRoot: string;
  databasePath: string;
  lockTimeoutMs?: number;
}): Promise<RestorePgliteUpgradeBackupResult> {
  const databasePath = resolve(options.databasePath);
  const backupRoot = resolve(options.backupRoot);
  const selected = findVerifiedBackup(backupRoot, options.backupDirectory, databasePath);
  const verified = await verifyPgliteUpgradeBackup(selected.backupDirectory);
  if (normalizedPath(verified.manifest.source_database_path) !== normalizedPath(databasePath)) {
    throw new Error(`PGLite backup belongs to a different database: ${selected.backupDirectory}`);
  }
  assertDatabaseAndBackupRootSeparated(databasePath, backupRoot);

  const parent = dirname(databasePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const restoreTemp = join(parent, `.restore-${randomUUID()}.tmp`);
  const replacedTemp = join(parent, `.replaced-${randomUUID()}.tmp`);

  const lock = existsSync(databasePath)
    ? await acquireLock(databasePath, {
      ownerType: 'migration',
      timeoutMs: options.lockTimeoutMs ?? 30_000,
    })
    : null;
  try {
    copyColdDatabase(verified.backupDatabasePath, restoreTemp);
    const copied = await inventoryPgliteDirectory(restoreTemp);
    if (!sameInventory(copied, verified.manifest.backup_inventory)) {
      throw new Error('PGLite restore copy failed byte integrity verification.');
    }
  } catch (error) {
    safeRemoveTemporary(parent, restoreTemp);
    throw error;
  } finally {
    if (lock) await releaseLock(lock);
  }

  try {
    if (existsSync(databasePath)) renameSync(databasePath, replacedTemp);
    try {
      renameSync(restoreTemp, databasePath);
    } catch (error) {
      if (existsSync(replacedTemp) && !existsSync(databasePath)) {
        renameSync(replacedTemp, databasePath);
      }
      throw error;
    }
  } catch (error) {
    safeRemoveTemporary(parent, restoreTemp);
    throw error;
  }
  try {
    safeRemoveTemporary(parent, replacedTemp);
  } catch {
    // Live database already restored; leftover previous copy is not a restore failure.
  }

  clearReapMarker(databasePath);
  clearRepairAttemptSidecar(databasePath);

  return {
    status: 'restored',
    backupDirectory: selected.backupDirectory,
    databasePath,
  };
}

export function preparePgliteUpgradeBackupRoot(options: {
  backupRoot: string;
  databasePath?: string | null;
}): SetPgliteUpgradeBackupRootResult {
  const backupRoot = resolvePgliteUpgradeBackupRoot(options.backupRoot);
  if (options.databasePath) {
    assertDatabaseAndBackupRootSeparated(resolve(options.databasePath), backupRoot);
  }
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  assertDirectoryNotSymlink(backupRoot, 'PGLite backup root');
  if (options.databasePath) {
    assertDatabaseAndBackupRootSeparated(resolve(options.databasePath), backupRoot);
  }
  return { status: 'updated', backupRoot };
}
