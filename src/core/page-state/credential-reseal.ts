/**
 * Credential-safe re-chunk of existing pages (security wave ENG-2). Schema
 * migration v189 unseals every live markdown/code page whose canonical body
 * carries a private-key marker, which withholds its old chunks from every
 * retrieval path. This module counts those pages and re-seals them from their
 * unchanged canonical body through the projection installer: no page write,
 * no journal admission and no provider call. Vectors of chunks whose text is
 * unchanged are kept; re-chunked key chunks wait for `gbrain embed --stale`.
 */
import type { BrainEngine } from '../engine.ts';
import { resealSafeChunks } from './projections.ts';
import { PageRevisionConflictError } from './types.ts';

const KEY_MARKER = `'-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----'`;
const REBUILDABLE = `(p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL))`;
const PENDING = `p.deleted_at IS NULL AND p.page_kind IN ('markdown','code')
  AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
  AND (p.compiled_truth ~ ${KEY_MARKER} OR COALESCE(p.timeline,'') ~ ${KEY_MARKER})`;

export interface CredentialPending { rebuildable: number; kept: number }

/** Pending pages in active sources; `kept` cannot be rebuilt here (code without a recorded source path). */
export async function credentialProjectionPending(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds?: string[]): Promise<CredentialPending> {
  const [row] = await engine.executeRaw<{ rebuildable: number; kept: number }>(`SELECT
      COUNT(*) FILTER (WHERE ${REBUILDABLE})::int AS rebuildable,
      COUNT(*) FILTER (WHERE NOT ${REBUILDABLE})::int AS kept
    FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
    WHERE ${PENDING} ${sourceIds ? 'AND p.source_id=ANY($1::text[])' : ''}`, sourceIds ? [sourceIds] : []);
  return { rebuildable: Number(row?.rebuildable ?? 0), kept: Number(row?.kept ?? 0) };
}

export interface CredentialResealResult { resealed: number; superseded: number; failed: number; kept: number }

/** Re-seal every rebuildable pending page, one page per transaction, so an interrupted run resumes where it stopped. */
export async function resealCredentialProjections(engine: BrainEngine): Promise<CredentialResealResult> {
  const rows = await engine.executeRaw<{ source_id: string; slug: string }>(`SELECT p.source_id,p.slug
    FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
    WHERE ${PENDING} AND ${REBUILDABLE} ORDER BY p.id`);
  const result: CredentialResealResult = { resealed: 0, superseded: 0, failed: 0, kept: 0 };
  for (const row of rows) {
    try {
      if (await resealSafeChunks(engine, row.slug, row.source_id)) result.resealed++;
      else result.superseded++;
    } catch (error) {
      if (error instanceof PageRevisionConflictError) { result.superseded++; continue; }
      result.failed++;
      process.stderr.write(`[gbrain] Credential-safe re-chunk failed for ${row.source_id}:${row.slug}; its chunks stay withheld. `
        + `Re-run: gbrain apply-migrations --yes --no-autopilot-install\n`);
    }
  }
  result.kept = (await credentialProjectionPending(engine)).kept;
  return result;
}
