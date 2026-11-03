import { chmodSync, createReadStream, createWriteStream, readFileSync, statSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import { join, dirname, resolve, basename } from 'path';
import { createHash, randomBytes } from 'crypto';
import { fileChangedDuringUpload, type StorageBackend } from '../storage.ts';

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

  /** Streams into a sibling temporary file and renames it over the key, so a source that is the stored object itself is never truncated and a refused upload leaves the stored object as it was; an existing object keeps its mode, as a plain write would. */
  async uploadFile(path: string, filePath: string, _mime?: string, sha256?: string): Promise<void> {
    const full = this.contained(path);
    mkdirSync(dirname(full), { recursive: true });
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- full is contained() under the storage root; the partial is its sibling named from its basename and random hex
    const partial = join(dirname(full), `.${basename(full)}.${randomBytes(6).toString('hex')}.partial`);
    const hash = createHash('sha256');
    try {
      await pipeline(createReadStream(filePath).on('data', chunk => hash.update(chunk)), createWriteStream(partial, { flags: 'wx' }));
      if (sha256 !== undefined && hash.digest('hex') !== sha256) throw fileChangedDuringUpload(filePath);
      if (existsSync(full)) chmodSync(partial, statSync(full).mode & 0o7777);
      renameSync(partial, full);
    } finally {
      rmSync(partial, { force: true });
    }
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
