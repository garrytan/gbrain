/**
 * The statements gbrain export runs (src/commands/export.ts, src/core/export-snapshot.ts), one function per
 * BrainEngine member. PGLite and Postgres run the same text the export ran through executeRaw before; the Rust engine
 * answers from its store (rust/docs/store/cli-reads-export.md). Each runs on the engine it is given, so a call on a
 * transaction engine reads inside that transaction.
 */
import type { BrainEngine } from '../engine.ts';

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
