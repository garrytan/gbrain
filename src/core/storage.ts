import { openSync, readSync, closeSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

/**
 * StorageBackend — pluggable interface for binary file storage.
 *
 * GBrain is agnostic about where files live. The setup skill picks
 * the backend (Supabase Storage or S3/R2/MinIO), gbrain doesn't care.
 */

export interface StorageBackend {
  upload(path: string, data: Buffer, mime?: string): Promise<void>;
  uploadFile?(path: string, filePath: string, mime?: string): Promise<void>;
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

/** Hash originals with a fixed-size buffer. */
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

/** Prefer bounded-memory file uploads where supported. */
export async function uploadStorageFile(
  storage: StorageBackend, path: string, filePath: string, mime?: string,
): Promise<void> {
  if (storage.uploadFile) await storage.uploadFile(path, filePath, mime);
  else await storage.upload(path, readFileSync(filePath), mime);
}
