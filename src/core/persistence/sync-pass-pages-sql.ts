/**
 * The text of a managed sync pass's `I⋈P` statement (engine-sql/sync-pass-pages.ts), byte for byte what sync-pass.ts
 * `readPages` sent before it became a member (test/engine-sql-caller-raw-sql-pins.test.ts):
 *  - `ids`: a confirm round's named page ids, `$5` the bigint array;
 *  - `keyset`: the next `limit` pages after page id `$5`;
 *  - `cursor`: the whole source, for Postgres's `DECLARE ... CURSOR`; its record subquery keeps `OFFSET 0`, so the hash
 *    join builds over the record's few text columns instead of the whole record. A window flattens it, so each row
 *    probes its record by primary key.
 * `$1` source id, `$2` the provenance op, `$3` the fingerprint prefix, `$4` the expected parser (jsonb), all bound by the
 * caller. Only module constants and a checked integer are spliced. It lives outside src/core/engine-sql/ because it
 * numbers its own placeholders, and is registered as a vetted builder in scripts/check-engine-sql-dynamic.ts.
 */
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { syncDeleteOrigin } from './sync-delete-tombstones.ts';

/**
 * The op of a page's sync import provenance record (`op_checkpoints`), re-exported by sync-holds.ts. It lives in this leaf
 * so engine-sql/sync-pass-pages.ts binds it without importing sync-holds.ts, whose graph reaches Bun-only assets that the
 * Postgres engine must not load under Node (test/openclaw-assemble-node-loadable.test.ts).
 */
export const SYNC_IMPORT_PROVENANCE_OP = 'sync-import-provenance';

export type SyncImportPagesShape = { shape: 'ids' } | { shape: 'keyset'; limit: number } | { shape: 'cursor' };

function select(offsetZero: boolean): string {
  return `SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision, p.deleted_at IS NOT NULL AS deleted,
      p.revision_write_request_id::text AS request_id, c.fingerprint IS NOT NULL AS has_record,
      c.origin IS NOT DISTINCT FROM p.source_path AS rec_origin_same,
      CASE WHEN c.origin IS DISTINCT FROM p.source_path THEN c.origin END AS rec_origin,
      c.blob_oid AS rec_blob_oid,
      c.disk_blob_oid IS NOT DISTINCT FROM c.blob_oid AS rec_disk_same,
      CASE WHEN c.disk_blob_oid IS DISTINCT FROM c.blob_oid THEN c.disk_blob_oid END AS rec_disk_blob_oid,
      c.revision IS NULL AS rec_revision_null,
      NULLIF(c.revision, p.knowledge_revision::text) AS rec_revision,
      CASE WHEN c.parser IS DISTINCT FROM $4::jsonb THEN c.parser::text END AS rec_parser, c.parser = $4::jsonb AS rec_parser_expected,
      c.full_episode AS rec_full_episode, c.working AS rec_working,
      (p.page_kind = 'markdown' AND p.chunker_version = ${MARKDOWN_CHUNKER_VERSION} AND p.body_storage IS DISTINCT FROM 'segmented'
        AND p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision AND p.contextual_retrieval_mode IS NOT NULL) AS derived_current,
      CASE WHEN p.deleted_at IS NOT NULL THEN ${syncDeleteOrigin('p')} ELSE false END AS sync_deleted
    FROM pages p LEFT JOIN (SELECT fingerprint, completed_keys->0->>'origin' AS origin, completed_keys->0->>'blob_oid' AS blob_oid,
        completed_keys->0->>'disk_blob_oid' AS disk_blob_oid, completed_keys->0->>'revision' AS revision,
        completed_keys->0->'parser' AS parser, completed_keys->0->>'full_episode' AS full_episode, (completed_keys->0->'working')::text AS working
      FROM op_checkpoints WHERE op=$2${offsetZero ? ' OFFSET 0' : ''}) c ON c.fingerprint=$3||p.id::text
    WHERE p.source_id=$1 AND p.source_path IS NOT NULL`;
}

export function syncImportPagesSql(shape: SyncImportPagesShape): string {
  if (shape.shape === 'cursor') return select(true);
  if (shape.shape === 'ids') return `${select(false)} AND p.id = ANY($5::bigint[]) ORDER BY p.id`;
  if (!Number.isSafeInteger(shape.limit) || shape.limit < 1) throw new Error(`syncImportPagesSql: limit must be a positive integer, got ${shape.limit}`);
  return `${select(false)} AND p.id>$5 ORDER BY p.id LIMIT ${shape.limit}`;
}
