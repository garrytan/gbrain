import type { ScopedRead } from './engine-sql/brands.ts';
import { loadFenceChunkOverlay } from './eligibility/fence-overlay.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';
import { prepareProseChunks } from './markdown-chunks.ts';
import { isSegmentedPage } from './page-body/page-shape.ts';
import { readPageSnapshot } from './page-state/snapshot.ts';
import { PageRevisionConflictError } from './page-state/types.ts';
import { isQuarantined } from './quarantine.ts';
import type { ReadQuery } from './search/read-enrichment.ts';

export type OrdinaryChunkPresence = 'present' | 'empty';

export interface OrdinaryChunkCandidateRef {
  id: number;
  source_id: string;
  slug: string;
  revision: string;
}

export async function inspectOrdinaryChunkPresence(exec: ScopedRead, ref: OrdinaryChunkCandidateRef): Promise<OrdinaryChunkPresence> {
  const query: ReadQuery = <T>(sql: string, params?: unknown[]) => exec.executeRaw<T>(sql, params);
  const snapshot = await readPageSnapshot(query, ref.slug, { sourceId: ref.source_id });
  if (!snapshot || Number(snapshot.page.id) !== ref.id || snapshot.page.source_id !== ref.source_id
    || snapshot.page.slug !== ref.slug || snapshot.revision !== ref.revision || isSegmentedPage(snapshot.page)
    || isQuarantined(snapshot.page.frontmatter)) {
    throw new PageRevisionConflictError(ref.revision, snapshot?.revision ?? null);
  }
  const page = snapshot.page;
  const overlay = await loadFenceChunkOverlay(exec, { sourceId: ref.source_id, slug: ref.slug,
    compiled_truth: page.compiled_truth, timeline: page.timeline });
  const chunks = await prepareProseChunks(page, resolveMaxChunkTokens(), overlay);
  return chunks.length > 0 ? 'present' : 'empty';
}
