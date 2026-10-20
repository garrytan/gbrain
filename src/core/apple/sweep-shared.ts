/**
 * apple sweep-shared — the per-run dependency bag and the page write/delete
 * primitives every Apple sweep (contacts, calendar, mail) shares.
 *
 * This is a deliberate local copy of src/core/google/sweep-shared.ts
 * (importRendered / deletePageByRelPath / writePrivateTemp), parameterized on
 * AppleSyncDeps. Left as a copy on purpose: the Google originals are typed on
 * GoogleSyncDeps/GoogleSyncSummary (Google-only fields) and are on the hot path
 * of a shipping connector, so generalizing them would touch Google code for no
 * Google benefit. Behavior is kept identical (0600 private temp write, temp →
 * import → rename so a failed import never destroys the previously-good page,
 * containment guard on every path). A follow-up can extract a shared core once
 * both connectors have settled.
 */
import { closeSync, existsSync, fchmodSync, lstatSync, openSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import type { SyncOpts } from '../../commands/sync.ts';
import type { ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { connectorRender } from '../connectors/connector-text.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { mkdirPrivate } from '../atomic-write.ts';
import type { AppleReaders, AppleSourceConfig } from './types.ts';

export interface AppleSyncSummary {
  /** 'up_to_date'/'first_sync' are computed on the SyncResult, never here. */
  status: 'synced' | 'partial';
  added: number;
  modified: number;
  deleted: number;
  chunksCreated: number;
  embedded: number;
  pagesAffected: string[];
  failedFiles: number;
  /** Per-service counts, no content: itemsSeen[service] = items the reader returned. */
  itemsSeen: Record<string, number>;
  /**
   * Coded reasons a sweep could not finish its job (mass-delete or empty-listing refusal, mail
   * truncation). Any entry keeps the run `partial` and its freshness unstamped; the cursor state is
   * still saved because every cursor here is hash-keyed and advances only on success.
   */
  incomplete: string[];
}

export function newAppleSummary(): AppleSyncSummary {
  return {
    status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0,
    pagesAffected: [], failedFiles: 0, itemsSeen: {}, incomplete: [],
  };
}

export interface AppleSyncDeps {
  managed: ManagedConnectorSync | null;
  engine: BrainEngine;
  sourceId: string;
  cfg: AppleSourceConfig;
  opts: SyncOpts;
  readers: AppleReaders;
  log: (msg: string) => void;
  /** One forward-progress note per processed item (extends the progress-aware sync deadline). */
  tick: (note: string) => void;
  /** Wall clock, injectable so windows are deterministic in tests. */
  now: () => number;
}

export type ActivePack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;

function assertContained(dir: string, path: string): void {
  if (!isWriteTargetContained(path, dir)) {
    throw new Error(`Path escapes managed dir: "${path}"`);
  }
}

/**
 * Write a page's temp file privately: a stale `.tmp` left by a crash is
 * removed first (never followed), then the temp file is created exclusively at
 * 0600 and fchmod-ed past the umask before any byte lands. Renaming it over
 * the page makes new and rewritten pages 0600.
 */
function writePrivateTemp(tmpPath: string, markdown: string): void {
  let stale: ReturnType<typeof lstatSync> | null = null;
  try { stale = lstatSync(tmpPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stale?.isDirectory()) {
    throw new Error(`Stale temporary path ${tmpPath} is a directory; remove it and re-run the sync.`);
  }
  if (stale) unlinkSync(tmpPath);
  const buf = Buffer.from(markdown, 'utf-8');
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) throw new Error(`Short write to ${tmpPath} at offset ${off}/${buf.length}`);
      off += n;
    }
  } finally {
    closeSync(fd);
  }
}

export async function importRendered(
  deps: AppleSyncDeps,
  relPath: string,
  markdown: string,
  activePack: ActivePack,
  summary: AppleSyncSummary,
  countedSlugs: Set<string>,
  identity: Record<string, string | readonly string[]> = {},
): Promise<string> {
  // Identity fields (path, account, item ids) are checked for NUL / lone
  // surrogates and refused with an item-scoped code; prose is sanitized.
  markdown = connectorRender(markdown, { path: relPath, account: deps.cfg.account, ...identity });
  if (deps.managed) {
    const result = await deps.managed.importMarkdown(relPath, markdown);
    if (result.status === 'imported') {
      summary.pagesAffected.push(result.slug);
      summary.chunksCreated += result.chunks;
      if (!countedSlugs.has(result.slug)) {
        if (result.created) summary.added++; else summary.modified++;
        countedSlugs.add(result.slug);
      }
    }
    return result.slug;
  }
  const filePath = join(deps.cfg.dir, relPath);
  assertContained(deps.cfg.dir, filePath);
  mkdirPrivate(dirname(filePath), deps.cfg.dir);
  const before = existsSync(filePath);
  const tmpPath = `${filePath}.tmp`;
  writePrivateTemp(tmpPath, markdown);
  try {
    const { importFile } = await import('../import-file.ts');
    const result = await importFile(deps.engine, tmpPath, relPath, {
      noEmbed: true, // embeds handled by the size gate in the runner, like sync
      sourceId: deps.sourceId,
      ...(activePack ? { activePack } : {}),
    });
    if (result.status === 'error' || result.error) {
      throw new Error(result.error ?? `Import failed for ${relPath}`);
    }
    renameSync(tmpPath, filePath);
    if (result.status === 'imported') {
      summary.pagesAffected.push(result.slug);
      summary.chunksCreated += result.chunks;
      if (!countedSlugs.has(result.slug)) {
        if (before) summary.modified++;
        else summary.added++;
        countedSlugs.add(result.slug);
      }
    }
    return result.slug;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

export async function deletePageByRelPath(
  deps: AppleSyncDeps,
  relPath: string,
  summary: AppleSyncSummary,
): Promise<void> {
  const rows = await deps.engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL`,
    [deps.sourceId, relPath],
  );
  if (deps.managed) {
    for (const row of rows) if (await deps.managed.delete(row.slug, relPath)) summary.deleted++;
    return;
  }
  if (rows.length > 0) {
    await deps.engine.deletePages(rows.map((r) => r.slug), { sourceId: deps.sourceId });
    summary.deleted += rows.length;
  }
  // Same containment guard as the write path: a hostile/corrupt DB path
  // carrying `../` must never unlink outside the managed dir.
  const target = join(deps.cfg.dir, relPath);
  if (isWriteTargetContained(target, deps.cfg.dir)) rmSync(target, { force: true });
}

// ── Owned-page index ─────────────────────────────────────────────────────────

export interface OwnedPage {
  sourcePath: string;
  frontmatter: Record<string, unknown>;
}

function parseFrontmatter(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const v: unknown = JSON.parse(raw);
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch { return {}; }
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Every live page of this source that carries the connector-ownership marker
 * `markerKey` (`apple_event_id` | `apple_contact_id` | `apple_thread_id`).
 * Ownership is keyed on the marker, never on the path alone.
 */
export async function loadOwnedPages(
  deps: Pick<AppleSyncDeps, 'engine' | 'sourceId'>,
  markerKey: 'apple_event_id' | 'apple_contact_id' | 'apple_thread_id',
): Promise<OwnedPage[]> {
  const rows = await deps.engine.executeRaw<{ source_path: string | null; frontmatter: unknown }>(
    `SELECT source_path, frontmatter FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'${markerKey}' IS NOT NULL`,
    [deps.sourceId],
  );
  const out: OwnedPage[] = [];
  for (const r of rows) {
    if (!r.source_path) continue;
    out.push({ sourcePath: r.source_path, frontmatter: parseFrontmatter(r.frontmatter) });
  }
  return out;
}

/**
 * Every live `source_path` of this source under `prefix` (e.g. `people/`), for
 * hand-authored-page detection. A superset is harmless: callers only test
 * exact membership.
 */
export async function loadLivePaths(deps: Pick<AppleSyncDeps, 'engine' | 'sourceId'>, prefix: string): Promise<Set<string>> {
  const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await deps.engine.executeRaw<{ source_path: string | null }>(
    `SELECT source_path FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND source_path LIKE $2`,
    [deps.sourceId, like],
  );
  return new Set(rows.flatMap((r) => (r.source_path ? [r.source_path] : [])));
}
