import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  constants,
  linkSync,
} from 'fs';
import { basename, isAbsolute, join, dirname, relative, resolve, sep } from 'path';
import { randomUUID } from 'node:crypto';
import { LOCAL_STORAGE_ID_FILE, type StorageBackend } from '../storage.ts';

/**
 * Local filesystem storage — for testing and development.
 * Stores files in a local directory, mimicking S3/Supabase behavior.
 */
export class LocalStorage implements StorageBackend {
  private readonly canonicalBase: string;
  readonly identityLocator: string;

  constructor(private basePath: string) {
    mkdirSync(basePath, { recursive: true });
    this.canonicalBase = realpathSync(basePath);
    const stat = statSync(this.canonicalBase);
    if (!stat.isDirectory()) throw new Error('Local storage root must be a directory');
    const marker = this.loadOrCreateIdentityMarker();
    this.identityLocator = `path:${this.canonicalBase}\0marker:${marker}`;
  }

  private loadOrCreateIdentityMarker(): string {
    const markerPath = join(this.canonicalBase, LOCAL_STORAGE_ID_FILE);
    if (!lstatSync(markerPath, { throwIfNoEntry: false })) {
      // Publish the fully-written marker atomically. Creating the final file
      // directly would expose a transient empty file to a second constructor.
      const tempPath = join(this.canonicalBase, `${LOCAL_STORAGE_ID_FILE}.tmp-${randomUUID()}`);
      let createdFd: number | null = null;
      let published = false;
      try {
        createdFd = openSync(
          tempPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        writeFileSync(createdFd, `${randomUUID()}\n`);
        fsyncSync(createdFd);
        closeSync(createdFd);
        createdFd = null;
        try {
          linkSync(tempPath, markerPath);
          published = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        if (published) {
          const dirFd = openSync(this.canonicalBase, constants.O_RDONLY);
          try {
            fsyncSync(dirFd);
          } finally {
            closeSync(dirFd);
          }
        }
      } finally {
        if (createdFd !== null) closeSync(createdFd);
        if (existsSync(tempPath)) unlinkSync(tempPath);
      }
    }

    return this.readIdentityMarker();
  }

  private readIdentityMarker(): string {
    const markerPath = join(this.canonicalBase, LOCAL_STORAGE_ID_FILE);
    const readFd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(readFd).isFile()) throw new Error('Local storage identity marker must be a regular file');
      const marker = readFileSync(readFd, 'utf8').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker)) {
        throw new Error('Local storage identity marker is invalid');
      }
      return marker;
    } finally {
      closeSync(readFd);
    }
  }

  private assertIdentityMarker(): void {
    const current = this.readIdentityMarker();
    const expected = this.identityLocator.slice(this.identityLocator.lastIndexOf('\0marker:') + 8);
    if (current !== expected) throw new Error('Local storage identity marker changed');
  }

  private contained(path: string): string {
    const full = resolve(this.canonicalBase, path);
    const markerPath = join(this.canonicalBase, LOCAL_STORAGE_ID_FILE);
    if (
      full === markerPath ||
      (dirname(full) === this.canonicalBase && basename(full).startsWith(`${LOCAL_STORAGE_ID_FILE}.tmp-`))
    ) {
      throw new Error('Storage identity marker is reserved');
    }
    if (!full.startsWith(this.canonicalBase + '/') && full !== this.canonicalBase) {
      throw new Error('Path traversal blocked: ' + path + ' resolves outside storage root');
    }
    return full;
  }

  /**
   * Walk the lexical parent one component at a time. Recursive mkdir would
   * follow an attacker-planted ancestor symlink before a post-check can run.
   */
  private safeParent(path: string, create: boolean): string {
    const full = this.contained(path);
    const parent = dirname(full);
    const rel = relative(this.canonicalBase, parent);
    let cursor = this.canonicalBase;
    if (rel !== '') {
      for (const segment of rel.split(sep)) {
        cursor = join(cursor, segment);
        const stat = lstatSync(cursor, { throwIfNoEntry: false });
        if (!stat) {
          if (!create) throw new Error(`Storage parent is missing: ${path}`);
          mkdirSync(cursor, { mode: 0o700 });
          continue;
        }
        if (stat.isSymbolicLink()) {
          throw new Error(`Storage ancestor symlink is not allowed: ${path}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`Storage parent component is not a directory: ${path}`);
        }
      }
    }
    return parent;
  }

  async upload(path: string, data: Buffer, _mime?: string): Promise<void> {
    this.assertIdentityMarker();
    const full = this.contained(path);
    const realParent = realpathSync(this.safeParent(path, true));
    const parentRel = relative(this.canonicalBase, realParent);
    if (parentRel === '..' || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) {
      throw new Error(`Storage parent escaped the canonical root: ${path}`);
    }
    // Never open the caller-selected final name for writing: writeFileSync
    // would follow a symlink already placed at that basename and overwrite an
    // arbitrary external file. A same-directory exclusive temp + atomic
    // rename replaces the directory entry itself without following it.
    const finalPath = join(realParent, basename(full));
    const tempPath = join(realParent, `.${basename(full)}.tmp-${randomUUID()}`);
    try {
      writeFileSync(tempPath, data, { flag: 'wx', mode: 0o600 });
      renameSync(tempPath, finalPath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  async download(path: string, maxBytes?: number): Promise<Buffer> {
    this.assertIdentityMarker();
    const full = this.contained(path);
    this.safeParent(path, false);
    const lexical = lstatSync(full, { throwIfNoEntry: false });
    if (!lexical) throw new Error(`File not found in storage: ${path}`);
    if (lexical.isSymbolicLink() || !lexical.isFile()) {
      throw new Error(`Storage object must be a regular file: ${path}`);
    }
    if (maxBytes !== undefined && lexical.size > maxBytes) {
      throw new Error(`Storage object exceeds the ${maxBytes}-byte download limit`);
    }
    return readFileSync(full);
  }

  async delete(path: string): Promise<void> {
    this.assertIdentityMarker();
    const full = this.contained(path);
    try {
      this.safeParent(path, false);
    } catch (err) {
      if (!existsSync(dirname(full))) return;
      throw err;
    }
    const lexical = lstatSync(full, { throwIfNoEntry: false });
    if (!lexical) return;
    if (lexical.isDirectory()) throw new Error(`Refusing to delete storage directory: ${path}`);
    // unlink the lexical directory entry; never realpath the final component.
    unlinkSync(full);
  }

  async exists(path: string): Promise<boolean> {
    this.assertIdentityMarker();
    const full = this.contained(path);
    try {
      this.safeParent(path, false);
    } catch (err) {
      if (!existsSync(dirname(full))) return false;
      throw err;
    }
    const lexical = lstatSync(full, { throwIfNoEntry: false });
    if (!lexical) return false;
    if (lexical.isSymbolicLink() || !lexical.isFile()) {
      throw new Error(`Storage object must be a regular file: ${path}`);
    }
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    this.assertIdentityMarker();
    const dir = this.contained(prefix);
    if (!existsSync(dir)) return [];
    this.safeParent(`${prefix}/.list-probe`, false);
    const prefixStat = lstatSync(dir);
    if (prefixStat.isSymbolicLink() || !prefixStat.isDirectory()) {
      throw new Error(`Storage list prefix must be a regular directory: ${prefix}`);
    }
    const realDir = dir;
    const results: string[] = [];
    const root = this.canonicalBase;
    function walk(d: string, rel: string) {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (
          d === root &&
          (entry.name === LOCAL_STORAGE_ID_FILE || entry.name.startsWith(`${LOCAL_STORAGE_ID_FILE}.tmp-`))
        ) continue;
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(d, entry.name), entryRel);
        } else if (entry.isSymbolicLink()) {
          throw new Error(`Storage symlink is not allowed while listing: ${entryRel}`);
        } else {
          results.push(`${prefix}/${entryRel}`);
        }
      }
    }
    walk(realDir, '');
    return results;
  }

  async getUrl(path: string): Promise<string> {
    this.assertIdentityMarker();
    const full = this.contained(path);
    const parent = this.safeParent(path, false);
    const lexical = lstatSync(full, { throwIfNoEntry: false });
    if (lexical) {
      if (lexical.isSymbolicLink() || !lexical.isFile()) {
        throw new Error(`Storage object must be a regular file: ${path}`);
      }
      return `file://${full}`;
    }
    return `file://${join(parent, basename(full))}`;
  }
}
