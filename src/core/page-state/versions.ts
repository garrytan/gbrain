import type { BrainEngine } from '../engine.ts';
import type { PageVersion } from '../types.ts';
import type { PageSnapshot } from './types.ts';
import { PAGE_INLINE_MAX_BYTES, isLargePageBytes } from '../page-size-policy.ts';
import { LARGE_PAGE_VERSIONS_KEPT, readPageBodyPolicy } from '../page-body/limits.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';

export { LARGE_PAGE_VERSIONS_KEPT };

/**
 * Version the same canonical view an API reader receives, including withdrawals.
 * `preimage` (#5984) is the caller's own read of the page under its page guard
 * in this transaction; it is versioned as read, without a second read.
 */
export async function createPageVersion(engine: BrainEngine, slug: string, sourceId: string, preimage?: PageSnapshot): Promise<PageVersion> {
  const insert = async (tx: BrainEngine, snapshot: PageSnapshot) => {
    const { page, tags, revision } = snapshot;
    if (isSegmentedPage(page)) return insertSegmentedVersion(tx, snapshot);
    const rows = await tx.executeRaw<PageVersion>(`INSERT INTO page_versions
      (page_id,compiled_truth,frontmatter,knowledge_revision,timeline,title,type,tags,is_deleted,source_path)
      VALUES ($1,$2,$3::text::jsonb,$4::uuid,$5,$6,$7,$8::text::jsonb,$9,$10) RETURNING *`,
    [page.id, page.compiled_truth, JSON.stringify(page.frontmatter), revision, page.timeline, page.title, page.type, JSON.stringify(tags), page.deleted_at != null, page.source_path ?? null]);
    if (isLargePageBytes(Buffer.byteLength(page.compiled_truth ?? '', 'utf-8') + Buffer.byteLength(page.timeline ?? '', 'utf-8'))) {
      await tx.executeRaw(`DELETE FROM page_versions WHERE page_id = $1 AND id IN (SELECT id FROM page_versions WHERE page_id = $1
        AND octet_length(compiled_truth) + octet_length(COALESCE(timeline, '')) > $2 ORDER BY id DESC OFFSET $3)`,
      [page.id, PAGE_INLINE_MAX_BYTES, LARGE_PAGE_VERSIONS_KEPT]);
    }
    return { ...rows[0], snapshot_at: new Date(rows[0].snapshot_at) };
  };
  if (preimage) return insert(engine, preimage);
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const snapshot = await tx.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    if (!snapshot) throw new Error(`createVersion failed: page "${slug}" (source=${sourceId}) not found`);
    return insert(tx, snapshot);
  });
}

/**
 * Wave B (spec 5): a segmented page's version is a reference, not a copy: the
 * page's live body generation (its manifest rows stay alive as a GC root),
 * body_bytes and content_hash; its body columns stay NULL. O(1) at any page size.
 * It references the generation live when it is inserted, so a caller versions
 * before its generation flip, as every caller versions before its page write.
 * Then the page's segmented history is pruned by `pruneSegmentedVersions`.
 */
async function insertSegmentedVersion(tx: BrainEngine, snapshot: PageSnapshot): Promise<PageVersion> {
  const { page, tags, revision } = snapshot;
  const [row] = await tx.executeRaw<PageVersion>(`INSERT INTO page_versions
    (page_id,body_storage,body_generation,body_bytes,content_hash,frontmatter,knowledge_revision,title,type,tags,is_deleted,source_path)
    SELECT p.id,'segmented',p.body_generation,p.body_bytes,p.content_hash,$2::text::jsonb,$3::uuid,$4,$5,$6::text::jsonb,$7,$8
      FROM pages p WHERE p.id = $1 AND p.body_storage = 'segmented' RETURNING *`,
  [page.id, JSON.stringify(page.frontmatter), revision, page.title, page.type, JSON.stringify(tags), page.deleted_at != null, page.source_path ?? null]);
  if (!row) throw new Error(`createVersion failed: page id ${page.id} is no longer segmented`);
  if ((await pruneSegmentedVersions(tx, page.id)) > 0) await tx.sweepSegments({ pageId: page.id });
  return { ...row, snapshot_at: new Date(row.snapshot_at) };
}

/**
 * Segmented retention (spec 5): keep the newest `versions.segmented_max_per_page`
 * segmented versions of the page, and prune oldest-first while the bytes they
 * pin beyond the live generation exceed
 * max(`versions.segmented_max_pinned_bytes`, the page's body_bytes). The pinned
 * bytes are those of distinct texts (source_id, sha256) of closed manifest rows a
 * kept version's generation references, less the texts the live generation
 * holds (a moved row's text is stored once). Versions reference generations in
 * id order, so a closed row is pinned by the newest kept generation below its
 * gen_to (when that is at or above its gen_from): the rows closed after the
 * oldest kept generation (page_body_manifest_closed) and the live rows are
 * sorted once with the kept generations and grouped by text, never joined to
 * the versions or to each other, so the work does not depend on statistics. A text's bytes count from
 * the newest version that pins it, so the pinned bytes of the newest k versions
 * are a running sum and the kept set is a prefix. Inline snapshots of the page
 * are never touched here. Returns the versions deleted.
 */
export async function pruneSegmentedVersions(tx: BrainEngine, pageId: number): Promise<number> {
  const policy = await readPageBodyPolicy(tx);
  const deleted = await tx.executeRaw(`WITH v AS (
      SELECT id, body_generation AS g, row_number() OVER (ORDER BY id DESC) AS rk
        FROM page_versions WHERE page_id = $1 AND body_storage = 'segmented'),
    pinned AS (
      SELECT min(e.pin_rk) FILTER (WHERE e.kind = 0 AND e.gen_from <= e.pin_g) AS rk, max(e.byte_len) AS byte_len
        FROM (SELECT e.*, max(e.version_g) OVER w AS pin_g, min(e.version_rk) OVER w AS pin_rk
                FROM (SELECT g AS at, 1 AS kind, g AS version_g, min(rk) AS version_rk, NULL::bigint AS gen_from, NULL::text AS source_id, NULL::bytea AS sha256, NULL::int AS byte_len
                        FROM v GROUP BY g
                      UNION ALL
                      SELECT m.gen_to, 0, NULL, NULL, m.gen_from, m.source_id, m.sha256, m.byte_len FROM page_body_manifest m
                       WHERE m.page_id = $1 AND m.gen_to > (SELECT min(g) FROM v) AND m.staging_id IS NULL
                      UNION ALL
                      SELECT NULL, 2, NULL, NULL, NULL, m.source_id, m.sha256, 0 FROM page_body_manifest m
                       WHERE m.page_id = $1 AND m.gen_to IS NULL AND m.staging_id IS NULL) e
              WINDOW w AS (ORDER BY e.at, e.kind ROWS UNBOUNDED PRECEDING)) e
       WHERE e.kind <> 1
       GROUP BY e.source_id, e.sha256
      HAVING NOT bool_or(e.kind = 2)),
    per_rank AS (SELECT rk, sum(byte_len) AS bytes FROM pinned GROUP BY rk),
    kept AS (
      SELECT v.id, v.rk, sum(COALESCE(per_rank.bytes, 0)) OVER (ORDER BY v.rk) AS bytes
        FROM v LEFT JOIN per_rank ON per_rank.rk = v.rk),
    cap AS (SELECT GREATEST($3::bigint, COALESCE(body_bytes, 0)) AS bytes FROM pages WHERE id = $1)
    DELETE FROM page_versions WHERE id IN (SELECT kept.id FROM kept, cap WHERE kept.rk > $2 OR kept.bytes > cap.bytes)
    RETURNING id`, [pageId, policy.versionsMaxPerPage, policy.versionsMaxPinnedBytes]);
  return deleted.length;
}

/**
 * `revert_version` of a segmented page or version is not available until the
 * segment writer (Wave B PR 3): the version's body lives in segments, and the
 * revert path rebuilds the page from an inline body. Refused before anything is written.
 */
export function segmentedRevertRefusal(slug: string, versionId: unknown): OperationError {
  return opError('page_body_segmented',
    `Page ${slug} or its version ${String(versionId)} is stored in segments, so revert_version cannot restore it yet; nothing was changed.`,
    `Read the version with get_versions (body_bytes, content_hash), then write the content you want with put_page or edit_page.`,
    { reason: 'segmented_revert' });
}
