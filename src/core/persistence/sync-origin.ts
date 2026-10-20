import { existsSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { resolveSlugForPath } from '../sync.ts';

/** The source's position inside its Git repository and the origin form sync records. */
export interface SyncOriginScope { sourceId: string; root: string; scope: string; slugMode: 'git-root' | 'source-root'; }

export function syncOriginScope(context: { sourceId: string; root: string; gitRoot: string; slugMode: 'git-root' | 'source-root' }): SyncOriginScope {
  const scope = relative(realpathSync.native(context.gitRoot), realpathSync.native(context.root)).split(sep).join('/');
  return { sourceId: context.sourceId, root: context.root, scope, slugMode: context.slugMode };
}

/** The Git-root spelling write-through minted for a source-root origin before #5610. */
export function legacySyncOrigin(context: SyncOriginScope | undefined, origin: string): string | null {
  return context?.slugMode === 'source-root' && context.scope ? `${context.scope}/${origin}` : null;
}

/**
 * Whether a stored page origin names this sync origin. Under source-root mode a
 * stored `<scope>/<origin>` is the legacy Git-root form of `<origin>` only when
 * the page's slug is the slug of `<origin>` (write-through minted it from the
 * slug) and the source-relative reading names no real file; when both files
 * exist the stored origin is ambiguous and sync refuses instead of guessing.
 */
export function sameSyncOrigin(stored: string, origin: string, context?: SyncOriginScope, pageSlug?: string): boolean {
  const recorded = syncOriginPath(stored), expected = syncOriginPath(origin);
  const prefix = context?.slugMode === 'source-root' && context.scope ? `${context.scope}/` : null;
  if (!context || !prefix || !recorded.startsWith(prefix)) return recorded === expected;
  const stripped = recorded.slice(prefix.length);
  const legacy = pageSlug !== undefined && resolveSlugForPath(stripped) === pageSlug;
  if (recorded !== expected && (stripped !== expected || !legacy)) return false;
  if (!legacy) return true;
  const nested = existsSync(join(context.root, recorded));
  if (nested && existsSync(join(context.root, stripped))) {
    const error = new OperationError('page_identity_changed', 'A recorded page origin could name two files in this source.',
      `Source '${context.sourceId}' records '${recorded}', which can mean the file '${stripped}' or the file '${recorded}' under the source directory. `
      + `On the source host, rename or move one of those two files, commit, then run gbrain sync --source ${context.sourceId} --no-pull.`);
    error.detail = 'ambiguous_source_path';
    throw error;
  }
  return recorded === expected || !nested;
}

/** An empty, `.` or `..` segment of a `/`-separated path (a per-call test: sync validates every origin of a large level, so no split). */
const UNCONFINED_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/;

export function syncOriginPath(path: string, platform = process.platform): string {
  const normalized = platform === 'win32' ? path.replaceAll('\\', '/') : path;
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') ||
      platform === 'win32' && normalized.split('/').some(part => /[<>:"|?*]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      UNCONFINED_SEGMENT.test(normalized)) {
    throw opError('page_identity_changed', 'The stored sync origin is not a confined relative path.',
      `The stored source path ${JSON.stringify(path)} is empty, absolute, or escapes the checkout, so sync refused to use it. Inspect the source's writer status and report it to the user; the page origin must be repaired, not overwritten.`);
  }
  return normalized;
}

export function assertDistinctSyncOrigins(paths: Iterable<string>, platform = process.platform): void {
  if (platform !== 'win32') return;
  const seen = new Map<string, string>();
  for (const path of paths) {
    const normalized = syncOriginPath(path, platform), key = normalized.toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined && prior !== normalized) {
      throw opError('page_identity_changed', 'The sync origins contain ambiguous Windows path spellings.',
        `${JSON.stringify(prior)} and ${JSON.stringify(normalized)} differ only by letter case, which Windows treats as one file, so sync refused to choose. Rename one of them in the repository, commit, then sync again.`);
    }
    seen.set(key, normalized);
  }
}

/**
 * #6517: the one rule for which page an origin file identifies when several
 * pages of the source record it, used by discovery's census and by
 * `assertSyncPageOrigin` (preparation and publication), so the two guards
 * never disagree. A live page beats tombstones (a soft-deleted twin no longer
 * claims the file); several live pages are ambiguous; with no live page a
 * single tombstone may be reused (the file resurrects the page) and several
 * tombstones stay ambiguous.
 */
export function selectOriginClaimant<T extends { deleted_at: unknown }>(pages: readonly T[]): { winner: T | null; ambiguous: 'several_live' | 'several_tombstones' | null } {
  const live = pages.filter(page => page.deleted_at == null);
  if (live.length > 1) return { winner: null, ambiguous: 'several_live' };
  if (live.length === 1) return { winner: live[0]!, ambiguous: null };
  if (pages.length > 1) return { winner: null, ambiguous: 'several_tombstones' };
  return { winner: pages[0] ?? null, ambiguous: null };
}

/** The exit a shared-origin refusal names: soft-delete the page that should not own the file; the file stays for the survivor. */
export function sharedOriginExit(sourceId: string, slugs: readonly string[]): string {
  return `Soft-delete the page that should not own the file (gbrain delete <slug> --source-id ${sourceId} --expected-revision <rev>, one of ${slugs.join(', ')}): a page whose file another live page records is hidden without touching the file, which the surviving page keeps.`;
}

/** `assertSyncPageOrigin`'s read (the POSIX spelling): the source's pages recording one of the candidate origins. */
export const SYNC_ORIGIN_PAGES_SQL = 'SELECT id,slug,source_path,deleted_at FROM pages WHERE source_id=$1 AND source_path=ANY($2::text[])';

export async function assertSyncPageOrigin(engine: BrainEngine, sourceId: string, sourcePath: string, pageId: number | null, requireOrigin = false,
  context?: SyncOriginScope): Promise<void> {
  const origin = syncOriginPath(sourcePath);
  const legacy = legacySyncOrigin(context, origin);
  const candidates = [origin, ...(legacy ? [legacy] : [])];
  const key = (path: string) => process.platform === 'win32' ? syncOriginPath(path).toLowerCase() : syncOriginPath(path);
  const rows = await engine.executeRaw<{ id: number; slug: string; source_path: string; deleted_at: Date | string | null }>(process.platform === 'win32'
    ? "SELECT id,slug,source_path,deleted_at FROM pages WHERE source_id=$1 AND lower(replace(source_path,chr(92),'/'))=ANY($2::text[])" : SYNC_ORIGIN_PAGES_SQL, [sourceId, candidates.map(key)]);
  const pages = rows.filter(page => legacy === null || key(page.source_path) !== key(legacy) || sameSyncOrigin(page.source_path, origin, context, page.slug));
  const { winner, ambiguous } = selectOriginClaimant(pages);
  if (ambiguous || requireOrigin && pageId !== null && !winner ||
      winner && (winner.id !== pageId || !sameSyncOrigin(winner.source_path, origin, context, winner.slug))) {
    throw opError('page_identity_changed', 'The imported origin no longer identifies exactly the accepted page.',
      `${JSON.stringify(sourcePath)} in source ${sourceId} now maps to a different page or to several pages, so this import was refused. `
      + (ambiguous === 'several_live' ? sharedOriginExit(sourceId, pages.filter(page => page.deleted_at == null).map(page => page.slug)) + ' Then sync again.'
        : "Check the source's writer status before syncing again; do not force the import."),
      { fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', why: `Shows source ${sourceId}'s writer and pending requests, read-only.`, requires_exclusive: false } });
  }
}
