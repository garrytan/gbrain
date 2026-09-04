/**
 * StorageBackend — pluggable interface for binary file storage.
 *
 * GBrain is agnostic about where files live. The setup skill picks
 * the backend (Supabase Storage or S3/R2/MinIO), gbrain doesn't care.
 */

import { createHash } from 'node:crypto';

export const LOCAL_STORAGE_ID_FILE = '.gbrain-storage-id';

export interface StorageBackend {
  /**
   * Credential-free locator captured by the backend itself. Local storage
   * uses this to bind page-image identity to the canonical directory it will
   * actually access, rather than to a mutable lexical path or symlink.
   */
  readonly identityLocator?: string;
  upload(path: string, data: Buffer, mime?: string): Promise<void>;
  /**
   * Download an object, aborting before more than `maxBytes` are buffered.
   * Callers that accept untrusted object metadata MUST pass a limit: a stale
   * or externally replaced object must not be able to allocate arbitrary RSS.
   */
  download(path: string, maxBytes?: number): Promise<Buffer>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  getUrl(path: string): Promise<string>;
}

export interface StorageConfig {
  backend: 's3' | 'supabase' | 'local';
  bucket: string;
  /**
   * Stable, brain-exclusive object namespace. Page-image keys and metadata
   * bind to this value so changing buckets/backends cannot silently redirect
   * reads or garbage collection to another brain's objects.
   */
  namespace?: string;
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
  /** Finite transport deadline. Credentials and timeout are not identity inputs. */
  requestTimeoutMs?: number;
}

function canonicalStorageUrl(raw: string, label: string): string {
  if (!raw) throw new Error(`${label} is required for page-image storage identity`);
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Fingerprint the physical storage instance used by page images. Credentials
 * are deliberately excluded; the non-secret locator is deliberately included
 * so changing a local mount, Supabase project, S3 endpoint, or AWS region
 * cannot silently redirect reads, writes, or garbage collection.
 */
export function pageImageStorageIdentity(
  config: StorageConfig,
  namespace: string,
  backend?: StorageBackend,
): string {
  let locator: string;
  switch (config.backend) {
    case 'local': {
      // The backend captures its canonical root and reads the durable marker
      // with O_NOFOLLOW. Recomputing here from config would reintroduce a
      // symlink/marker TOCTOU gap between identity and the object operations.
      if (!backend?.identityLocator) {
        throw new Error('Initialized LocalStorage backend is required for page-image identity');
      }
      locator = backend.identityLocator;
      break;
    }
    case 'supabase':
      locator = `project:${canonicalStorageUrl(config.projectUrl || '', 'storage.projectUrl')}`;
      break;
    case 's3': {
      const region = config.region || 'us-east-1';
      const endpoint = config.endpoint
        ? canonicalStorageUrl(config.endpoint, 'storage.endpoint')
        : 'aws-default';
      locator = `endpoint:${endpoint}\0region:${region}`;
      break;
    }
    default:
      throw new Error('Unknown page-image storage backend');
  }
  return `v3:${createHash('sha256')
    .update(`${config.backend}\0${config.bucket}\0${namespace}\0${locator}`)
    .digest('hex')}`;
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
