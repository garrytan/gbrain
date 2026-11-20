/**
 * The two statements that list the copies of one slug under a read policy, each ordered by source id in byte order
 * (`COLLATE "C"`), so the copies come back in the same order on every engine whatever the database locale is
 * (test/engine-parity/collate-slug-sources.test.ts). Both ran through `executeRaw` in their callers with the text and
 * parameters below; only their home moved (search/explain-target.ts `probeTarget`, search/relational-chain.ts
 * `resolveChainAnchors`). The text of each is pinned in test/engine-sql-caller-raw-sql-pins.test.ts.
 */
import type { PageReadPolicy } from '../types.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { readFilter } from './search-reads.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

/** One readable copy of the target page (explain_target's probe). */
export interface TargetProbeRow {
  source_id: string;
  chunks: number;
  /** Chunks with a vector; 0 with chunks > 0 means only the keyword and title arms can return the page. */
  embedded: number;
  current: boolean;
  chunker_version: number | null;
}

/** One live copy of a slug the relational chain starts from. */
export interface ChainAnchorRow { page_id: number; source_id: string }

/**
 * Every readable live copy of `slug` under `policy`, by source id in byte order: its visible chunk count
 * (`chunkGenerationFilter`; `chunkManifest` false drops the segmented branch), how many of those have a vector, whether
 * its text projection is its knowledge revision, and its chunker version.
 */
export async function probeTargetRows(raw: EngineRawRead, slug: string, policy: PageReadPolicy, chunkManifest = true): Promise<TargetProbeRow[]> {
  const generation = trustedSql(chunkGenerationFilter('p', 'cc', chunkManifest));
  const { text, params } = renderFragment(sqlFragment`SELECT p.source_id,
       (SELECT COUNT(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND ${generation}) AS chunks,
       (SELECT COUNT(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND cc.embedding IS NOT NULL AND ${generation}) AS embedded,
       ((p.text_projection_revision = p.knowledge_revision) IS TRUE) AS current,
       p.chunker_version
     FROM pages p WHERE p.slug = ${slug} AND ${readFilter('p', policy, true)} ORDER BY p.source_id COLLATE "C"`);
  const rows = await raw<{ source_id: string; chunks: number; embedded: number; current: boolean; chunker_version: number | null }>(text, params);
  return rows.map(r => ({ source_id: r.source_id, chunks: Number(r.chunks), embedded: Number(r.embedded), current: r.current === true, chunker_version: r.chunker_version == null ? null : Number(r.chunker_version) }));
}

/** The page id and source id of each live copy of `slug` that `policy` admits, by source id in byte order. */
export async function listChainAnchors(raw: EngineRawRead, slug: string, policy: PageReadPolicy): Promise<ChainAnchorRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.source_id FROM pages p WHERE p.slug = ${slug} AND ${readFilter('p', policy, true)} ORDER BY p.source_id COLLATE "C"`);
  const rows = await raw<{ id: number; source_id: string }>(text, params);
  return rows.map(r => ({ page_id: Number(r.id), source_id: r.source_id }));
}
