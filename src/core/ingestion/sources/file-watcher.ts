/**
 * FileWatcherSource — chokidar-based ingestion source for the brain repo.
 *
 * Replaces the v0.37 autopilot's 300s poll loop. When the user (or an
 * editor, or a git pull, or rsync) writes a markdown file inside the
 * brain repo, this source emits an IngestionEvent within ~1s of the write
 * settling. The daemon dedups overlapping events with the inbox-folder
 * source via the 24h content-hash window.
 *
 * Cross-platform via chokidar (macOS FSEvents, Linux inotify, Windows
 * ReadDirectoryChangesW). v4 uses native fs.watch by default. Pinned
 * version: ^4.0.3 in package.json — bumps require re-validating the
 * `add` / `change` / `unlink` event semantics.
 *
 * Linux scale note: chokidar inherits inotify's limits. On a 10K+ file
 * brain repo, the system `fs.inotify.max_user_watches` (default 8192 on
 * many distros) is the bottleneck. `gbrain doctor`'s inotify_limit
 * probe surfaces this with a paste-ready sysctl hint — see E3 in the
 * eng review plan.
 *
 * Design constraints:
 *
 *   - Atomic writes (editor's .swp → rename) emit ONE event on the final
 *     path, not two intermediate events. chokidar's awaitWriteFinish
 *     handles this for us.
 *
 *   - Symlinks are NOT followed (security: a symlink into the brain repo
 *     could let a misbehaving source ingest arbitrary filesystem paths).
 *     Hard-coded `followSymlinks: false`.
 *
 *   - Honors pruneDir from src/core/sync.ts so the file-watcher and the
 *     sync command agree on what counts as "in the brain." Single source
 *     of truth for excluded directories.
 *
 *   - Markdown only by default. Sources for image/audio/PDF assets are
 *     separate skillpacks; this source emits text/markdown events for
 *     `.md` and `.markdown` files only.
 *
 *   - 1s debounce coalesces editor save-storms (vim's "save every 5s
 *     while typing", VS Code's auto-save).
 */

import { watch, type FSWatcher, type ChokidarOptions } from 'chokidar';
import { stat, readFile } from 'node:fs/promises';
import { resolve, relative, basename, dirname, sep } from 'node:path';
import {
  computeContentHash,
  type IngestionEvent,
  type IngestionSource,
  type IngestionSourceContext,
} from '../types.ts';
import { pruneDir } from '../../sync.ts';

export interface FileWatcherSourceOpts {
  /** Source instance id. Defaults to 'file-watcher'. Use distinct ids when
   *  watching multiple directories (e.g. brain + secondary mount). */
  id?: string;
  /** Directory to watch. Required; usually the resolved sync.repo_path. */
  brainDir: string;
  /** File extensions to include. Defaults to ['.md', '.markdown']. */
  includeExtensions?: string[];
  /** Debounce window in ms for coalescing rapid writes. Default 1000. */
  debounceMs?: number;
  /** chokidar awaitWriteFinish stability threshold. Default 1000. */
  awaitStabilityMs?: number;
  /** Test seam: alternative chokidar factory. */
  _watchFactory?: (paths: string, opts: ChokidarOptions) => FSWatcher;
}

const DEFAULT_INCLUDE_EXTENSIONS = ['.md', '.markdown'];

/** State per watched path: pending debounce timer + buffered event source. */
interface PendingEntry {
  timer: NodeJS.Timeout;
  /** The last seen chokidar event for this path — drives the IngestionEvent
   *  we eventually emit (add vs change handled identically; unlink is
   *  separate; the daemon's dedup catches replays). */
  eventName: 'add' | 'change';
}

export function createFileWatcherSource(opts: FileWatcherSourceOpts): IngestionSource {
  if (!opts.brainDir || typeof opts.brainDir !== 'string') {
    throw new Error('FileWatcherSource: brainDir is required (typically sync.repo_path)');
  }
  const id = opts.id ?? 'file-watcher';
  const kind = 'file-watcher';
  const includeExtensions = (opts.includeExtensions ?? DEFAULT_INCLUDE_EXTENSIONS).map((e) =>
    e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
  );
  const debounceMs = opts.debounceMs ?? 1000;
  const awaitStabilityMs = opts.awaitStabilityMs ?? 1000;
  const brainDirAbs = resolve(opts.brainDir);

  let watcher: FSWatcher | null = null;
  const pending: Map<string, PendingEntry> = new Map();

  /** Pruning function passed to chokidar. Returns true if path should be
   *  IGNORED (chokidar's convention). Pre-computed brainDir-relative path
   *  segments fed through `pruneDir`. */
  function shouldIgnore(absPath: string): boolean {
    // Files outside the brain dir shouldn't exist in events from chokidar
    // (we passed brainDirAbs as the watch root), but defensive guard.
    if (!absPath.startsWith(brainDirAbs)) return true;
    const rel = relative(brainDirAbs, absPath);
    if (!rel) return false; // the brainDir itself
    const segments = rel.split(sep);
    // pruneDir says false = exclude. We check every intermediate segment.
    // The leaf can be a filename, so we only apply pruneDir to directory
    // segments — chokidar gives us files AND directories in this callback,
    // so the most general check is: any segment that pruneDir vetoes
    // means the whole path is excluded.
    for (const seg of segments) {
      if (!pruneDir(seg)) return true;
    }
    return false;
  }

  /** Filter for whether to emit on a given path's extension. */
  function isIncludedFile(absPath: string): boolean {
    const name = basename(absPath).toLowerCase();
    return includeExtensions.some((ext) => name.endsWith(ext));
  }

  function flushPending(absPath: string, ctx: IngestionSourceContext): void {
    const entry = pending.get(absPath);
    if (!entry) return;
    pending.delete(absPath);
    // Read the file at flush time so we capture the post-debounce content.
    // Read failures (file deleted between debounce-fire and read) become
    // silent skips — chokidar will fire 'unlink' separately.
    readFile(absPath, 'utf8').then(
      (content) => {
        const nowIso = new Date().toISOString();
        const ev: IngestionEvent = {
          source_id: id,
          source_kind: kind,
          source_uri: absPath,
          received_at: nowIso,
          content_type: 'text/markdown',
          content,
          content_hash: computeContentHash(content),
          metadata: {
            event: entry.eventName,
            extension: includeExtensions.find((e) => absPath.toLowerCase().endsWith(e)) ?? '',
          },
        };
        ctx.emit(ev);
      },
      (err: unknown) => {
        ctx.logger.warn(
          `file-watcher: failed to read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  }

  function scheduleFlush(absPath: string, eventName: 'add' | 'change', ctx: IngestionSourceContext): void {
    const existing = pending.get(absPath);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => flushPending(absPath, ctx), debounceMs);
    // Don't keep the process alive solely because of a pending flush.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref!();
    }
    pending.set(absPath, { timer, eventName });
  }

  return {
    id,
    kind,
    async start(ctx: IngestionSourceContext): Promise<void> {
      const stats = await stat(brainDirAbs).catch(() => null);
      if (!stats || !stats.isDirectory()) {
        throw new Error(
          `file-watcher: brainDir does not exist or is not a directory: ${brainDirAbs}`,
        );
      }

      const factory = opts._watchFactory ?? watch;
      const chokidarOpts: ChokidarOptions = {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        // ignored: function matcher. chokidar v4 calls this for each path
        // candidate during walking. Wrapping pruneDir gives us the
        // single-source-of-truth invariant from src/core/sync.ts.
        ignored: (p: string) => shouldIgnore(p),
        // awaitWriteFinish coalesces atomic writes (vim's .swp → rename
        // sequence, IDEs that write-then-rename) into a single 'change'
        // event on the final path.
        awaitWriteFinish: {
          stabilityThreshold: awaitStabilityMs,
          pollInterval: 100,
        },
      };

      const w = factory(brainDirAbs, chokidarOpts);
      watcher = w;

      // Error events are not fatal — log and continue. chokidar surfaces
      // platform issues (EBUSY on Windows, EACCES on locked files, ENOSPC
      // when inotify limit is exhausted on Linux) via this channel.
      w.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`file-watcher: chokidar error: ${msg}`);
        // Surface inotify exhaustion in particular — it's the most common
        // operational footgun on Linux at scale. Doctor's inotify probe
        // catches the static case; this is the runtime detection.
        if (msg.includes('ENOSPC')) {
          ctx.logger.error(
            `file-watcher: inotify watch limit exceeded. Raise the kernel limit: ` +
              `sudo sysctl fs.inotify.max_user_watches=524288 ` +
              `(persist by adding to /etc/sysctl.conf)`,
          );
        }
      });

      w.on('add', (path: string) => {
        if (!isIncludedFile(path)) return;
        scheduleFlush(path, 'add', ctx);
      });
      w.on('change', (path: string) => {
        if (!isIncludedFile(path)) return;
        scheduleFlush(path, 'change', ctx);
      });
      // Unlink events: we don't emit IngestionEvents for deletions in v1.
      // The reconcile-on-sync path handles tombstones via the broader sync
      // command — that's the canonical write-side delete signal. The daemon
      // is for additive ingestion.

      // Cooperate with daemon shutdown.
      ctx.abortSignal.addEventListener('abort', () => {
        // Stop processing pending flushes — they may never settle if the
        // daemon is shutting down.
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
        }
        pending.clear();
      });

      // chokidar fires 'ready' once the initial scan is complete. Resolve
      // start() at that point so the daemon supervisor knows we're live.
      await new Promise<void>((resolveReady, rejectReady) => {
        let settled = false;
        w.once('ready', () => {
          if (settled) return;
          settled = true;
          ctx.logger.info(`file-watcher: ready, watching ${brainDirAbs}`);
          resolveReady();
        });
        w.once('error', (err: unknown) => {
          if (settled) return;
          settled = true;
          rejectReady(err instanceof Error ? err : new Error(String(err)));
        });
        // Safety timeout: a 30K-file brain on slow disks could take a while,
        // but if 60s passes without 'ready', something is wrong. Reject so
        // the supervisor can apply backoff.
        const safetyTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          rejectReady(new Error(`file-watcher: chokidar did not emit 'ready' within 60s for ${brainDirAbs}`));
        }, 60_000);
        if (typeof (safetyTimer as { unref?: () => void }).unref === 'function') {
          (safetyTimer as { unref?: () => void }).unref!();
        }
      });
    },

    async stop(): Promise<void> {
      // Flush nothing — pending writes are dropped on shutdown. The next
      // daemon startup will rescan and emit any markdown that was changed
      // (chokidar's ignoreInitial: true means rescans don't re-emit; but
      // file changes after the last sync's content_hash diff will appear
      // via the v0.37 sync command before the daemon takes over).
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
      }
      pending.clear();
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },

    async healthCheck() {
      if (!watcher) {
        return { status: 'fail', message: 'watcher not initialized' };
      }
      // chokidar exposes getWatched() which returns the directories under
      // watch. An empty map means inotify is exhausted or the brain dir
      // disappeared — surface as warn.
      const watched = watcher.getWatched();
      const totalDirs = Object.keys(watched).length;
      if (totalDirs === 0) {
        return { status: 'warn', message: 'no directories under watch' };
      }
      return { status: 'ok' };
    },
  };
}

/** For tests that want to construct events with the same shape the source
 *  emits, without spinning up chokidar. */
export const __testing = {
  DEFAULT_INCLUDE_EXTENSIONS,
};
