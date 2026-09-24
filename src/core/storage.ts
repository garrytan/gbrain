/**
 * StorageBackend — pluggable interface for binary file storage.
 *
 * GBrain is agnostic about where files live. The setup skill picks
 * the backend (Supabase Storage or S3/R2/MinIO), gbrain doesn't care.
 */

export interface StorageBackend {
  upload(path: string, data: Buffer, mime?: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  /** Exact range from an object of the expected size; reject changed size or ignored ranges. */
  downloadRange?(path: string, offset: number, length: number, size: number): Promise<Buffer>;
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
