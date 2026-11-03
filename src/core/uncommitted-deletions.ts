/**
 * #7130: soft-deleted pages whose recorded file Git never held. Before #7130 a managed sync deleted a live page whose
 * recorded file was absent from the tree and the disk even when that file had never been committed (an agent's
 * write-through into a `.gitignore`d directory, an untracked file removed before any commit), so the tombstone may hold
 * the only copy of the page and the purge removes it for good after its retention window.
 *
 * One source is scanned on its canonical owner host only (the checkout and its `.gitignore` are read there): its
 * tombstones that still record a file, in descending page id, one bounded window at a time (at most `pathLimit` rows
 * below the `after` page id; `next_after` names the next window), whether a sync made each tombstone (`syncDeleteOrigin`:
 * its open `sync-delete-tombstone` record at the page's current `deleted_at`, or the committed `managed_sync_delete`
 * receipt that deleted it), and the Git evidence of each recorded file (`readOriginEvidence` over HEAD's history,
 * `sync-origin-evidence.ts`). A page is listed when `.gitignore` excludes its file, or when no commit holds it and it
 * is not on the disk. A path whose evidence could not be read is counted `unknown`, never listed. Purged pages have no
 * row left and are out of reach: only a backup brings them back.
 *
 * Readers: doctor `uncommitted_sync_deletions` and `gbrain repair uncommitted-deletions`.
 */
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { isOpPageSlug } from './ops/context.ts';
import { canonicalPath, sourceContext, type GhostOwner } from './ghost-pages.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import { readOriginEvidence } from './persistence/sync-origin-evidence.ts';
import { syncDeleteOrigin } from './persistence/sync-delete-tombstones.ts';

/** `deleted_by: 'sync'` when a managed sync made the current tombstone (`syncDeleteOrigin`); `other` otherwise (a hand delete, a repair, an unknown writer). */
export interface UncommittedDeletion {
  source_id: string; slug: string; page_id: number; revision: string; source_path: string;
  /** The recorded file's path relative to the Git work tree. */
  git_path: string;
  deleted_at: string;
  evidence: 'ignored' | 'never_committed';
  deleted_by: 'sync' | 'other';
}

export interface UncommittedDeletionScan {
  source_id: string;
  status: 'known' | 'unknown' | 'not_applicable';
  /** 'not_managed' | 'not_applicable' | 'not_owner_host' | 'mirror_read_only' | 'storage_unavailable' | 'not_a_git_checkout' */
  reason?: string;
  pages: UncommittedDeletion[];
  /** Tombstones recording a file read in this window. */
  tombstones: number;
  /** Tombstones whose file evidence was read. */
  checked: number;
  /** Checked tombstones whose file Git once committed: not listed. */
  committed: number;
  /** Checked tombstones whose never-committed file is on the disk again: not listed. */
  file_present: number;
  /** Checked tombstones whose evidence could not be read: not listed. */
  unknown: number;
  /** More tombstones remain below this window; `next_after` is the page id the next window starts below. */
  truncated: boolean;
  next_after?: number;
  owner?: GhostOwner;
  root?: string;
}

/** File evidence the doctor reads per run, across sources (each 500 paths cost one `git log` and one `git check-ignore`). */
export const DOCTOR_PATH_LIMIT = 2_000;
export const PURGED_NOTE = 'Pages already purged cannot be restored by this command; only a backup (pg_dump, or gbrain backup create taken before the purge) can bring them back.';

interface TombstoneRow { id: number; slug: string; source_path: string; source_uri: string | null; deleted_at: Date | string; revision: string; by_sync: boolean }

/** One window of one source's soft-deleted pages whose recorded file Git never held, below page id `after` (descending). */
export async function scanUncommittedDeletions(engine: BrainEngine, sourceId: string, opts: { pathLimit: number; after?: number }): Promise<UncommittedDeletionScan> {
  const scan: UncommittedDeletionScan = { source_id: sourceId, status: 'known', pages: [], tombstones: 0, checked: 0, committed: 0, file_present: 0, unknown: 0, truncated: false };
  if (!await managedPersistenceEnabled(engine)) return { ...scan, status: 'not_applicable', reason: 'not_managed' };
  const context = await sourceContext(engine, sourceId);
  if (!context.ok && context.status === 'not_applicable') return { ...scan, status: 'not_applicable', reason: context.reason };
  const window = Math.max(0, opts.pathLimit);
  const rows = await engine.executeRaw<TombstoneRow>(`SELECT p.id, p.slug, p.source_path, p.source_uri, p.deleted_at, p.knowledge_revision::text AS revision, ${syncDeleteOrigin('p')} AS by_sync
    FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NOT NULL AND NULLIF(btrim(p.source_path), '') IS NOT NULL AND ($2::bigint IS NULL OR p.id < $2::bigint)
    ORDER BY p.id DESC LIMIT ${window + 1}`, [sourceId, opts.after ?? null]);
  scan.truncated = rows.length > window;
  const read = rows.slice(0, window);
  if (scan.truncated && read.length) scan.next_after = Number(read[read.length - 1]!.id);
  const tombstones = read.filter(row => isOpPageSlug(row.slug));
  scan.tombstones = tombstones.length;
  if (!context.ok) return tombstones.length ? { ...scan, status: 'unknown', reason: context.reason } : scan;
  Object.assign(scan, { owner: context.owner, root: context.root });
  if (!tombstones.length) return scan;
  if (!context.gitScope) return { ...scan, status: 'not_applicable', reason: 'not_a_git_checkout' };
  const gitRoot = resolve(context.root, ...context.gitScope.map(() => '..'));
  const candidates = tombstones.flatMap(row => {
    const file = canonicalPath(context, row);
    if (file === null) return [];
    const gitPath = relative(gitRoot, file).split(sep).join('/');
    return gitPath.startsWith('../') ? [] : [{ row, file, gitPath }];
  });
  scan.checked = candidates.length;
  const evidence = candidates.length ? await readOriginEvidence(gitRoot, ['HEAD'], candidates.map(candidate => candidate.gitPath)) : new Map();
  for (const { row, file, gitPath } of candidates) {
    const found = evidence.get(gitPath) ?? 'unknown';
    if (found === 'unknown') { scan.unknown++; continue; }
    if (found === 'committed') { scan.committed++; continue; }
    if (found === 'never_committed' && existsSync(file)) { scan.file_present++; continue; }
    scan.pages.push({ source_id: sourceId, slug: row.slug, page_id: Number(row.id), revision: row.revision, source_path: row.source_path, git_path: gitPath,
      deleted_at: new Date(row.deleted_at).toISOString(), evidence: found, deleted_by: row.by_sync === true ? 'sync' : 'other' });
  }
  return scan;
}
