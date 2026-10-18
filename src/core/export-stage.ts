import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statfsSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE_MAX_BYTES } from './page-size-policy.ts';
import { FILE_NAME_MAX_BYTES, RESERVED_DEVICE_NAME, truncateUtf8 } from './portable-slug.ts';

export const EXPORT_MARKER = '.gbrain-export-status';
export const EXPORT_PAYLOAD_LIMIT = 32 * 1024 * 1024;
export const EXPORT_STAGE_LIMIT = 8 * 1024 * 1024 * 1024;
export const EXPORT_SNAPSHOT_MS = 10 * 60 * 1000;
/** Snapshot time each byte of a streamed (segmented) page adds: 1 MiB/s, well under the measured read rate. */
export const EXPORT_STREAM_BYTES_PER_MS = 1024 * 1024 / 1000;
/** Free space a streamed stage file must leave on the staging filesystem. */
export const EXPORT_STAGE_FREE_RESERVE = 512 * 1024 * 1024;

/**
 * @internal Work addStream does, for the export memory tests: streamed files staged (`files`), pieces and bytes
 * written, and the largest piece (the most page bytes the stream handed over at once). Counts, not time.
 */
export const exportStreamWork = { files: 0, pieces: 0, bytes: 0, largestPiece: 0 };

/** A page's payload limit: the page ceiling plus the metadata headroom the 32 MiB limit gives a 24 MiB page. */
export function exportPayloadLimit(maxBytes: number): number {
  return Math.max(maxBytes, PAGE_MAX_BYTES) + EXPORT_PAYLOAD_LIMIT - PAGE_MAX_BYTES;
}

/** A character no exported file name may hold. */
const UNSAFE_NAME_CHAR = /[\\\x00-\x1f\x7f:<>"|?*]|[\uD800-\uDFFF]/u;

function unsafeExportPart(part: string): boolean {
  return !part || part === '.' || part === '..' || UNSAFE_NAME_CHAR.test(part) || /[. ]$/.test(part)
    || RESERVED_DEVICE_NAME.test(part) || Buffer.byteLength(part) > FILE_NAME_MAX_BYTES;
}

export function exportPathKey(path: string): string {
  const parts = path.split('/');
  if (Buffer.byteLength(path) > 4096 || parts.length > 256 || parts.some(unsafeExportPart)) {
    throw new Error('Unsafe export path. Correct the stored slug before exporting.');
  }
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

export interface ExportPagePath {
  /** The page's file, relative to the export root. */
  path: string;
  /** Its raw-data sidecar (`<dirs>/.raw/<leaf>.json`). */
  rawPath: string;
  /** True when a part was escaped: the file is not `<slug>.md`, and the page's `slug:` stamp names its slug. */
  escaped: boolean;
  /** False when a part was too long and was shortened: import refuses the file until the page moves to a shorter slug. */
  restorable: boolean;
}

/**
 * Where export writes a page: `<slug>.md` when every part is a portable file
 * name. A part an older gbrain admitted that is not (GBRA-130 B-5) is escaped
 * so the importer still derives the stored slug from the path (import-file.ts
 * accepts a stamped slug whose slugified form is the path's): a `:` or any
 * other character no file name may hold becomes `~`, and a reserved device
 * name or a trailing dot or space gets a `~` after it; slugifyPath drops
 * `~`. A part over the file-name budget (with its `.md`, or `.json` when the
 * page has raw data) is cut and suffixed with a hash of the slug: that file
 * keeps the slug in its stamp, but is not restorable.
 */
export function exportPagePath(slug: string, hasRaw: boolean): ExportPagePath {
  const parts = slug.split('/');
  let escaped = false;
  let restorable = true;
  const names = parts.map((part, i) => {
    const leaf = i === parts.length - 1;
    const extensions = leaf ? (hasRaw ? ['.md', '.json'] : ['.md']) : [''];
    if (extensions.every(ext => !unsafeExportPart(part + ext))) return part;
    escaped = true;
    let name = part.replace(new RegExp(UNSAFE_NAME_CHAR.source, 'gu'), '~').replace(RESERVED_DEVICE_NAME, '$1~');
    if (/[. ]$/.test(name)) name += '~';
    const budget = FILE_NAME_MAX_BYTES - Math.max(...extensions.map(ext => Buffer.byteLength(ext)));
    if (Buffer.byteLength(name) > budget) {
      restorable = false;
      name = `${truncateUtf8(name, budget - 9)}~${createHash('sha256').update(slug).digest('hex').slice(0, 8)}`;
    }
    return name;
  });
  const leaf = names.pop()!;
  return { path: [...names, leaf + '.md'].join('/'), rawPath: [...names, '.raw', leaf + '.json'].join('/'), escaped, restorable };
}

/** A staged path whose key another staged path already holds (case, Unicode, page/sidecar or file-prefix aliases). */
export class ExportPathCollision extends Error {
  constructor(readonly path: string, readonly prior: string) {
    super('Export path collision (including case, Unicode, page/sidecar or file-prefix aliases). Nothing was published. Export one source at a time with --source <id> into separate fresh directories.');
  }
}

export class ExportStage {
  readonly directory = mkdtempSync(join(tmpdir(), 'gbrain-export-'));
  readonly db = new Database(join(this.directory, 'manifest.sqlite'));
  bytes = 0;
  /** Bytes of streamed stage files, bounded by the staging filesystem's free space rather than the SQLite stage. */
  fileBytes = 0;
  pages = 0;
  private files = 0;

  constructor() {
    this.db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-4096; PRAGMA max_page_count=2097152; CREATE TABLE paths (key TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB, file TEXT)');
    this.add(EXPORT_MARKER, 'marker');
  }

  add(path: string, kind: 'file' | 'directory' | 'marker', payload?: string): void {
    exportPathKey(path);
    const size = payload === undefined ? 0 : Buffer.byteLength(payload);
    if (size > EXPORT_PAYLOAD_LIMIT || this.bytes + size > EXPORT_STAGE_LIMIT) throw stageCapacityError();
    this.plan(path, kind, payload ?? null, null);
    this.bytes += size;
  }

  /**
   * Stage a file written piece by piece to its own file in the stage directory (published by path), so no payload is
   * held whole. `expectedBytes` must fit the staging filesystem with EXPORT_STAGE_FREE_RESERVE to spare; the written
   * bytes must stay within `limit`.
   */
  async addStream(path: string, expectedBytes: number, limit: number, pieces: AsyncIterable<Uint8Array | string>): Promise<void> {
    exportPathKey(path);
    const free = statfsSync(this.directory);
    if (expectedBytes > limit || expectedBytes + EXPORT_STAGE_FREE_RESERVE > Number(free.bavail) * Number(free.bsize)) throw stageCapacityError();
    const name = String(this.files++);
    this.plan(path, 'file', null, name);
    mkdirSync(join(this.directory, 'files'), { recursive: true });
    const fd = openSync(join(this.directory, 'files', name), 'wx', 0o600);
    let size = 0;
    exportStreamWork.files++;
    try {
      for await (const piece of pieces) {
        const bytes = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece;
        exportStreamWork.pieces++;
        exportStreamWork.bytes += bytes.length;
        exportStreamWork.largestPiece = Math.max(exportStreamWork.largestPiece, bytes.length);
        size += bytes.length;
        if (size > limit) throw stageCapacityError();
        for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
      }
    } finally { closeSync(fd); }
    this.fileBytes += size;
  }

  /** The stage file of a path staged by addStream. */
  filePath(name: string): string {
    return join(this.directory, 'files', name);
  }

  private plan(path: string, kind: 'file' | 'directory' | 'marker', payload: string | null, file: string | null): void {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const current = parts.slice(0, i).join('/');
      const currentKind = i === parts.length ? kind : 'directory';
      const key = exportPathKey(current);
      const prior = this.db.query<{ path: string; kind: string }, [string]>('SELECT path, kind FROM paths WHERE key=?').get(key);
      if (prior) {
        if (prior.kind === 'directory' && currentKind === 'directory' && prior.path === current) continue;
        throw new ExportPathCollision(current, prior.path);
      }
      this.db.query('INSERT INTO paths VALUES (?, ?, ?, ?, ?)').run(key, current, currentKind, i === parts.length ? payload : null, i === parts.length ? file : null);
    }
  }

  close(): void {
    this.db.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

function stageCapacityError(): Error {
  return new Error('Export staging capacity exceeded; nothing was published. Use --source, --type or --slug-prefix to select a smaller snapshot.');
}
