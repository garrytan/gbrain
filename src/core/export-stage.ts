import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EXPORT_MARKER = '.gbrain-export-status';
export const EXPORT_PAYLOAD_LIMIT = 32 * 1024 * 1024;
export const EXPORT_STAGE_LIMIT = 8 * 1024 * 1024 * 1024;
export const EXPORT_SNAPSHOT_MS = 10 * 60 * 1000;

export function exportPathKey(path: string): string {
  const parts = path.split('/');
  if (Buffer.byteLength(path) > 4096 || parts.length > 256 || parts.some(part => !part || part === '.' || part === '..'
    || /[\\\x00-\x1f\x7f:<>"|?*]/.test(part) || /[\uD800-\uDFFF]/u.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) || Buffer.byteLength(part) > 240)) {
    throw new Error('Unsafe export path. Correct the stored slug before exporting.');
  }
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

export class ExportStage {
  readonly directory = mkdtempSync(join(tmpdir(), 'gbrain-export-'));
  readonly db = new Database(join(this.directory, 'manifest.sqlite'));
  bytes = 0;
  pages = 0;

  constructor() {
    this.db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-4096; PRAGMA max_page_count=2097152; CREATE TABLE paths (key TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB)');
    this.add(EXPORT_MARKER, 'marker');
  }

  add(path: string, kind: 'file' | 'directory' | 'marker', payload?: string): void {
    exportPathKey(path);
    const parts = path.split('/');
    const size = payload === undefined ? 0 : Buffer.byteLength(payload);
    if (size > EXPORT_PAYLOAD_LIMIT || this.bytes + size > EXPORT_STAGE_LIMIT) {
      throw new Error('Export staging capacity exceeded; nothing was published. Use --source, --type or --slug-prefix to select a smaller snapshot.');
    }
    for (let i = 1; i <= parts.length; i++) {
      const current = parts.slice(0, i).join('/');
      const currentKind = i === parts.length ? kind : 'directory';
      const key = exportPathKey(current);
      const prior = this.db.query<{ path: string; kind: string }, [string]>('SELECT path, kind FROM paths WHERE key=?').get(key);
      if (prior) {
        if (prior.kind === 'directory' && currentKind === 'directory' && prior.path === current) continue;
        throw new Error('Export path collision (including case, Unicode, page/sidecar or file-prefix aliases). Nothing was published. Export one source at a time with --source <id> into separate fresh directories.');
      }
      this.db.query('INSERT INTO paths VALUES (?, ?, ?, ?)').run(key, current, currentKind, i === parts.length ? payload ?? null : null);
    }
    this.bytes += size;
  }

  close(): void {
    this.db.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
