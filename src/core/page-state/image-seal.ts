/**
 * #6803 part 2: `gbrain projections drain` restores the importer's own seal on
 * `sealable` image pages (page-state/projection-class.ts). Migration v153 only
 * removed their seal marker: each chunk was written by the importer at or after
 * the safe-chunk fence with safeChunks true, and the page's revision has not
 * moved since. Explicit only: the resident never seals images.
 */
import type { BrainEngine } from '../engine.ts';
import { TEXT_REBUILD_PAGES_PER_SECOND } from './rebuild-estimate.ts';
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

export { TEXT_REBUILD_PAGES_PER_SECOND } from './rebuild-estimate.ts';

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
  while (budget > 0) {
    // A primary-key window of queue rows, each probed by its page's unique key only: without planner statistics
    // (a fresh PGLite) a deleted_at filter here lets the planner pick pages_dedup_idx and scan the source per row.
    const window = await engine.listImageSealWindow({ sourceIncarnation: after[0], slug: after[1] }, IMAGE_SEAL_GROUP, opts.notAfter);
    if (!window.length) break;
    const group = window.filter((row): row is Candidate & { sealable: true } => row.sealable && row.source_id !== null).slice(0, budget);
    const last = group.length === budget ? group[group.length - 1]! : window[window.length - 1]!;
    after = [last.source_incarnation, last.slug];
    if (!group.length) continue;
    budget -= group.length;
    const sealed = await engine.transaction(async tx => {
      await tx.lockPageKeys(group.map(row => ({ sourceId: row.source_id, slug: row.slug })));
      const pages = await tx.readImageSealPages(group.map(({ source_id, slug, revision }) => ({ source_id, slug, revision })));
      if (!pages.length) return [];
      const chunks = await tx.listImageSealChunks(pages.map(page => Number(page.id)), target.column, target.provenanceModel);
      const byId = new Map(pages.map(page => [Number(page.id), page]));
      const stale = chunks.filter(chunk => {
        const page = byId.get(Number(chunk.page_id))!;
        if (!chunk.current) return true;
        if (chunk.embedding_input_hash === null) return page.mode != null;
        const provenance = embeddingInputContext(target, page.title, page.corpus_generation, [chunk]);
        return !acceptedEmbeddingInputHashes(provenance, page.mode, chunk).includes(chunk.embedding_input_hash);
      }).map(chunk => ({ id: Number(chunk.id), page_id: Number(chunk.page_id) }));
      if (stale.length) await tx.clearImageSealVectors(target.column, stale);
      const done: Array<{ has_visual: boolean }> = [];
      // Only the marker: the importer's keyword vector is still the page's own, since its revision has not moved.
      for (const batch of jsonRowBatches(pages, page => ({ id: Number(page.id), revision: page.revision }))) {
        done.push(...await tx.sealImagePages(JSON.parse(batch) as Array<{ id: number; revision: string }>));
      }
      return done;
    });
    result.sealed += sealed.length;
    result.sealed_with_visual += sealed.filter(row => row.has_visual).length;
  }
  result.sealed_text_only = result.sealed - result.sealed_with_visual;
  return result;
}
