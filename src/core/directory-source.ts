/** Git-less directory source: bounded mtime/size walk plus conservative reconcile. */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { BrainEngine } from './engine.ts';
import type { SyncOpts, SyncResult } from '../commands/sync.ts';
import { collectSyncableFiles } from '../commands/import.ts';
import { importFromFile } from './import-file.ts';
import { computeContentHash } from './ingestion/types.ts';
import { gbrainPath } from './config.ts';
import { matchesAnyGlob } from './sync.ts';
import { assertUnmanagedCanonicalWriter } from './persistence/maintenance.ts';

export interface DirectorySourceConfig {
  dir: string;
  exclude: string[];
}

interface WatermarkEntry { mtimeMs: number; size: number; contentHash: string }
interface Watermark { version: 1; files: Record<string, WatermarkEntry> }

export function normalizeDirectoryExclude(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return [];
  const out: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('Directory exclude patterns must be non-empty strings.');
    const p = raw.trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (p.startsWith('/') || p.split('/').includes('..')) {
      throw new Error(`Directory exclude pattern must stay relative to the source: ${JSON.stringify(raw)}`);
    }
    out.push(p.endsWith('/') ? `${p}**` : p);
  }
  return [...new Set(out)];
}

export function parseDirectorySourceConfig(raw: unknown, fallbackDir: string): DirectorySourceConfig {
  const cfg = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown>
    : (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
  const dir = typeof cfg.dir === 'string' && cfg.dir ? cfg.dir : fallbackDir;
  return { dir: resolve(dir), exclude: normalizeDirectoryExclude(cfg.exclude) };
}

function watermarkPath(sourceId: string): string {
  return gbrainPath('directory-sync', `${sourceId}.json`);
}

function loadWatermark(sourceId: string): Watermark {
  try {
    const parsed = JSON.parse(readFileSync(watermarkPath(sourceId), 'utf8')) as Watermark;
    if (parsed.version === 1 && parsed.files && typeof parsed.files === 'object') return parsed;
  } catch { /* first run or corrupt state: safely rescan */ }
  return { version: 1, files: {} };
}

function saveWatermark(sourceId: string, value: Watermark): void {
  const dest = watermarkPath(sourceId);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8');
  renameSync(tmp, dest);
}

function excluded(relPath: string, patterns: string[]): boolean {
  return matchesAnyGlob(relPath, patterns) || matchesAnyGlob(`${relPath}/`, patterns);
}

function directoryTimeoutResult(counts: {
  added: number;
  modified: number;
  deleted: number;
  chunksCreated: number;
  pagesAffected: string[];
}): SyncResult {
  return {
    status: 'partial',
    fromCommit: null,
    toCommit: '',
    added: counts.added,
    modified: counts.modified,
    deleted: counts.deleted,
    renamed: 0,
    chunksCreated: counts.chunksCreated,
    embedded: 0,
    pagesAffected: counts.pagesAffected,
    filesImported: counts.added + counts.modified,
    reason: 'timeout',
  };
}

export async function runDirectorySync(
  engine: BrainEngine,
  sourceId: string,
  cfg: DirectorySourceConfig,
  opts: SyncOpts,
): Promise<SyncResult> {
  // Managed brains enter through performSync's persistence coordinator. Keep
  // this exported legacy helper safe for direct callers as well: refusing here
  // prevents a watermark write from preceding the database writer guard.
  await assertUnmanagedCanonicalWriter(engine, 'directory source sync');
  if (!existsSync(cfg.dir) || !statSync(cfg.dir).isDirectory()) {
    throw new Error(`Directory source "${sourceId}" path is missing or not a directory: ${cfg.dir}`);
  }
  if (readdirSync(cfg.dir).length === 0) {
    throw new Error(`Directory source "${sourceId}" root is empty; refusing to reconcile: ${cfg.dir}`);
  }

  const counts = {
    added: 0,
    modified: 0,
    deleted: 0,
    chunksCreated: 0,
    pagesAffected: [] as string[],
  };
  if (opts.signal?.aborted) return directoryTimeoutResult(counts);

  const old = loadWatermark(sourceId);
  const next: Watermark = { version: 1, files: { ...old.files } };
  const walkErrors: string[] = [];
  const files = collectSyncableFiles(cfg.dir, {
    strategy: 'markdown',
    includeGitignored: true,
    exclude: cfg.exclude,
    onWalkError: (path, error) => walkErrors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`),
  });
  for (const error of walkErrors) console.warn(`[gbrain directory] Incomplete walk: ${error}`);
  if (opts.signal?.aborted) return directoryTimeoutResult(counts);
  const current = new Set<string>();
  const existingRows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
    `SELECT slug, source_path FROM pages WHERE source_id = $1 AND deleted_at IS NULL`, [sourceId],
  );
  if (opts.signal?.aborted) return directoryTimeoutResult(counts);
  const existingByPath = new Map(existingRows.filter(r => r.source_path).map(r => [r.source_path!, r.slug]));
  let failedFiles = 0;

  for (const file of files) {
    if (opts.signal?.aborted) return directoryTimeoutResult(counts);
    const rel = relative(cfg.dir, file).replaceAll('\\', '/');
    current.add(rel);
    try {
      const st = lstatSync(file);
      const prev = old.files[rel];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
      const raw = readFileSync(file, 'utf8');
      const contentHash = computeContentHash(raw);
      const watermarkEntry = { mtimeMs: st.mtimeMs, size: st.size, contentHash };
      if (prev?.contentHash === contentHash) {
        next.files[rel] = watermarkEntry;
        continue;
      }
      if (opts.dryRun) {
        if (existingByPath.has(rel)) counts.modified++; else counts.added++;
        continue;
      }
      const result = await importFromFile(engine, file, rel, {
        noEmbed: opts.noEmbed || opts.embedInline !== true,
        sourceId,
      });
      if (result.status === 'imported') {
        next.files[rel] = watermarkEntry;
        if (existingByPath.has(rel)) counts.modified++; else counts.added++;
        counts.chunksCreated += result.chunks;
        counts.pagesAffected.push(result.slug);
      } else if (result.status === 'skipped' && !result.error) {
        // The DB content hash already matches. This is a successful watermark
        // convergence step, especially on the first directory-kind run after
        // migrating an existing git-backed source in place.
        next.files[rel] = watermarkEntry;
      } else {
        failedFiles++;
        console.warn(`[gbrain directory] Failed to import ${rel}: ${result.error ?? result.status}`);
      }
      if (opts.signal?.aborted) return directoryTimeoutResult(counts);
    } catch (error) {
      failedFiles++;
      console.warn(
        `[gbrain directory] Failed to import ${rel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (opts.signal?.aborted) return directoryTimeoutResult(counts);
  if (walkErrors.length === 0) {
    const reconcilable = existingRows.filter(r => r.source_path && !excluded(r.source_path, cfg.exclude));
    const missing = reconcilable.filter(r => !current.has(r.source_path!));
    const ratio = reconcilable.length === 0 ? 0 : missing.length / reconcilable.length;
    if (ratio > 0.10 && !opts.forceReconcile) {
      throw new Error(
        `Directory reconcile refused: ${missing.length}/${reconcilable.length} pages would be deleted ` +
        `(${Math.round(ratio * 100)}%). Re-run with --force after checking the source path.`,
      );
    }
    if (!opts.dryRun && missing.length > 0) {
      const removed = await engine.softDeletePages(missing.map(r => r.slug), { sourceId });
      counts.deleted = removed.length;
      counts.pagesAffected.push(...removed);
    } else if (opts.dryRun) counts.deleted = missing.length;
    for (const rel of Object.keys(next.files)) if (!current.has(rel)) delete next.files[rel];
  }
  if (opts.signal?.aborted) return directoryTimeoutResult(counts);

  if (!opts.dryRun) {
    saveWatermark(sourceId, next);
    await engine.executeRaw(`UPDATE sources SET last_sync_at = NOW() WHERE id = $1`, [sourceId]);
    if (!opts.noEmbed && opts.embedInline !== true && counts.added + counts.modified > 0) {
      const { scheduleDeferredSyncEmbeds } = await import('./serve-sync-runner.ts');
      scheduleDeferredSyncEmbeds(engine, sourceId);
    }
    if (!opts.noExtract && counts.added + counts.modified > 0) {
      const { markDeferredExtractionPending } = await import('./serve-sync-runner.ts');
      markDeferredExtractionPending(engine, sourceId);
    }
  }

  return {
    status: opts.dryRun ? 'dry_run' : walkErrors.length || failedFiles ? 'blocked_by_failures'
      : counts.added + counts.modified + counts.deleted
        ? (Object.keys(old.files).length ? 'synced' : 'first_sync') : 'up_to_date',
    fromCommit: null,
    toCommit: '',
    added: counts.added,
    modified: counts.modified,
    deleted: counts.deleted,
    renamed: 0,
    chunksCreated: counts.chunksCreated,
    embedded: !opts.noEmbed && opts.embedInline === true ? counts.added + counts.modified : 0,
    pagesAffected: counts.pagesAffected,
    ...(failedFiles || walkErrors.length ? { failedFiles: failedFiles + walkErrors.length } : {}),
  };
}
