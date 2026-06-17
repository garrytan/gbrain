import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'fs';
import { join, dirname, resolve } from 'path';
import type { StorageBackend } from '../storage.ts';

/**
 * Local filesystem storage — for testing and development.
 * Stores files in a local directory, mimicking S3/Supabase behavior.
 */
export class LocalStorage implements StorageBackend {
  private readonly canonicalBase: string;

  constructor(private basePath: string) {
    mkdirSync(basePath, { recursive: true });
    this.canonicalBase = realpathSync(basePath);
  }

  private contained(path: string): string {
    const full = resolve(this.canonicalBase, path);
    if (!full.startsWith(this.canonicalBase + '/') && full !== this.canonicalBase) {
      throw new Error('Path traversal blocked: ' + path + ' resolves outside storage root');
    }
    return full;
  }

  async upload(path: string, data: Buffer, _mime?: string): Promise<void> {
    const full = this.contained(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }

  async download(path: string): Promise<Buffer> {
    const full = this.contained(path);
    if (!existsSync(full)) throw new Error(`File not found in storage: ${path}`);
    return readFileSync(full);
  }

  async delete(path: string): Promise<void> {
    const full = this.contained(path);
    if (existsSync(full)) unlinkSync(full);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.contained(path));
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.contained(prefix);
    if (!existsSync(dir)) return [];
    const results: string[] = [];
    function walk(d: string, rel: string) {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(d, entry.name), entryRel);
        } else {
          results.push(`${prefix}/${entryRel}`);
        }
      }
    }
    walk(dir, '');
    return results;
  }

  async getUrl(path: string): Promise<string> {
    return `file://${this.contained(path)}`;
  }
}
