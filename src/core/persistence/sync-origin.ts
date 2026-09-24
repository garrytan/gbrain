import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';

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

export async function assertSyncPageOrigin(engine: BrainEngine, sourceId: string, sourcePath: string, pageId: number | null, requireOrigin = false): Promise<void> {
  const origin = syncOriginPath(sourcePath);
  const pathSql = process.platform === 'win32' ? "lower(replace(source_path,chr(92),'/'))=lower($2)" : 'source_path=$2';
  const pages = await engine.executeRaw<{ id: number; source_path: string }>(
    `SELECT id,source_path FROM pages WHERE source_id=$1 AND ${pathSql}`, [sourceId, origin]);
  if (pages.length > 1 || requireOrigin && pageId !== null && pages.length !== 1 ||
      pages.some(page => page.id !== pageId || syncOriginPath(page.source_path) !== origin)) {
    throw new OperationError('page_identity_changed', 'The imported origin no longer identifies exactly the accepted page.');
  }
}
