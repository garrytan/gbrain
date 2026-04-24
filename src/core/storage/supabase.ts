import type { StorageBackend, StorageConfig } from '../storage.ts';

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

  async getUrl(path: string): Promise<string> {
    // Public URL (if bucket is public) or signed URL
    return `${this.projectUrl}/storage/v1/object/public/${this.bucket}/${path}`;
  }
}
