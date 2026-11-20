/**
 * The page text seal, kept apart from projections.ts so the engine-sql chunk
 * code can run it without loading the projection pipeline's provider closure.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from './types.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';

/**
 * Complete the searchable snapshot only after its sanitized chunks are installed.
 * `guarded` is this transaction's own read of the page under its guard, when
 * the caller has one and has not changed the page's revision or timeline since.
 */
export async function sealPageTextProjection(engine: Pick<BrainEngine, 'writeTextProjectionSeal' | 'readPageSnapshot'>, slug: string, sourceId: string,
  guarded?: PageSnapshot): Promise<void> {
  const current = guarded ?? await engine.readPageSnapshot(slug, { sourceId });
  if (!current) return;
  await engine.writeTextProjectionSeal(slug, { sourceId, revision: current.revision, timelineText: sanitizeRemoteBody(current.page.timeline) });
}
