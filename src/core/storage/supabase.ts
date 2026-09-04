import type { StorageBackend, StorageConfig } from '../storage.ts';

/** Size thresholds for upload method selection */
const TUS_THRESHOLD = 100 * 1024 * 1024;   // 100 MB — use TUS resumable above this
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;     // 6 MB chunks for TUS uploads
const SIGNED_URL_EXPIRY = 3600;             // 1 hour

/** Injectable fetch seam (same shape as github-source.ts); tests stub the network. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

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
  private fetchImpl: FetchImpl;
  private requestTimeoutMs: number;

  constructor(config: StorageConfig, fetchImpl: FetchImpl = fetch) {
    this.projectUrl = config.projectUrl || '';
    this.serviceRoleKey = config.serviceRoleKey || '';
    this.bucket = config.bucket;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = Number.isSafeInteger(config.requestTimeoutMs) && config.requestTimeoutMs! > 0
      ? Math.min(config.requestTimeoutMs!, 10 * 60 * 1000)
      : 60_000;
    if (!this.projectUrl || !this.serviceRoleKey) {
      throw new Error('Supabase storage requires projectUrl and serviceRoleKey in config');
    }
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Supabase storage request timed out')),
      this.requestTimeoutMs,
    );
    timer.unref?.();
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
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
    await this.withTimeout(async signal => {
      if (data.length >= TUS_THRESHOLD) {
        await this.uploadTus(path, data, mime, signal);
      } else {
        await this.uploadStandard(path, data, mime, signal);
      }
    });
  }

  /** Standard single-request upload for files < 100 MB */
  private async uploadStandard(
    path: string,
    data: Buffer,
    mime: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await this.fetchImpl(this.url(path), {
      method: 'POST',
      signal,
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
  private async uploadTus(
    path: string,
    data: Buffer,
    mime: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const tusUrl = `${this.projectUrl}/storage/v1/upload/resumable`;
    const objectName = `${this.bucket}/${path}`;

    // Step 1: Create the upload session
    const createRes = await this.fetchImpl(tusUrl, {
      method: 'POST',
      signal,
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
            const headRes = await this.fetchImpl(uploadUrl, {
              method: 'HEAD',
              signal,
              headers: { ...this.headers(), 'Tus-Resumable': '1.0.0' },
            });
            if (headRes.ok) {
              const serverOffset = headRes.headers.get('Upload-Offset');
              if (serverOffset) offset = parseInt(serverOffset, 10);
            }
          }

          const end = Math.min(offset + TUS_CHUNK_SIZE, data.length);
          const chunk = data.subarray(offset, end);

          const patchRes = await this.fetchImpl(uploadUrl, {
            method: 'PATCH',
            signal,
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
          await this.abortableDelay(1000 * Math.pow(2, attempt - 1), signal);
        }
      }
    }
  }

  async download(path: string, maxBytes?: number): Promise<Buffer> {
    return this.withTimeout(async signal => {
      const res = await this.fetchImpl(this.url(path), {
        headers: this.headers(),
        signal,
      });
      if (!res.ok) throw new Error(`Supabase download failed: ${res.status}`);
      const declaredLength = Number(res.headers.get('content-length'));
      if (maxBytes !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Storage object exceeds the ${maxBytes}-byte download limit`);
      }
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (maxBytes !== undefined && total > maxBytes) {
            await reader.cancel();
            throw new Error(`Storage object exceeds the ${maxBytes}-byte download limit`);
          }
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, total);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (maxBytes !== undefined && bytes.length > maxBytes) {
        throw new Error(`Storage object exceeds the ${maxBytes}-byte download limit`);
      }
      return bytes;
    });
  }

  async delete(path: string): Promise<void> {
    await this.withTimeout(async signal => {
      const res = await this.fetchImpl(`${this.projectUrl}/storage/v1/object/${this.bucket}`, {
        method: 'DELETE',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [path] }),
        signal,
      });
      if (!res.ok && res.status !== 404) throw new Error(`Supabase delete failed: ${res.status}`);
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.withTimeout(async signal => {
      const res = await this.fetchImpl(this.url(path), {
        method: 'HEAD',
        headers: this.headers(),
        signal,
      });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`Supabase exists failed: ${res.status}`);
      return true;
    });
  }

  async list(prefix: string): Promise<string[]> {
    return this.withTimeout(async signal => {
      const res = await this.fetchImpl(`${this.projectUrl}/storage/v1/object/list/${this.bucket}`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 1000 }),
        signal,
      });
      if (!res.ok) throw new Error(`Supabase list failed: ${res.status}`);
      const items = await res.json() as { name: string }[];
      return items.map(i => `${prefix}/${i.name}`);
    });
  }

  /** Generate a signed URL with 1-hour expiry for private bucket access */
  async getSignedUrl(path: string, expiresIn: number = SIGNED_URL_EXPIRY): Promise<string> {
    return this.withTimeout(async signal => {
      const res = await this.fetchImpl(`${this.projectUrl}/storage/v1/object/sign/${this.bucket}/${path}`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Supabase signed URL failed: ${res.status} ${body}`);
      }
      const result = await res.json() as { signedURL: string };
      // Supabase returns `signedURL` relative to the Storage API root, e.g.
      // "/object/sign/<bucket>/<path>?token=...". Prepend projectUrl + "/storage/v1"
      // (not just projectUrl) or the link 404s. Tolerate an already-absolute URL or a
      // value that already carries the /storage/v1 prefix.
      const signed = result.signedURL;
      if (/^https?:\/\//.test(signed)) return signed;
      if (signed.startsWith('/storage/v1')) return `${this.projectUrl}${signed}`;
      return `${this.projectUrl}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
    });
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
