import { existsSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
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
      + `On the source host, rename or move one of those two files, commit, then run gbrain sync --source ${context.sourceId} --no-pull --retry-failed.`);
    error.detail = 'ambiguous_source_path';
    throw error;
  }
  return recorded === expected || !nested;
}

export function syncOriginPath(path: string, platform = process.platform): string {
  const normalized = platform === 'win32' ? path.replaceAll('\\', '/') : path;
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') ||
      platform === 'win32' && normalized.split('/').some(part => /[<>:"|?*]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new OperationError('page_identity_changed', 'The stored sync origin is not a confined relative path.');
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
      throw new OperationError('page_identity_changed', 'The sync origins contain ambiguous Windows path spellings.');
    }
    seen.set(key, normalized);
  }
}

export async function assertSyncPageOrigin(engine: BrainEngine, sourceId: string, sourcePath: string, pageId: number | null, requireOrigin = false,
  context?: SyncOriginScope): Promise<void> {
  const origin = syncOriginPath(sourcePath);
  const legacy = legacySyncOrigin(context, origin);
  const candidates = [origin, ...(legacy ? [legacy] : [])];
  const pathSql = process.platform === 'win32' ? "lower(replace(source_path,chr(92),'/'))=ANY($2::text[])" : 'source_path=ANY($2::text[])';
  const key = (path: string) => process.platform === 'win32' ? syncOriginPath(path).toLowerCase() : syncOriginPath(path);
  const rows = await engine.executeRaw<{ id: number; slug: string; source_path: string }>(
    `SELECT id,slug,source_path FROM pages WHERE source_id=$1 AND ${pathSql}`, [sourceId, candidates.map(key)]);
  const pages = rows.filter(page => legacy === null || key(page.source_path) !== key(legacy) || sameSyncOrigin(page.source_path, origin, context, page.slug));
  if (pages.length > 1 || requireOrigin && pageId !== null && pages.length !== 1 ||
      pages.some(page => page.id !== pageId || !sameSyncOrigin(page.source_path, origin, context, page.slug))) {
    throw new OperationError('page_identity_changed', 'The imported origin no longer identifies exactly the accepted page.');
  }
}
