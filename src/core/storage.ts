import { closeSync, openSync, readSync } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createHash } from 'crypto';

/**
 * StorageBackend — pluggable interface for binary file storage.
 *
 * GBrain is agnostic about where files live. The setup skill picks
 * the backend (Supabase Storage or S3/R2/MinIO), gbrain doesn't care.
 */

export interface StorageBackend {
  upload(path: string, data: Buffer, mime?: string): Promise<void>;
  /**
   * Upload a file from disk with memory bounded independently of its size (#7427). With `sha256`, bytes that differ
   * from it are refused before anything is published, so a stored object is never replaced by them.
   */
  uploadFile(path: string, filePath: string, mime?: string, sha256?: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  getUrl(path: string): Promise<string>;
}

export interface StorageConfig {
  backend: 's3' | 'supabase' | 'local';
  bucket: string;
  region?: string;
  endpoint?: string;
  // S3 credentials
  accessKeyId?: string;
  secretAccessKey?: string;
  // Supabase credentials
  projectUrl?: string;
  serviceRoleKey?: string;
  // Local (for testing)
  localPath?: string;
}

/**
 * Create a StorageBackend from config.
 */
export async function createStorage(config: StorageConfig): Promise<StorageBackend> {
  switch (config.backend) {
    case 's3': {
      const { S3Storage } = await import('./storage/s3.ts');
      return new S3Storage(config);
    }
    case 'supabase': {
      const { SupabaseStorage } = await import('./storage/supabase.ts');
      return new SupabaseStorage(config);
    }
    case 'local': {
      const { LocalStorage } = await import('./storage/local.ts');
      return new LocalStorage(config.localPath || '/tmp/gbrain-storage');
    }
    default:
      throw new Error(`Unknown storage backend: ${config.backend}`);
  }
}

/** SHA-256 of a file read in fixed-size chunks, so large originals are never held in memory. */
export function hashStorageFile(filePath: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let length: number;
    while ((length = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, length));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** Upload a file under the hash the caller recorded; a file that changed since then is refused before it is published. */
export async function uploadUnchangedFile(storage: StorageBackend, path: string, filePath: string, sha256: string, mime?: string): Promise<void> {
  await storage.uploadFile(path, filePath, mime, sha256);
}

export function fileChangedDuringUpload(filePath: string): Error {
  return Object.assign(new Error(`${filePath} changed during the upload, so its bytes no longer match the hash taken before it; nothing was stored or recorded. Upload it again once it stops changing.`), { code: 'file_changed_during_upload' });
}

/**
 * Hashes the bytes a backend reads from a file in order (re-reads of a retried range count once), so the backend can
 * refuse before its publishing step when they differ from the hash the caller recorded.
 */
export class FileDigest {
  private readonly hash = createHash('sha256');
  private hashed = 0;

  constructor(private readonly filePath: string, private readonly expected?: string) {}

  async read(file: FileHandle, buffer: Buffer, length: number, position: number): Promise<Buffer> {
    const bytes = await readFileRange(file, buffer, length, position);
    if (position <= this.hashed && position + length > this.hashed) {
      this.hash.update(bytes.subarray(this.hashed - position));
      this.hashed = position + length;
    }
    return bytes;
  }

  assertMatches(size: number): void {
    if (this.expected !== undefined && (this.hashed !== size || this.hash.copy().digest('hex') !== this.expected)) throw fileChangedDuringUpload(this.filePath);
  }
}

/** Read exactly `length` bytes at `position` into the start of `buffer`. */
export async function readFileRange(file: FileHandle, buffer: Buffer, length: number, position: number): Promise<Buffer> {
  for (let filled = 0; filled < length;) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled);
    if (!bytesRead) throw new Error('File shrank during upload');
    filled += bytesRead;
  }
  return buffer.subarray(0, length);
}
