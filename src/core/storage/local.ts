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
    this.assertContained(full, path);
    return full;
  }

  private assertContained(full: string, path: string): void {
    if (!full.startsWith(this.canonicalBase + '/') && full !== this.canonicalBase) {
      throw new Error('Path traversal blocked: ' + path + ' resolves outside storage root');
    }
  }

  private assertRealContained(full: string, path: string): void {
    const real = realpathSync(full);
    this.assertContained(real, path);
  }

  private assertParentContained(full: string, path: string): void {
    const parent = dirname(full);
    const realParent = realpathSync(parent);
    this.assertContained(realParent, path);
  }

  private assertExistingAncestorContained(full: string, path: string): void {
    let current = full;
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error('Path traversal blocked: ' + path + ' has no existing ancestor in storage root');
      }
      current = parent;
    }
    this.assertRealContained(current, path);
  }

  async upload(path: string, data: Buffer, _mime?: string): Promise<void> {
    const full = this.contained(path);
    mkdirSync(dirname(full), { recursive: true });
    this.assertParentContained(full, path);
    if (existsSync(full)) {
      this.assertRealContained(full, path);
    }
    writeFileSync(full, data);
  }

  async download(path: string): Promise<Buffer> {
    const full = this.contained(path);
    if (!existsSync(full)) throw new Error(`File not found in storage: ${path}`);
    this.assertRealContained(full, path);
    return readFileSync(full);
  }

  async delete(path: string): Promise<void> {
    const full = this.contained(path);
    if (existsSync(full)) {
      this.assertRealContained(full, path);
      unlinkSync(full);
    }
  }

  async exists(path: string): Promise<boolean> {
    const full = this.contained(path);
    if (!existsSync(full)) return false;
    this.assertRealContained(full, path);
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.contained(prefix);
    if (!existsSync(dir)) return [];
    this.assertRealContained(dir, prefix);
    const results: string[] = [];
    function walk(d: string, rel: string) {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          throw new Error('Path traversal blocked: symlink inside storage root');
        }
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
    const full = this.contained(path);
    if (existsSync(full)) {
      this.assertRealContained(full, path);
    } else {
      this.assertExistingAncestorContained(full, path);
    }
    return `file://${full}`;
  }
}
