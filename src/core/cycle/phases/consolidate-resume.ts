import type { PhaseResult } from '../../cycle.ts';
import type { BrainEngine } from '../../engine.ts';
type Bucket = { source_id: string; entity_slug: string; count: number };

export async function selectConsolidationBuckets(engine: BrainEngine, sourceId: string | undefined,
  managed: boolean, minPerBucket: number, bounded: boolean): Promise<Bucket[]> {
  return engine.executeRaw<{
      source_id: string; entity_slug: string; count: number;
    }>(`
      SELECT source_id, entity_slug, COUNT(*)::int AS count
      FROM facts
      WHERE consolidated_at IS NULL
        AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND entity_slug IS NOT NULL
        AND (attributed_to IS NULL OR attributed_to = 'user')
        AND ($2::boolean=false OR visibility='world')
        AND ($1::text IS NULL OR source_id=$1)
      GROUP BY source_id, entity_slug
      HAVING COUNT(*) >= $3
        ${bounded ? "AND COUNT(*) FILTER (WHERE embedding IS NOT NULL AND COALESCE(embedding_model, '') <> '' AND embedded_text_hash = md5(fact)) >= 2" : ''}
    `, [sourceId ?? null, managed, minPerBucket]);
}

export async function resumeConsolidationBuckets(engine: BrainEngine, buckets: Bucket[], cursorKey: string,
  sourceId?: string): Promise<{ buckets: Bucket[]; resumedFrom: { source_id: string; entity_slug: string } | null }> {
  let resumedFrom: { source_id: string; entity_slug: string } | null = null;
    // Use the same comparison for ordering and cursor lookup, regardless of DB collation.
    buckets.sort((a, b) => a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1
      : a.entity_slug < b.entity_slug ? -1 : a.entity_slug > b.entity_slug ? 1 : 0);
    try {
      const cursor = JSON.parse((await engine.getConfig(cursorKey)) ?? '');
      if (typeof cursor?.source_id === 'string' && typeof cursor?.entity_slug === 'string' &&
          (sourceId === undefined || sourceId === cursor.source_id)) {
        resumedFrom = cursor;
        const start = buckets.findIndex(b => b.source_id > cursor.source_id ||
          (b.source_id === cursor.source_id && b.entity_slug >= cursor.entity_slug));
        if (start > 0) buckets = [...buckets.slice(start), ...buckets.slice(0, start)];
      }
    } catch { /* Missing or invalid cursor starts at the first bucket. */ }

  return { buckets, resumedFrom };
}

export async function scanConsolidationBuckets(engine: BrainEngine, sourceId: string | undefined,
  managed: boolean, minPerBucket: number, bounded: boolean): Promise<{ buckets: Bucket[]; failure?: undefined } | { buckets?: undefined; failure: PhaseResult }> {

  try {
    return { buckets: await selectConsolidationBuckets(engine, sourceId, managed, minPerBucket, bounded) };
  } catch (err) {
    return { failure: {
      phase: 'consolidate',
      status: 'fail',
      duration_ms: 0,
      summary: 'failed to scan unconsolidated facts',
      details: { error: err instanceof Error ? err.message : String(err) },
      error: {
        class: 'ConsolidateScanFailed',
        code: 'consolidate_scan_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    } };
  }

}
