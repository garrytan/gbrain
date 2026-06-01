import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Database } from 'bun:sqlite';
import type { BackupFileRef, SqliteDatabaseLike } from './types.ts';

export const SMS_DOMAIN = 'HomeDomain';
export const SMS_RELATIVE_PATH = 'Library/SMS/sms.db';
export const CONTACTS_DOMAIN = 'HomeDomain';
export const CONTACTS_RELATIVE_PATH = 'Library/AddressBook/AddressBook.sqlitedb';

export class IPhoneBackupManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IPhoneBackupManifestError';
  }
}

export interface IPhoneBackupManifestOpts {
  _openDb?: (path: string) => SqliteDatabaseLike;
  _existsSync?: (path: string) => boolean;
}

interface ManifestRow {
  fileID: string;
  domain: string;
  relativePath: string;
}

export class IPhoneBackupManifest {
  private readonly db: SqliteDatabaseLike;
  private readonly exists: (path: string) => boolean;

  constructor(
    private readonly backupDir: string,
    opts: IPhoneBackupManifestOpts = {},
  ) {
    const manifestPath = join(backupDir, 'Manifest.db');
    this.exists = opts._existsSync ?? existsSync;
    const safeManifestPath = resolveContainedRegularFile(backupDir, manifestPath, this.exists);
    if (!safeManifestPath) {
      throw new IPhoneBackupManifestError(`Manifest.db not found in backup directory: ${backupDir}`);
    }
    this.db = opts._openDb
      ? opts._openDb(safeManifestPath)
      : (new Database(safeManifestPath, { readonly: true }) as unknown as SqliteDatabaseLike);
  }

  resolveFile(domain: string, relativePath: string): BackupFileRef | null {
    const row = this.db.query<ManifestRow>(
      `SELECT fileID, domain, relativePath
         FROM Files
        WHERE domain = ? AND relativePath = ?
        LIMIT 1`,
    ).get(domain, relativePath);
    if (!row) return null;
    const path = resolveBackupFilePath(this.backupDir, row.fileID, this.exists);
    if (!path) return null;
    return {
      domain: row.domain,
      relativePath: row.relativePath,
      fileID: row.fileID,
      path,
    };
  }

  close(): void {
    this.db.close?.();
  }
}

export function resolveBackupFilePath(
  backupDir: string,
  fileID: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (!/^[0-9a-f]{40}$/i.test(fileID)) return null;
  const sharded = join(backupDir, fileID.slice(0, 2), fileID);
  const safeSharded = resolveContainedRegularFile(backupDir, sharded, exists);
  if (safeSharded) return safeSharded;
  const flat = join(backupDir, fileID);
  const safeFlat = resolveContainedRegularFile(backupDir, flat, exists);
  if (safeFlat) return safeFlat;
  return null;
}

function resolveContainedRegularFile(
  backupDir: string,
  candidate: string,
  exists: (path: string) => boolean,
): string | null {
  if (!exists(candidate)) return null;

  // Test seams often pass a fake exists function for non-existent paths.
  // Production/default path uses real fs checks to prevent symlink/traversal escapes.
  if (exists !== existsSync) return candidate;

  try {
    const linkStat = lstatSync(candidate);
    if (linkStat.isSymbolicLink()) return null;
    const fileStat = statSync(candidate);
    if (!fileStat.isFile()) return null;
    const root = realpathSync(backupDir);
    const real = realpathSync(candidate);
    const rel = relative(root, real);
    if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return null;
    return real;
  } catch {
    return null;
  }
}
