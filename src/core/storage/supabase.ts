import type { StorageBackend, StorageConfig } from '../storage.ts';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

/**
 * Supabase Storage — uses the Supabase Storage REST API.
 * Auth via the service role key (not the anon key).
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

  private encodedPath(path: string): string {
    return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
  }

  private url(path: string): string {
    return `${this.projectUrl}/storage/v1/object/${this.bucket}/${this.encodedPath(path)}`;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.serviceRoleKey}`,
      'apikey': this.serviceRoleKey,
    };
  }

  async upload(path: string, data: Buffer, mime?: string): Promise<void> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': mime || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: new Uint8Array(data),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase upload failed: ${res.status} ${body}`);
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

  async getUrl(path: string, options?: { expiresInSeconds?: number }): Promise<string> {
    const expiresIn = options?.expiresInSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
    const res = await fetch(`${this.projectUrl}/storage/v1/object/sign/${this.bucket}/${this.encodedPath(path)}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase signed URL failed: ${res.status} ${body}`);
    }
    const data = await res.json() as { signedURL?: string; signedUrl?: string };
    const signedPath = data.signedURL ?? data.signedUrl;
    if (!signedPath) throw new Error('Supabase signed URL response did not include signedURL');
    if (/^https?:\/\//i.test(signedPath)) return signedPath;
    if (signedPath.startsWith('/storage/v1/')) return `${this.projectUrl}${signedPath}`;
    return `${this.projectUrl}/storage/v1${signedPath.startsWith('/') ? signedPath : `/${signedPath}`}`;
  }
}
