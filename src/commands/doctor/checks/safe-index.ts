/**
 * safe_index_pending doctor check (#5050, #5247): pages chunked before the
 * safe-chunk fence, whose chunks remote/MCP search withholds until they are
 * re-sealed. Counts the pages `gbrain repair safe-chunks` can re-seal and,
 * separately, the ones it keeps (code without a source path, image pages).
 * One indexed aggregate; counts are exact.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../../core/search/safe-chunks.ts';

export async function safeIndexPendingCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'safe_index_pending';
  try {
    const [row] = await engine.executeRaw<{ rebuildable: number; kept: number }>(`SELECT
        COUNT(*) FILTER (WHERE p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL))::int AS rebuildable,
        COUNT(*) FILTER (WHERE NOT (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)))::int AS kept
      FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
      WHERE p.deleted_at IS NULL AND p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION} ${sourceIds ? 'AND p.source_id=ANY($1::text[])' : ''}`,
    sourceIds ? [sourceIds] : []);
    const rebuildable = Number(row?.rebuildable ?? 0), kept = Number(row?.kept ?? 0);
    const details = { pages_pending: rebuildable, kept_pages: kept, count: 'exact', truncated: false, repair: 'safe-chunks' };
    const keptNote = kept ? ` ${kept} other page(s) cannot be re-sealed here (code without a recorded source path, or image pages) and are left for their importer.` : '';
    if (rebuildable === 0) return { name, status: 'ok', details, message: `Every re-sealable page is at the safe-chunk index version.${keptNote}` };
    return { name, status: 'warn', details, message: `${rebuildable} page(s) are below the safe-chunk index version, so remote/MCP search withholds their chunks. `
      + `Preview: gbrain repair safe-chunks — apply: gbrain repair safe-chunks --apply.${keptNote}` };
  } catch (error) {
    return { name, status: 'warn', message: `Safe-chunk index state could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true, health: 'unknown' } };
  }
}
