/**
 * Exact link reconciliation for one keyset batch of `gbrain extract --stale`.
 *
 * Each origin's complete desired set must stay intact. Splitting one origin
 * across generic addLinksBatch chunks would either remain additive or let a
 * later reconciliation slice delete rows inserted by an earlier slice.
 */
import type { BrainEngine, LinkBatchInput, ManagedDerivedLinkSource, TimelineBatchInput } from '../core/engine.ts';
import { runWithLimit } from '../core/worker-pool.ts';

export interface StalePageLinkSet {
  originSlug: string;
  sourceId: string;
  links: LinkBatchInput[];
  linkSources?: readonly ManagedDerivedLinkSource[];
  expectedUpdatedAt: string;
  stampExtractedAt: string;
  timelineEntries: TimelineBatchInput[];
}

export async function reconcileStalePageLinks(
  engine: BrainEngine,
  desiredByPage: StalePageLinkSet[],
): Promise<{
  created: number;
  removed: number;
  timelineCreated: number;
  pagesApplied: number;
  revisionRejected: number;
}> {
  let created = 0;
  let removed = 0;
  let timelineCreated = 0;
  let pagesApplied = 0;
  let revisionRejected = 0;
  // Postgres origins are independent and row-lock fenced, so a small bounded
  // fan-out removes the one-transaction-per-roundtrip 74k-page bottleneck.
  // PGLite is a single connection and must remain serial.
  const settled = await runWithLimit({
    items: desiredByPage,
    limit: engine.kind === 'postgres' ? 8 : 1,
    fn: async (desired) => engine.reconcileDerivedLinks(
      desired.originSlug,
      desired.links,
      {
        sourceId: desired.sourceId,
        linkSources: desired.linkSources,
        expectedUpdatedAt: desired.expectedUpdatedAt,
        stampExtractedAt: desired.stampExtractedAt,
        timelineEntries: desired.timelineEntries,
        auditSite: 'extract.stale',
      },
    ),
  });
  for (const item of settled) {
    if (!item.ok) throw item.error;
    created += item.value.created;
    removed += item.value.removed;
    timelineCreated += item.value.timelineCreated ?? 0;
    if (item.value.applied === false) revisionRejected++;
    else pagesApplied++;
  }
  return { created, removed, timelineCreated, pagesApplied, revisionRejected };
}
