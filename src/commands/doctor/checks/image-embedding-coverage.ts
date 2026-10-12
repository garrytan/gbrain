/**
 * #6529 `image_embedding_coverage`: the image side of search, reported apart
 * from text coverage. Image pages carry a text vector (their caption or OCR
 * projection), so `embed_coverage_pct` reads as done while the image vector
 * (`content_chunks.embedding_image`) is missing and image search never works.
 * Counts live image pages without an image vector, image pages whose
 * `source_path` was never recorded (the sweep finds them by slug), and the
 * images managed sync holds as `managed_image_sync_unsupported`. Warns only
 * on a multimodal install (`GBRAIN_EMBEDDING_MULTIMODAL=true`): without the
 * image provider the counts are informational.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { isMultimodalEnabled } from '../../../core/sync.ts';
import { readGitImageHoldCounts } from '../../../core/persistence/sync-holds.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export async function imageEmbeddingCoverageCheck(engine: BrainEngine): Promise<Check> {
  const name = 'image_embedding_coverage';
  try {
    const [row] = await engine.executeRaw<{ image_pages: number | string; without_image_vector: number | string; null_source_path: number | string }>(
      `SELECT count(*)::int AS image_pages,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.embedding_image IS NOT NULL))::int AS without_image_vector,
         count(*) FILTER (WHERE p.source_path IS NULL)::int AS null_source_path
       FROM pages p WHERE p.page_kind = 'image' AND p.deleted_at IS NULL`);
    const sources = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived');
    const holds = await readGitImageHoldCounts(engine, sources.map(source => source.id));
    const unsupportedHolds = [...holds.values()].reduce((sum, count) => sum + count, 0);
    const multimodal = isMultimodalEnabled();
    const details = { image_pages: Number(row?.image_pages ?? 0), without_image_vector: Number(row?.without_image_vector ?? 0),
      null_source_path: Number(row?.null_source_path ?? 0), unsupported_holds: unsupportedHolds, multimodal };
    if (details.image_pages === 0 && unsupportedHolds === 0) return { name, status: 'ok', message: 'No image pages indexed yet.', details };
    const parts = [`${details.without_image_vector} of ${details.image_pages} image page(s) have no image vector`,
      ...(details.null_source_path ? [`${details.null_source_path} with no recorded source_path`] : []),
      ...(unsupportedHolds ? [`${unsupportedHolds} held as managed_image_sync_unsupported`] : [])];
    if (!multimodal) {
      return { name, status: 'ok', details, message: `${parts.join('; ')}. Multimodal embedding is off (GBRAIN_EMBEDDING_MULTIMODAL), so image search is not expected to work; `
        + 'text coverage of these pages is counted with the other pages.' };
    }
    if (details.without_image_vector === 0 && unsupportedHolds === 0 && details.null_source_path === 0) {
      return { name, status: 'ok', details, message: `All ${details.image_pages} image page(s) have an image vector.` };
    }
    return { name, status: 'warn', details, message: `${parts.join('; ')}. Text coverage counts these pages as embedded, but image search does not see them. `
      + 'Fix: run gbrain embed --stale --images (gbrain embed --stale runs it first on this install; a page with no source_path is found by its slug and gets it recorded), '
      + 'and gbrain sync --no-pull --source <id> imports held images now that multimodal embedding is on.' };
  } catch (e) {
    return { name, status: 'warn', message: `image embedding coverage scan skipped: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function runImageEmbeddingCoverage(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('image_embedding_coverage');
  const check = await imageEmbeddingCoverageCheck(connectedEngine(ctx));
  checks.push({ name: 'image_embedding_coverage', status: check.status, message: check.message, ...(check.details ? { details: check.details } : {}) });
  return checks;
}

export const imageEmbeddingCoverageEntry: DoctorEntry = {
  name: 'image_embedding_coverage',
  emits: ['image_embedding_coverage'],
  run: runImageEmbeddingCoverage,
};
