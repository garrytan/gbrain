/**
 * #6803 part 2: `gbrain projections drain` restores the importer's own seal on
 * `sealable` image pages (page-state/projection-class.ts). Migration v153 only
 * removed their seal marker: each chunk was written by the importer at or after
 * the safe-chunk fence with safeChunks true, and the page's revision has not
 * moved since. Explicit only: the resident never seals images.
 */
import type { BrainEngine } from '../engine.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { chunkGenerationFilter, chunkGenerationProbe, movableChunkSql } from '../search/safe-chunks.ts';
import { sealableImageSql } from './projection-class.ts';
import { jsonRowBatches } from '../batch-rows.ts';
import { acceptedEmbeddingInputHashes } from '../embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from './projections.ts';
import { AGENT_TOOL_LIMIT_MS } from '../agent-output.ts';

/**
 * Measured `sealImageProjections` throughput, the basis of doctor's drain
 * `--limit` and the post-upgrade estimate. Measured 2026-10-16 on a 4-vCPU
 * cloud machine, a full `drainProjections({ media: true })` of 10,000 queued
 * sealable images (statistics refresh included): 2,047 pages/s on PGLite,
 * 1,809 pages/s on local Postgres 16; this is the slower, rounded down.
 */
export const IMAGE_SEAL_PAGES_PER_SECOND = 1500;

/**
 * Measured Markdown rebuild throughput of the same drain (no embedding): 2,000
 * queued notes of about 3 KB, 117 pages/s on PGLite and 87 pages/s on local
 * Postgres 16, same machine and day; the slower, rounded down.
 */
export const TEXT_REBUILD_PAGES_PER_SECOND = 80;

/**
 * Pages one drain run takes in doctor's fix: half the agent tool limit at the
 * measured rate, so a run fits the limit with room to spare. The drain takes
 * queued text first, so while `textPending` rows wait the slower text rate sizes it.
 */
export function projectionDrainLimit(textPending = 0): number {
  const rate = textPending > 0 ? TEXT_REBUILD_PAGES_PER_SECOND : IMAGE_SEAL_PAGES_PER_SECOND;
  return Math.max(100, Math.floor(rate * AGENT_TOOL_LIMIT_MS / 1000 / 2 / 100) * 100);
}

/** Whole minutes (at least 1) a drain of `pages` takes at the measured rate. */
export function projectionDrainMinutes(pages: number): number {
  return Math.max(1, Math.ceil(pages / IMAGE_SEAL_PAGES_PER_SECOND / 60));
}

/** Statement group of `sealImageProjections`: pages locked, read and sealed together. */
export const IMAGE_SEAL_GROUP = 500;

export interface ImageSealResult {
  sealed: number;
  /** Sealed pages whose chunk carries a visual vector: image search ranks them again. */
  sealed_with_visual: number;
  /** Sealed pages with no visual vector yet (imported with --no-embed): keyword-only until `gbrain embed --stale --images`. */
  sealed_text_only: number;
}

type Candidate = { source_id: string; source_incarnation: string; slug: string; revision: string };

/**
 * Restore the importer's own seal on `sealable` images, set-based: per group
 * of up to 500 pages, under the page guard, a compare-and-set on the queued
 * revision with the class re-checked under the guard. No chunk is written and
 * `embedding_image` and the keyword vector are untouched; a text vector whose recorded embedding input
 * no longer matches the page (#5553) is nulled for `embed --stale`, as
 * `installPageProjection` would. The queue trigger deletes the job of every
 * sealed page. No provider call, no file read. `notAfter` (a database
 * instant, text) leaves rows queued during the run for the next one.
 */
export async function sealImageProjections(engine: BrainEngine, opts: { limit?: number; notAfter?: string } = {}): Promise<ImageSealResult> {
  const result: ImageSealResult = { sealed: 0, sealed_with_visual: 0, sealed_text_only: 0 };
  let after: [string, string] = ['00000000-0000-0000-0000-000000000000', ''];
  let budget = opts.limit ?? Infinity;
  const target = await embeddingWriteTarget(engine);
  const col = quoteIdentifier(target.column.name);
  while (budget > 0) {
    // A primary-key window of queue rows, each probed by its page's unique key only: without planner statistics
    // (a fresh PGLite) a deleted_at filter here lets the planner pick pages_dedup_idx and scan the source per row.
    const params: unknown[] = [after[0], after[1], IMAGE_SEAL_GROUP];
    const notAfter = opts.notAfter === undefined ? '' : `AND j.updated_at<=$${params.push(opts.notAfter)}::text::timestamptz`;
    const window = await engine.executeRaw<Candidate & { sealable: boolean }>(`SELECT s.id AS source_id,j.source_incarnation::text AS source_incarnation,
        j.slug,j.revision::text AS revision,p.sealable IS TRUE AS sealable
      FROM (SELECT source_incarnation,slug,revision FROM page_projection_jobs j WHERE (j.source_incarnation,j.slug) > ($1::uuid,$2) ${notAfter}
        ORDER BY j.source_incarnation,j.slug LIMIT $3) j
      LEFT JOIN LATERAL (SELECT s.id FROM sources s WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s ON true
      LEFT JOIN LATERAL (SELECT p.deleted_at IS NULL AND p.knowledge_revision=j.revision AND ${sealableImageSql('p')} AS sealable
        FROM pages p WHERE p.source_id=s.id AND p.slug=j.slug OFFSET 0) p ON true
      ORDER BY j.source_incarnation,j.slug`, params);
    if (!window.length) break;
    const group = window.filter(row => row.sealable).slice(0, budget);
    const last = group.length === budget ? group[group.length - 1]! : window[window.length - 1]!;
    after = [last.source_incarnation, last.slug];
    if (!group.length) continue;
    budget -= group.length;
    const sealed = await engine.transaction(async tx => {
      await tx.lockPageKeys(group.map(row => ({ sourceId: row.source_id, slug: row.slug })));
      const pages = await tx.executeRaw<{ id: number; revision: string; title: string; mode: string | null;
        corpus_generation: string | null }>(`SELECT p.id,p.knowledge_revision::text AS revision,p.title,
          p.contextual_retrieval_mode AS mode,p.corpus_generation
        FROM jsonb_to_recordset($1::text::jsonb) AS v(source_id text, slug text, revision uuid)
        JOIN sources s ON s.id=v.source_id AND NOT s.archived
        CROSS JOIN LATERAL (SELECT p.id FROM pages p WHERE p.source_id=v.source_id AND p.slug=v.slug OFFSET 0) k
        JOIN pages p ON p.id=k.id
        WHERE p.deleted_at IS NULL AND p.knowledge_revision=v.revision AND ${sealableImageSql('p')}`, [JSON.stringify(group.map(({ source_id, slug, revision }) => ({ source_id, slug, revision })))]);
      if (!pages.length) return [];
      const chunks = await tx.executeRaw<{ id: number; page_id: number; chunk_text: string; chunk_source: string;
        embedding_input_hash: string | null; current: boolean }>(`SELECT id,page_id,chunk_text,chunk_source,embedding_input_hash,
          ${movableChunkSql(col)} AND model IS NOT DISTINCT FROM $2 AS current
        FROM content_chunks c WHERE c.page_id=ANY($1::int[]) AND c.${col} IS NOT NULL AND ${chunkGenerationProbe('c')}`, [pages.map(page => Number(page.id)), target.provenanceModel]);
      const byId = new Map(pages.map(page => [Number(page.id), page]));
      const stale = chunks.filter(chunk => {
        const page = byId.get(Number(chunk.page_id))!;
        if (!chunk.current) return true;
        if (chunk.embedding_input_hash === null) return page.mode != null;
        const provenance = embeddingInputContext(target, page.title, page.corpus_generation, [chunk]);
        return !acceptedEmbeddingInputHashes(provenance, page.mode, chunk).includes(chunk.embedding_input_hash);
      }).map(chunk => Number(chunk.id));
      if (stale.length) {
        await tx.executeRaw(`UPDATE content_chunks SET ${col}=NULL,embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,
          embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE id=ANY($1::int[])`, [stale]);
      }
      const done: Array<{ has_visual: boolean }> = [];
      // Only the marker: the importer's keyword vector is still the page's own, since its revision has not moved.
      for (const batch of jsonRowBatches(pages, page => ({ id: Number(page.id), revision: page.revision }))) {
        done.push(...await tx.executeRaw<{ has_visual: boolean }>(`UPDATE pages SET text_projection_revision=pages.knowledge_revision
          FROM jsonb_to_recordset($1::text::jsonb) AS v(id int, revision uuid)
          WHERE pages.id=v.id AND pages.knowledge_revision=v.revision
          RETURNING EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=pages.id AND c.embedding_image IS NOT NULL
            AND ${chunkGenerationFilter('pages', 'c')}) AS has_visual`, [batch]));
      }
      return done;
    });
    result.sealed += sealed.length;
    result.sealed_with_visual += sealed.filter(row => row.has_visual).length;
  }
  result.sealed_text_only = result.sealed - result.sealed_with_visual;
  return result;
}
