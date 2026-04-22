import type { StorageBackend, StorageConfig } from '../storage.ts';

/** Size thresholds for upload method selection */
const TUS_THRESHOLD = 100 * 1024 * 1024;   // 100 MB — use TUS resumable above this
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;     // 6 MB chunks for TUS uploads
const SIGNED_URL_EXPIRY = 3600;             // 1 hour

/**
 * Supabase Storage — uses the Supabase Storage REST API.
 * Auth via the service role key (not the anon key).
 *
 * Upload method auto-selected by file size:
 *   < 100 MB  → standard POST (single request)
 *   >= 100 MB → TUS resumable upload (6 MB chunks with retry)
 */
export class SupabaseStorage implements StorageBackend {
  private projectUrl: string;
  private serviceRoleKey: string;
  private bucket: string;

  constructor(config: StorageConfig) {
    this.projectUrl = config.projectUrl || '';
    this.serviceRoleKey = config.serviceRoleKey || '';
    this.bucket = config.bucket;
    if (!this.projectUrl || !this.serviceRoleKey) {
      throw new Error('Supabase storage requires projectUrl and serviceRoleKey in config');
    }
  }

  private url(path: string): string {
    return `${this.projectUrl}/storage/v1/object/${this.bucket}/${path}`;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.serviceRoleKey}`,
      'apikey': this.serviceRoleKey,
    };
  }

  async upload(path: string, data: Buffer, mime?: string): Promise<void> {
    if (data.length >= TUS_THRESHOLD) {
      await this.uploadTus(path, data, mime);
    } else {
      await this.uploadStandard(path, data, mime);
    }
  }

  /** Standard single-request upload for files < 100 MB */
  private async uploadStandard(path: string, data: Buffer, mime?: string): Promise<void> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': mime || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as BodyInit,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase upload failed: ${res.status} ${body}`);
    }
  }

  /**
   * TUS resumable upload for files >= 100 MB.
   * Sends in 6 MB chunks with retry + exponential backoff.
   */
  private async uploadTus(path: string, data: Buffer, mime?: string): Promise<void> {
    const tusUrl = `${this.projectUrl}/storage/v1/upload/resumable`;
    const objectName = `${this.bucket}/${path}`;

    // Step 1: Create the upload session
    const createRes = await fetch(tusUrl, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(data.length),
        'Upload-Metadata': [
          `bucketName ${btoa(this.bucket)}`,
          `objectName ${btoa(path)}`,
          `contentType ${btoa(mime || 'application/octet-stream')}`,
        ].join(','),
        'x-upsert': 'true',
      },
    });

    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`TUS create failed: ${createRes.status} ${body}`);
    }

    const uploadUrl = createRes.headers.get('Location');
    if (!uploadUrl) throw new Error('TUS create did not return Location header');

    // Step 2: Upload chunks
    let offset = 0;
    while (offset < data.length) {
      let attempt = 0;
      const maxAttempts = 3;
      while (attempt < maxAttempts) {
        try {
          // On retry, check server's actual offset (TUS spec requirement)
          if (attempt > 0) {
            const headRes = await fetch(uploadUrl, {
              method: 'HEAD',
              headers: { ...this.headers(), 'Tus-Resumable': '1.0.0' },
            });
            if (headRes.ok) {
              const serverOffset = headRes.headers.get('Upload-Offset');
              if (serverOffset) offset = parseInt(serverOffset, 10);
            }
          }

          const end = Math.min(offset + TUS_CHUNK_SIZE, data.length);
          const chunk = data.subarray(offset, end);

          const patchRes = await fetch(uploadUrl, {
            method: 'PATCH',
            headers: {
              ...this.headers(),
              'Tus-Resumable': '1.0.0',
              'Upload-Offset': String(offset),
              'Content-Type': 'application/offset+octet-stream',
              'Content-Length': String(chunk.length),
            },
            body: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) as BodyInit,
          });

          if (!patchRes.ok) {
            const body = await patchRes.text();
            throw new Error(`TUS PATCH failed: ${patchRes.status} ${body}`);
          }

          const newOffset = patchRes.headers.get('Upload-Offset');
          offset = newOffset ? parseInt(newOffset, 10) : end;
          break; // Success, move to next chunk
        } catch (err) {
          attempt++;
          if (attempt >= maxAttempts) throw err;
          // Exponential backoff: 1s, 2s, 4s
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
      }
    }
  }

  async download(path: string): Promise<Buffer> {
    const res = await fetch(this.url(path), {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Supabase download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(`${this.projectUrl}/storage/v1/object/${this.bucket}`, {
      method: 'DELETE',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Supabase delete failed: ${res.status}`);
  }

  async exists(path: string): Promise<boolean> {
    const res = await fetch(this.url(path), {
      method: 'HEAD',
      headers: this.headers(),
    });
    return res.ok;
  }

  async list(prefix: string): Promise<string[]> {
    const res = await fetch(`${this.projectUrl}/storage/v1/object/list/${this.bucket}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000 }),
    });
    if (!res.ok) throw new Error(`Supabase list failed: ${res.status}`);
    const items = await res.json() as { name: string }[];
    return items.map(i => `${prefix}/${i.name}`);
  }

  /** Generate a signed URL with 1-hour expiry for private bucket access */
  async getSignedUrl(path: string, expiresIn: number = SIGNED_URL_EXPIRY): Promise<string> {
    const res = await fetch(`${this.projectUrl}/storage/v1/object/sign/${this.bucket}/${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase signed URL failed: ${res.status} ${body}`);
    }
    const result = await res.json() as { signedURL: string };
    return `${this.projectUrl}${result.signedURL}`;
  }

  async getUrl(path: string): Promise<string> {
    // Try signed URL first (works for private buckets)
    try {
      return await this.getSignedUrl(path);
    } catch {
      // Fall back to public URL
      return `${this.projectUrl}/storage/v1/object/public/${this.bucket}/${path}`;
    }
  }
}
