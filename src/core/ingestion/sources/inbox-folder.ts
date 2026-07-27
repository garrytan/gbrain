/**
 * InboxFolderSource — drop-in capture target for Shortcuts / AirDrop / Drafts.
 *
 * Watches `~/.gbrain/inbox/` by default. When a file appears (anyone can
 * drop one — iOS Shortcuts share-extension, macOS AirDrop, Drafts export,
 * Finder drag), the source emits an IngestionEvent then moves the file to
 * `~/.gbrain/inbox/.archived/YYYY-MM-DD/<filename>` so the user has a
 * visible audit trail of what was captured AND the inbox dir stays
 * uncluttered.
 *
 * This is the magical-moment ingestion path for mobile capture without
 * building a mobile app: any iOS Shortcut that writes to your synced
 * iCloud folder pointed at the brain's inbox lands as a brain page within
 * seconds.
 *
 * Design constraints:
 *
 *   - Symlinks are NOT followed at the dir level (chokidar followSymlinks
 *     false). Per-file symlink rejection at emit time is layered defense
 *     against a user dragging a symlink in directly.
 *
 *   - World-writable inbox dir warning at startup. The inbox accepts ANY
 *     file from ANY local process; if the dir is world-writable then any
 *     unprivileged process on the host can plant content. Warn loud so
 *     the user can tighten permissions.
 *
 *   - Archive dir is local-only — no DB write. The IngestionEvent flowing
 *     through put_page is the canonical brain record; the archive copy is
 *     just for the user's "did this get captured?" audit.
 *
 *   - Content-type detection by extension. Most drops will be `.md` or
 *     `.txt`; PDFs and images route to the appropriate content processor
 *     in the daemon's dispatch pipeline (E2 hybrid model — a wave-3
 *     concern, the inbox source just labels the event).
 *
 *   - One event per file, even on directory drops. chokidar fires `add`
 *     per file as it walks the new directory; we don't have to do
 *     anything special.
 */

import { watch, type FSWatcher, type ChokidarOptions } from 'chokidar';
import { mkdir, rename, readFile, stat, lstat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, basename, join, dirname, extname } from 'node:path';
import {
  computeContentHash,
  type IngestionContentType,
  type IngestionEvent,
  type IngestionSource,
  type IngestionSourceContext,
} from '../types.ts';

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_STABILITY_MS = 1000;

export interface InboxFolderSourceOpts {
  /** Source instance id. Defaults to 'inbox-folder'. */
  id?: string;
  /** Inbox directory to watch. Required. Typical: ~/.gbrain/inbox/. */
  inboxDir: string;
  /** Archive subdir name (relative to inbox). Default '.archived'. */
  archiveSubdir?: string;
  /** Set to false to skip the post-emit archive move (debugging only). */
  archiveAfterEmit?: boolean;
  /** chokidar awaitWriteFinish stability threshold. Default 1000. */
  awaitStabilityMs?: number;
  /** Debounce between identical-path events. Default 500. */
  debounceMs?: number;
  /** Test seam. */
  _watchFactory?: (paths: string, opts: ChokidarOptions) => FSWatcher;
}

/** Map extension → content_type. Unknown extensions become 'unknown' and
 *  pass through unchanged; the put_page handler treats them as opaque. */
function detectContentType(filename: string): IngestionContentType {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.gif':
    case '.bmp':
    case '.tiff':
      return 'image/*';
    case '.mp3':
    case '.m4a':
    case '.wav':
    case '.ogg':
    case '.flac':
      return 'audio/*';
    case '.mp4':
    case '.mov':
    case '.webm':
    case '.mkv':
      return 'video/*';
    default:
      return 'unknown';
  }
}

/** Format a UTC date as YYYY-MM-DD for the archive subdir. */
function archiveDateFolder(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Try to acquire a unique destination path in the archive dir. If the
 * filename already exists (two captures of the same name on the same
 * day), suffix with `-1`, `-2`, ... before the extension.
 */
function uniqueArchivePath(dir: string, filename: string): string {
  const candidate = join(dir, filename);
  if (!existsSync(candidate)) return candidate;
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const next = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(next)) return next;
  }
  // Last-resort: timestamp suffix.
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

export function createInboxFolderSource(opts: InboxFolderSourceOpts): IngestionSource {
  if (!opts.inboxDir || typeof opts.inboxDir !== 'string') {
    throw new Error('InboxFolderSource: inboxDir is required (typical: ~/.gbrain/inbox)');
  }
  const id = opts.id ?? 'inbox-folder';
  const kind = 'inbox-folder';
  const inboxDirAbs = resolve(opts.inboxDir);
  const archiveSubdir = opts.archiveSubdir ?? '.archived';
  const archiveDirAbs = join(inboxDirAbs, archiveSubdir);
  const archiveAfterEmit = opts.archiveAfterEmit ?? true;
  const awaitStabilityMs = opts.awaitStabilityMs ?? DEFAULT_STABILITY_MS;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let watcher: FSWatcher | null = null;
  /** Per-path debounce timers. Coalesces rapid create+rename events from
   *  Finder copy operations. */
  const pending: Map<string, NodeJS.Timeout> = new Map();

  function isUnderArchive(absPath: string): boolean {
    return absPath.startsWith(archiveDirAbs + '/') || absPath === archiveDirAbs;
  }

  async function handleAdd(absPath: string, ctx: IngestionSourceContext): Promise<void> {
    // Layered defense against the file becoming a symlink between
    // chokidar discovery and our read. chokidar's followSymlinks=false
    // already filters at the dir level.
    let info;
    try {
      info = await lstat(absPath);
    } catch (err) {
      ctx.logger.warn(
        `inbox-folder: failed to lstat ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (info.isSymbolicLink()) {
      ctx.logger.warn(`inbox-folder: rejected symlink ${absPath} (security)`);
      return;
    }
    if (!info.isFile()) {
      // Directories and other types are ignored — we only ingest files.
      return;
    }

    const filename = basename(absPath);
    const contentType = detectContentType(filename);

    // For text-typed content we read and emit the bytes inline. For binary
    // types (image/audio/video/pdf) we emit the absolute path as the content
    // and let the daemon's processor pipeline handle extraction. Path-only
    // emit for binary keeps the daemon's hot path lean — a 200MB video
    // shouldn't be read into memory just to compute content_hash.
    const isText = contentType === 'text/markdown' || contentType === 'text/plain' ||
                   contentType === 'text/html' || contentType === 'application/json';

    let content: string;
    let contentHashSource: string;
    if (isText) {
      try {
        content = await readFile(absPath, 'utf8');
      } catch (err) {
        ctx.logger.warn(
          `inbox-folder: failed to read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      contentHashSource = content;
    } else {
      // For binary, content_hash is over the absolute path + size + mtime
      // so repeat-drops of the SAME file dedup but different files with
      // matching name (rare) get different hashes. Reading the bytes to
      // hash them would be O(file size); the path+stat shortcut is O(1).
      content = absPath;
      contentHashSource = `${absPath}|${info.size}|${info.mtimeMs}`;
    }

    const ev: IngestionEvent = {
      source_id: id,
      source_kind: kind,
      source_uri: absPath,
      received_at: new Date().toISOString(),
      content_type: contentType,
      content,
      content_hash: computeContentHash(contentHashSource),
      metadata: {
        original_filename: filename,
        size_bytes: info.size,
        is_text: isText,
      },
    };

    ctx.emit(ev);

    // Move to .archived/YYYY-MM-DD/<filename> so the user has a visible
    // record of what was captured AND the inbox stays uncluttered. Failure
    // is non-fatal — log and leave the file in place. Better to risk a
    // re-emit (caught by the daemon's 24h dedup) than to silently lose
    // the user's capture by failing the move and crashing.
    if (archiveAfterEmit) {
      try {
        const todayDir = join(archiveDirAbs, archiveDateFolder(new Date()));
        await mkdir(todayDir, { recursive: true });
        const dest = uniqueArchivePath(todayDir, filename);
        await rename(absPath, dest);
      } catch (err) {
        ctx.logger.warn(
          `inbox-folder: failed to archive ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  function scheduleHandle(absPath: string, ctx: IngestionSourceContext): void {
    const existing = pending.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(absPath);
      void handleAdd(absPath, ctx);
    }, debounceMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref!();
    }
    pending.set(absPath, timer);
  }

  return {
    id,
    kind,
    async start(ctx: IngestionSourceContext): Promise<void> {
      // Ensure the inbox dir exists. Create it if missing so the user can
      // start dropping files immediately — this is a magical-moment
      // affordance and we don't want to fail on a missing directory.
      await mkdir(inboxDirAbs, { recursive: true });
      await mkdir(archiveDirAbs, { recursive: true });

      // World-writable warning. mode & 0o002 = world-write bit set.
      try {
        const info = statSync(inboxDirAbs);
        if ((info.mode & 0o002) !== 0) {
          ctx.logger.warn(
            `inbox-folder: ${inboxDirAbs} is world-writable. Any unprivileged ` +
              `process on this host can plant content. Tighten with: ` +
              `chmod 700 ${inboxDirAbs}`,
          );
        }
      } catch (_err) {
        // stat shouldn't fail (we just mkdir'd), but defensive.
      }

      const factory = opts._watchFactory ?? watch;
      const chokidarOpts: ChokidarOptions = {
        persistent: true,
        // ignoreInitial: false — we WANT to ingest files that were
        // dropped while the daemon was offline. The 24h content-hash
        // dedup catches repeat-startup of the same file.
        ignoreInitial: false,
        followSymlinks: false,
        ignored: (p: string) => isUnderArchive(p),
        awaitWriteFinish: {
          stabilityThreshold: awaitStabilityMs,
          pollInterval: 100,
        },
      };

      const w = factory(inboxDirAbs, chokidarOpts);
      watcher = w;

      w.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`inbox-folder: chokidar error: ${msg}`);
      });

      w.on('add', (path: string) => {
        if (isUnderArchive(path)) return; // belt + suspenders
        scheduleHandle(path, ctx);
      });

      ctx.abortSignal.addEventListener('abort', () => {
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear();
      });

      await new Promise<void>((resolveReady, rejectReady) => {
        let settled = false;
        w.once('ready', () => {
          if (settled) return;
          settled = true;
          ctx.logger.info(`inbox-folder: ready, watching ${inboxDirAbs}`);
          resolveReady();
        });
        w.once('error', (err: unknown) => {
          if (settled) return;
          settled = true;
          rejectReady(err instanceof Error ? err : new Error(String(err)));
        });
        const safetyTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          rejectReady(new Error(`inbox-folder: chokidar did not emit 'ready' within 30s for ${inboxDirAbs}`));
        }, 30_000);
        if (typeof (safetyTimer as { unref?: () => void }).unref === 'function') {
          (safetyTimer as { unref?: () => void }).unref!();
        }
      });
    },

    async stop(): Promise<void> {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },

    async healthCheck() {
      if (!watcher) return { status: 'fail', message: 'watcher not initialized' };
      return { status: 'ok' };
    },
  };
}

/** For tests. */
export const __testing = {
  detectContentType,
  archiveDateFolder,
  uniqueArchivePath,
};
