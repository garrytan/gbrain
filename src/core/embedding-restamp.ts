/**
 * W3 (GBRA-224, #5527 class): free signature restamp in the maintenance
 * cycle's embed phase (never on upgrade). A page whose stored signature is
 * missing or names another model, while every one of its chunks already holds
 * a vector of the current model (model column, embedded text hash, width, in
 * the registry-active column), is only missing its stamp. The restamp sets
 * `pages.embedding_signature` without a provider call, so those vectors stop
 * reading as "a previous model's space" and stop costing a paid re-embed.
 *
 * Each page is stamped in its own transaction under the shared page-write
 * guard (`lockPageKeys`, the lock installPageEmbeddings and every chunk
 * writer takes), and the UPDATE re-checks, after the lock, the revision and
 * old signature read at selection, the projection seal (text projection at
 * the knowledge revision), the active column, and that every chunk is still
 * current. A concurrent re-embed, chunk rewrite or content change between the
 * read and the stamp makes the UPDATE match nothing; that page is retried on
 * a later run. It never touches content or vectors.
 *
 * Bounded: at most EMBEDDING_RESTAMP_MAX_PAGES pages per run. A run that
 * throws counts a failed attempt in the heal audit; after
 * EMBEDDING_RESTAMP_FAILURE_BOUND consecutive failed runs doctor's
 * `embedding_restamp_stalled` check (page class) reports it. A run that
 * completes resets the count. `embed.restamp.enabled=false` turns it off.
 */
import type { BrainEngine } from './engine.ts';
import { resolveActiveEmbeddingColumnFromEngine, quoteIdentifier } from './search/embedding-column.ts';
import { pageBudgetLimitedFilter } from './page-size-policy.ts';
import { chunkGenerationFilter } from './search/safe-chunks.ts';
import { currentSpaceChunkPredicate, splitEmbeddingSignature } from './embedding-invalidation.ts';
import { healEnabled, readHealAudit, recordHealAudit } from './heal-audit.ts';

export const EMBEDDING_RESTAMP_ENABLED_KEY = 'embed.restamp.enabled';
export const EMBEDDING_RESTAMP_CODE = 'embedding_restamp';
export const EMBEDDING_RESTAMP_MAX_PAGES = 500;
export const EMBEDDING_RESTAMP_FAILURE_BOUND = 3;

export interface EmbeddingRestampResult {
  /** Pages stamped this run. */
  pages: number;
  chunks: number;
  /** Pages the guarded UPDATE no longer matched (changed between read and stamp); retried next run. */
  rejected: number;
  /** More candidates remain past the per-run bound. */
  capped: boolean;
  max_pages: number;
  /** Consecutive failed runs including this one (0 after a completed run). */
  failed_runs: number;
  error?: string;
}

/** The page rule every stamp re-checks under the guard: $1 signature, $2 model, $3 dims. */
function restampablePage(colId: string): string {
  return `(p.embedding_signature IS NULL OR p.embedding_signature <> $1)
       AND p.deleted_at IS NULL
       AND p.text_projection_revision = p.knowledge_revision
       AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
       AND NOT ${pageBudgetLimitedFilter('p')}
       AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND NOT s.archived)
       AND EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc')})
       AND NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc')} AND NOT ${currentSpaceChunkPredicate(colId, 2, 3)})`;
}

let beforeStampForTests: ((pageId: number) => Promise<void>) | null = null;
/** Test seam: runs after selection and before each page's guarded stamp (a concurrent writer's window). */
export function __setRestampBeforeStampForTests(fn: ((pageId: number) => Promise<void>) | null): void { beforeStampForTests = fn; }

async function lastFailedRuns(engine: BrainEngine): Promise<number> {
  const last = (await readHealAudit(engine, EMBEDDING_RESTAMP_CODE)).at(-1);
  return last?.outcome === 'failed' || last?.outcome === 'escalated' ? last.attempt : 0;
}

/**
 * Restamp up to `maxPages` current-space pages under `signature`. Returns null
 * when the heal is off or the signature carries no width. Never calls a provider.
 */
export async function restampCurrentSpaceSignatures(engine: BrainEngine, signature: string,
  opts: { maxPages?: number; signal?: AbortSignal } = {}): Promise<EmbeddingRestampResult | null> {
  if (!await healEnabled(engine, EMBEDDING_RESTAMP_ENABLED_KEY)) return null;
  const { model, dims } = splitEmbeddingSignature(signature);
  if (dims === null) return null;
  const maxPages = opts.maxPages ?? EMBEDDING_RESTAMP_MAX_PAGES;
  const result: EmbeddingRestampResult = { pages: 0, chunks: 0, rejected: 0, capped: false, max_pages: maxPages, failed_runs: 0 };
  try {
    const colId = quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name);
    const candidates = await engine.executeRaw<{ id: number; source_id: string; slug: string; revision: string; signature: string | null; chunks: number }>(
      `SELECT p.id, p.source_id, p.slug, p.knowledge_revision::text AS revision, p.embedding_signature AS signature,
              (SELECT count(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc')}) AS chunks
         FROM pages p WHERE ${restampablePage(colId)}
        ORDER BY p.id LIMIT ${maxPages + 1}`, [signature, model, dims]);
    result.capped = candidates.length > maxPages;
    for (const page of candidates.slice(0, maxPages)) {
      if (opts.signal?.aborted) break;
      await beforeStampForTests?.(page.id);
      const stamped = await engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
        const active = quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(tx, { fallbackToLegacy: true })).name);
        if (active !== colId) return false;
        const rows = await tx.executeRaw<{ id: number }>(
          `UPDATE pages p SET embedding_signature = $1
            WHERE p.id = $4 AND p.knowledge_revision = $5::uuid AND p.embedding_signature IS NOT DISTINCT FROM $6::text
              AND ${restampablePage(active)}
            RETURNING p.id`, [signature, model, dims, page.id, page.revision, page.signature]);
        return rows.length === 1;
      });
      if (stamped) { result.pages++; result.chunks += Number(page.chunks); } else result.rejected++;
    }
    if (result.pages > 0 || await lastFailedRuns(engine) > 0) {
      await recordHealAudit(engine, [{ code: EMBEDDING_RESTAMP_CODE, outcome: 'restamped', attempt: 0, bound: EMBEDDING_RESTAMP_FAILURE_BOUND,
        subject: signature, detail: `${result.pages} page(s), ${result.chunks} chunk(s); ${result.rejected} changed under the stamp${result.capped ? `; more remain past the ${maxPages}-page bound` : ''}` }]);
    }
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.failed_runs = await lastFailedRuns(engine).catch(() => 0) + 1;
    await recordHealAudit(engine, [{ code: EMBEDDING_RESTAMP_CODE, outcome: result.failed_runs >= EMBEDDING_RESTAMP_FAILURE_BOUND ? 'escalated' : 'failed',
      attempt: result.failed_runs, bound: EMBEDDING_RESTAMP_FAILURE_BOUND, subject: signature, detail: result.error.slice(0, 300) }]).catch(() => undefined);
    return result;
  }
}

/** The cycle embed phase's entry: restamp under the configured model's signature (W3; never on upgrade, never in a dry run). */
export async function restampCycleSignatures(engine: BrainEngine, signal?: AbortSignal): Promise<EmbeddingRestampResult | null> {
  const { currentEmbeddingSignature } = await import('./embedding.ts');
  const signature = currentEmbeddingSignature();
  return signature ? restampCurrentSpaceSignatures(engine, signature, { signal }) : null;
}

/** The latest restamp audit row when consecutive failed runs reached the bound, else null (doctor's embedding_restamp_stalled). */
export async function restampEscalation(engine: BrainEngine) {
  const last = (await readHealAudit(engine, EMBEDDING_RESTAMP_CODE)).at(-1);
  return last && last.attempt >= EMBEDDING_RESTAMP_FAILURE_BOUND && (last.outcome === 'failed' || last.outcome === 'escalated') ? last : null;
}
