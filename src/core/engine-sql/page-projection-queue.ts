/**
 * The page projection queue's enqueue (page-state/projections.ts queuePageProjection) as a typed member: the latest
 * knowledge revision of a live page is queued for a projection rebuild, whoever owns its worktree. Both SQL engines
 * delegate here; the Rust store serves it from its projection queue (persistence/projection_queue.rs queue_page_projection).
 */
import type { BrainEngine } from '../engine.ts';

/** Queues (or re-queues at the page's current revision, with `reason`) the live page at (source, slug); a missing or deleted page queues nothing. */
export async function queuePageProjectionJob(exec: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, reason: string): Promise<void> {
  await exec.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,$3 FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()`, [sourceId, slug, reason]);
}
