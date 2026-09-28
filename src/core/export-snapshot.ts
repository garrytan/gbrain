import type { BrainEngine } from './engine.ts';
import { overlayCanonicalBodies } from './page-state/snapshot.ts';
import type { PageWithdrawal } from './page-state/types.ts';
import { rowToPage } from './utils.ts';
import { EXPORT_PAYLOAD_LIMIT } from './export-stage.ts';

export async function readExportWithdrawals(tx: BrainEngine, sourceId: string): Promise<PageWithdrawal[]> {
  const [size] = await tx.executeRaw<{ bytes: number }>(`SELECT COALESCE(sum(octet_length(
    jsonb_build_object('visibility',visibility,'fact_hash',fact_hash,'withdrawn_at',withdrawn_at)::text)+1),0)+2 AS bytes
    FROM fact_withdrawals WHERE source_id=$1`, [sourceId]);
  if (Number(size.bytes) > EXPORT_PAYLOAD_LIMIT) throw new Error('Export withdrawal ledger capacity exceeded. No destination output was published.');
  return tx.executeRaw<PageWithdrawal>(`SELECT visibility,fact_hash,withdrawn_at
    FROM fact_withdrawals WHERE source_id=$1 ORDER BY visibility,fact_hash`, [sourceId]);
}

export async function readExportPage(tx: BrainEngine, key: { id: string; source_id: string; slug: string }, withdrawals: PageWithdrawal[]) {
  const [row] = await tx.executeRaw<Record<string, unknown>>(`WITH export_page AS MATERIALIZED (
    SELECT * FROM pages WHERE id=$1::bigint
  ) SELECT p.*,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS export_tags
    FROM export_page p WHERE p.source_id=$2 AND p.slug=$3 AND p.deleted_at IS NULL`,
  [key.id, key.source_id, key.slug]);
  if (!row) throw new Error('Export snapshot unexpectedly lost a selected page.');
  const page = rowToPage(row);
  if (page.compiled_truth.includes('gbrain:facts:') || page.timeline.includes('gbrain:facts:')) {
    Object.assign(page, await overlayCanonicalBodies(tx.executeRaw.bind(tx), page.compiled_truth, page.timeline, withdrawals));
  }
  return { page, tags: row.export_tags as string[] };
}
