/**
 * sweep-shared — the per-run dependency bag and the page write/delete
 * primitives every Google sweep (contacts, calendar, Gmail) shares. Peeled
 * from google-source.ts so the sweeps can live in their own modules.
 */
import { closeSync, existsSync, fchmodSync, lstatSync, openSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import type { SyncOpts } from '../../commands/sync.ts';
import type { CredentialEntry } from '../creds/vault.ts';
import type { ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { connectorRender } from '../connectors/connector-text.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { mkdirPrivate } from '../atomic-write.ts';
import type { GoogleSourceConfig, GoogleSourceState } from './types.ts';

/** The "my addresses" identity set: account + Gmail sendAs aliases. */
export function myAddressSet(entry: CredentialEntry): Set<string> {
  const out = new Set<string>();
  if (entry.meta.account) out.add(entry.meta.account.toLowerCase());
  for (const a of entry.meta.sendas_aliases ?? []) out.add(a.toLowerCase());
  return out;
}

export interface GoogleSyncSummary {
  /** 'up_to_date'/'first_sync' are computed on the SyncResult, never here. */
  status: 'synced' | 'partial';
  added: number;
  modified: number;
  deleted: number;
  chunksCreated: number;
  embedded: number;
  pagesAffected: string[];
  threadsSeen: number;
  attachmentInspection: Record<string, number>;
  /**
   * Why each in-window thread was or was not sent to the extractor, keyed by
   * the machine reason from loopExtractionEligibility. Counts only — no
   * addresses, subjects or body text — so a sweep can be audited for
   * over-filtering without leaking mail content into logs.
   */
  extractEligibility: Record<string, number>;
  failedFiles: number;
}

export interface GoogleSyncDeps {
  managed: ManagedConnectorSync | null;
  engine: BrainEngine;
  sourceId: string;
  cfg: GoogleSourceConfig;
  opts: SyncOpts;
  entry: CredentialEntry;
  log: (msg: string) => void;
  /**
   * #5349: one forward-progress note per imported item. The progress-aware
   * sync deadline extends only on these (heartbeats are not progress), so a
   * long first contacts or calendar sweep that is still landing pages is not
   * killed at the hard deadline.
   */
  tick: (note: string) => void;
  /** Threads whose newest message falls in the recent window — LLM
   *  extraction candidates, enqueued (capped) after the sweep. */
  extractCandidates: Array<{ slug: string; threadId: string; newestMs: number }>;
  /** #5868: the run's state (grace holds are recorded on it) and the threads detection ran on. */
  loopState?: GoogleSourceState;
  processedThreads: Set<string>;
  graceBackfillSeeded?: boolean;
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
  deps: GoogleSyncDeps,
  relPath: string,
  markdown: string,
  activePack: ActivePack,
  summary: GoogleSyncSummary,
  countedSlugs: Set<string>,
  identity: Record<string, string | readonly string[]> = {},
): Promise<string> {
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
  // Temp-write → import → rename: a failed import never destroys the
  // previously-good page (github-source pattern).
  const tmpPath = `${filePath}.tmp`;
  writePrivateTemp(tmpPath, markdown);
  try {
    const { importFile } = await import('../import-file.ts');
    const result = await importFile(deps.engine, tmpPath, relPath, {
      noEmbed: true, // embeds handled by the size gate below, like sync
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
  deps: GoogleSyncDeps,
  relPath: string,
  summary: GoogleSyncSummary,
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
