/**
 * The statements gbrain export runs (src/commands/export.ts, src/core/export-snapshot.ts), one function per
 * BrainEngine member. PGLite and Postgres run the same text the export ran through executeRaw before; the Rust engine
 * answers from its store (rust/docs/store/cli-reads-export.md). Each runs on the engine it is given, so a call on a
 * transaction engine reads inside that transaction.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { rowToPage } from '../utils.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One page key of an export batch: the page's identity, whether its body is segmented, its raw_data row count and its payload size in bytes. */
export interface ExportPageKey {
  id: string;
  segmented: boolean;
  slug: string;
  source_id: string;
  source_path: string | null;
  source_path_bytes: number | null;
  raw_count: number;
  bytes: number;
}

export interface ExportPageKeyQuery { afterId: string; sourceId: string | null; type: string | null; slugPrefix: string | null }

/** The next 256 live pages after page id `afterId`, in id order, within the source, type and slug prefix (null: any). */
export async function listExportPageKeys(tx: Raw, q: ExportPageKeyQuery): Promise<ExportPageKey[]> {
  return tx.executeRaw<ExportPageKey>(
    `SELECT p.id::text, p.body_storage='segmented' AS segmented, left(p.slug,4097) AS slug, p.source_id, left(p.source_path,4097) AS source_path, octet_length(p.source_path) AS source_path_bytes,
            (SELECT count(*) FROM raw_data r WHERE r.page_id=p.id) AS raw_count,
            CASE WHEN p.body_storage='segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth)::bigint + octet_length(p.timeline) END
              + octet_length(p.frontmatter::text)
              + octet_length(p.title) + octet_length(p.slug) + COALESCE(octet_length(p.source_path),0)
              + COALESCE((SELECT sum(octet_length(r.data::text)+octet_length(r.source)) FROM raw_data r WHERE r.page_id=p.id),0)
              + COALESCE((SELECT sum(octet_length(t.tag)) FROM tags t WHERE t.page_id=p.id),0) AS bytes
           FROM pages p WHERE p.id > $1::bigint AND p.deleted_at IS NULL
             AND ($2::text IS NULL OR p.source_id=$2) AND ($3::text IS NULL OR p.type=$3)
             AND ($4::text IS NULL OR starts_with(p.slug,$4)) ORDER BY p.id LIMIT 256`,
    [q.afterId, q.sourceId, q.type, q.slugPrefix]);
}

/** The bytes of the source's withdrawal ledger as the export sizes it: each row's jsonb text plus a separator, plus the brackets. */
export async function readExportWithdrawalLedgerBytes(tx: Raw, sourceId: string): Promise<number> {
  const [size] = await tx.executeRaw<{ bytes: number }>(`SELECT COALESCE(sum(octet_length(
    jsonb_build_object('visibility',visibility,'fact_hash',fact_hash,'withdrawn_at',withdrawn_at,'subject',subject)::text)+1),0)+2 AS bytes
    FROM fact_withdrawals WHERE source_id=$1`, [sourceId]);
  return Number(size!.bytes);
}

/** One row of the export's withdrawal ledger: a withdrawal, or a purge tombstone (`purged`), which drops its fact row. */
export interface ExportWithdrawalRow { visibility: string; fact_hash: string; withdrawn_at: Date; subject: string; purged: boolean }

/** The source's withdrawals and purge tombstones, by visibility, fact hash and subject. */
export async function listExportWithdrawals(tx: Raw, sourceId: string): Promise<ExportWithdrawalRow[]> {
  return tx.executeRaw<ExportWithdrawalRow>(`SELECT visibility,fact_hash,withdrawn_at,subject,false AS purged
    FROM fact_withdrawals WHERE source_id=$1
    UNION ALL SELECT visibility,fact_hash,purged_at,subject,true FROM fact_purges WHERE source_id=$1
    ORDER BY visibility,fact_hash,subject`, [sourceId]);
}

/** A page the export writes, with its tags in tag order. */
export interface ExportPageRow { page: Page; tags: string[] }

/**
 * The live pages among `ids`, each with its tags, in no set order. Rows are looked up by primary key (#7618: a join on
 * the keys let the planner scan the whole source for each key, so a per-page export went quadratic).
 */
export async function readExportPageRows(tx: Raw, ids: readonly string[]): Promise<ExportPageRow[]> {
  const rows = await tx.executeRaw<Record<string, unknown>>(`WITH export_page AS MATERIALIZED (
    SELECT * FROM pages WHERE id = ANY($1::bigint[])
  ) SELECT p.*,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS export_tags
    FROM export_page p WHERE p.deleted_at IS NULL`,
  [ids]);
  return rows.map(row => ({ page: rowToPage(row), tags: row.export_tags as string[] }));
}
